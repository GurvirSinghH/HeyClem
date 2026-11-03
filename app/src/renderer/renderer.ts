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
let lastPhase = "";
let micLive = false;

/** While the mic is still opening, nothing is being recorded, so the pill says so. */
function showMicStatus(phase: PillState["phase"]): void {
  if (phase !== "listening") {
    label.textContent = LABELS[phase];
    note.textContent = "";
  } else {
    label.textContent = micLive ? LABELS.listening : "Mic starting";
    note.textContent = micLive ? "release to send" : "wait a moment";
  }
}

console.info("ready");

clem.onState((s) => {
  if (s.phase !== lastPhase || s.message) console.info(`state ${s.phase}${s.message ? `: ${s.message}` : ""}`);
  lastPhase = s.phase;
  pill.dataset.phase = s.phase;
  showMicStatus(s.phase);
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
  const t0 = performance.now();
  const wasOpen = Boolean(stream?.getAudioTracks().some((t) => t.readyState === "live"));
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
  micLive = true;
  showMicStatus("listening");
  console.info(`mic live ${Math.round(performance.now() - t0)} ms after the keys (${wasOpen ? "already open" : "had to open"})`);
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
  micLive = false;
  const stop = () => {
    if (recorder && recorder.state !== "inactive") recorder.stop();
    recorder = null;
  };
  if (starting) void starting.then(stop);
  else if (recorder) stop();
  else clem.micEnded();
});

// ---------- speaker ----------

// Speech arrives as raw 16-bit, 24 kHz PCM, chunk by chunk. Each chunk is scheduled right after the last.
const SAMPLE_RATE = 24_000;
const START_LEAD_S = 0.05;
const audio = new AudioContext({ latencyHint: "interactive" });
const playing = new Set<AudioBufferSourceNode>();
let nextStart = 0;
let playingTurn = 0;
let endedTurn: number | null = null;

function maybeDrained(): void {
  if (playing.size === 0 && endedTurn === playingTurn) {
    endedTurn = null;
    clem.audioDrained(playingTurn);
  }
}

function stopAll(): void {
  for (const src of playing) {
    src.onended = null;
    try {
      src.stop();
    } catch {
      /* already stopped */
    }
  }
  playing.clear();
  nextStart = 0;
}

clem.onAudioPlay((clip: AudioClip) => {
  if (clip.turnId !== playingTurn) {
    stopAll();
    playingTurn = clip.turnId;
  }
  const samples = Math.floor(clip.bytes.byteLength / 2);
  if (samples === 0) return;
  if (audio.state === "suspended") void audio.resume();

  const view = new DataView(clip.bytes.buffer, clip.bytes.byteOffset, samples * 2);
  const buffer = audio.createBuffer(1, samples, SAMPLE_RATE);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < samples; i++) channel[i] = view.getInt16(i * 2, true) / 32768;

  const src = audio.createBufferSource();
  src.buffer = buffer;
  src.connect(audio.destination);
  src.onended = () => {
    playing.delete(src);
    maybeDrained();
  };
  const at = Math.max(nextStart, audio.currentTime + START_LEAD_S);
  src.start(at);
  nextStart = at + buffer.duration;
  playing.add(src);
});

clem.onAudioEnd((turnId) => {
  if (turnId !== playingTurn) {
    // Nothing was played for this turn (empty answer): report drained straight away.
    clem.audioDrained(turnId);
    return;
  }
  endedTurn = turnId;
  maybeDrained();
});

clem.onAudioFlush(() => {
  stopAll();
  endedTurn = null;
});
