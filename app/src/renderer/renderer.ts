import type { AudioClip, ClemBridge, PillState } from "../shared/ipc";

declare global {
  interface Window {
    clem: ClemBridge;
  }
}

const clem = window.clem;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const pill = $<HTMLElement>("pill");
const label = $<HTMLElement>("label");
const note = $<HTMLElement>("note");
const you = $<HTMLElement>("you");
const answer = $<HTMLElement>("answer");

// ---------- pill ----------

const LABELS: Record<PillState["phase"], string> = {
  idle: "Clem",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Clem",
  error: "Problem",
};
const LINGER_MS = { idle: 8000, error: 12000 };
let hideTimer: number | undefined;

console.info("ready");

clem.onState((s) => {
  console.info(`state ${s.phase}${s.message ? `: ${s.message}` : ""}`);
  pill.dataset.phase = s.phase;
  label.textContent = LABELS[s.phase];
  note.textContent = s.phase === "listening" ? "release to send" : "";
  you.textContent = s.transcript ? `You: ${s.transcript}` : s.phase === "listening" ? "…" : "";
  answer.textContent = s.answer ?? s.message ?? "";

  window.clearTimeout(hideTimer);
  const visible = s.phase !== "idle" || Boolean(s.answer || s.message);
  pill.classList.toggle("gone", !visible);
  if (s.phase === "idle" || s.phase === "error") {
    hideTimer = window.setTimeout(() => pill.classList.add("gone"), LINGER_MS[s.phase]);
  }
});

// ---------- microphone ----------

let stream: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let starting: Promise<void> | null = null;
let wantRecording = false;
let releaseTimer: number | undefined;

async function ensureStream(): Promise<MediaStream> {
  if (stream?.getAudioTracks().some((t) => t.readyState === "live")) return stream;
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  return stream;
}

/** Close the mic a minute after the last question, so Windows' mic indicator doesn't stay on. */
function scheduleRelease(): void {
  window.clearTimeout(releaseTimer);
  releaseTimer = window.setTimeout(() => {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  }, 60_000);
}

async function startRecording(): Promise<void> {
  const s = await ensureStream();
  if (!wantRecording) {
    clem.micEnded();
    scheduleRelease();
    return;
  }
  const rec = new MediaRecorder(s, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 32_000 });
  let chain = Promise.resolve();
  rec.ondataavailable = (e) => {
    if (e.data.size === 0) return;
    // Keep chunks in order: arrayBuffer() is async.
    chain = chain.then(async () => clem.sendMicChunk(new Uint8Array(await e.data.arrayBuffer())));
  };
  rec.onstop = () => {
    void chain.then(() => clem.micEnded());
    scheduleRelease();
  };
  rec.start(100); // a chunk every 100 ms keeps transcription live
  recorder = rec;
}

clem.onMicStart(() => {
  window.clearTimeout(releaseTimer);
  wantRecording = true;
  starting = startRecording()
    .catch((err: unknown) => {
      wantRecording = false;
      clem.micError(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    })
    .finally(() => (starting = null));
});

clem.onMicStop(() => {
  wantRecording = false;
  const stop = () => {
    if (recorder && recorder.state !== "inactive") recorder.stop();
    recorder = null;
  };
  if (starting) void starting.then(stop);
  else if (recorder) stop();
  else clem.micEnded();
});

// ---------- speaker ----------

const audio = new AudioContext();
let queue: AudioClip[] = [];
let current: AudioBufferSourceNode | null = null;
let busy = false;
let generation = 0; // bumped on flush so in-flight decodes are dropped
let playingTurn = 0;
let endedTurn: number | null = null;

function maybeDrained(): void {
  if (!busy && queue.length === 0 && endedTurn === playingTurn) {
    endedTurn = null;
    clem.audioDrained(playingTurn);
  }
}

async function pump(): Promise<void> {
  if (busy) return;
  const clip = queue.shift();
  if (!clip) return maybeDrained();
  busy = true;
  const gen = generation;
  try {
    if (audio.state === "suspended") await audio.resume();
    const bytes = clip.bytes;
    const decoded = await audio.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    if (gen !== generation) return;
    const src = audio.createBufferSource();
    src.buffer = decoded;
    src.connect(audio.destination);
    src.onended = () => {
      if (current === src) current = null;
      if (gen !== generation) return;
      busy = false;
      void pump();
    };
    current = src;
    src.start();
    return;
  } catch (err) {
    console.error("audio clip failed", err);
  }
  if (gen === generation) {
    busy = false;
    void pump();
  }
}

clem.onAudioPlay((clip) => {
  if (clip.turnId !== playingTurn) {
    playingTurn = clip.turnId;
    queue = [];
  }
  queue.push(clip);
  void pump();
});

clem.onAudioEnd((turnId) => {
  if (turnId !== playingTurn) {
    // Nothing was played for this turn (empty answer): report drained straight away.
    if (queue.length === 0 && !busy) clem.audioDrained(turnId);
    return;
  }
  endedTurn = turnId;
  maybeDrained();
});

clem.onAudioFlush(() => {
  generation++;
  queue = [];
  endedTurn = null;
  busy = false;
  try {
    current?.stop();
  } catch {
    /* already stopped */
  }
  current = null;
});
