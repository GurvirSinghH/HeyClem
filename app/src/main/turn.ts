import Anthropic from "@anthropic-ai/sdk";
import type { PillState } from "../shared/ipc";
import type { ClemConfig } from "./config";
import type { BrainLike } from "./prompt";
import { log, warn } from "./log";
import { captureActiveDisplay, type Screenshot } from "./screenshot";
import { SentenceSplitter, Speaker } from "./speech";
import { LiveTranscription, SttError } from "./stt";
import { WorkerError, type WorkerClient } from "./worker";

/** What the controller needs from the pill window. */
export interface PillUi {
  state(s: PillState): void;
  micStart(): void;
  micStop(): void;
  audioPlay(turnId: number, seq: number, pcm: Buffer): void;
  audioEnd(turnId: number): void;
  audioFlush(): void;
}

type TurnPhase = "listening" | "transcribing" | "thinking" | "speaking" | "done";

interface Turn {
  id: number;
  phase: TurnPhase;
  abort: AbortController;
  pressedAt: number;
  releasedAt: number;
  stt: LiveTranscription;
  shot: Promise<Screenshot | null>;
  micEnded: Promise<void>;
  resolveMicEnded: () => void;
  speaker: Speaker | null;
  question: string;
  answer: string;
}

/**
 * Runs one spoken question at a time:
 *   hold   -> mic + screenshot + Deepgram socket in parallel
 *   release-> finalize transcript -> Claude (streamed) -> sentence-by-sentence speech
 * Pressing again while Clem is talking interrupts it (barge-in).
 */
export class TurnController {
  private nextId = 1;
  private turn: Turn | null = null;

  constructor(
    private readonly cfg: ClemConfig,
    private readonly worker: WorkerClient,
    private readonly brain: BrainLike,
    private readonly ui: PillUi,
  ) {}

  begin(): void {
    if (this.turn?.phase === "listening") return;
    if (this.turn && this.turn.phase !== "done") this.interrupt(this.turn);

    const id = this.nextId++;
    let resolveMicEnded = () => {};
    const micEnded = new Promise<void>((r) => (resolveMicEnded = r));
    const turn: Turn = {
      id,
      phase: "listening",
      abort: new AbortController(),
      pressedAt: performance.now(),
      releasedAt: 0,
      stt: new LiveTranscription(this.cfg.workerUrl, this.cfg.appToken, this.cfg.sttLanguage, (text) => {
        if (this.turn === turn && turn.phase === "listening") this.ui.state({ phase: "listening", transcript: text });
      }),
      shot: captureActiveDisplay().catch((err: Error) => {
        warn("screen", "capture failed:", err.message);
        return null;
      }),
      micEnded,
      resolveMicEnded,
      speaker: null,
      question: "",
      answer: "",
    };
    this.turn = turn;
    this.ui.audioFlush();
    this.ui.state({ phase: "listening", transcript: "" });
    this.ui.micStart();
    log("turn", `#${id} listening`);
  }

  end(): void {
    const turn = this.turn;
    if (!turn || turn.phase !== "listening") return;
    turn.phase = "transcribing";
    turn.releasedAt = performance.now();
    this.ui.micStop();
    void this.finish(turn);
  }

  /** The hotkey turned out to be part of another shortcut: drop this turn silently. */
  cancel(): void {
    const turn = this.turn;
    if (!turn || turn.phase !== "listening") return;
    this.ui.micStop();
    this.interrupt(turn);
    this.ui.state({ phase: "idle" });
    log("turn", `#${turn.id} cancelled (another key joined the chord)`);
  }

  onMicChunk(chunk: Buffer): void {
    const turn = this.turn;
    if (!turn || (turn.phase !== "listening" && turn.phase !== "transcribing")) return;
    turn.stt.send(chunk);
  }

  onMicEnded(): void {
    this.turn?.resolveMicEnded();
  }

  onMicError(message: string): void {
    const turn = this.turn;
    if (!turn || turn.phase === "done") return;
    this.interrupt(turn);
    this.ui.state({
      phase: "error",
      message: `Can't use the microphone (${message}). Check Windows Settings → Privacy → Microphone.`,
    });
  }

  onAudioDrained(turnId: number): void {
    const turn = this.turn;
    if (!turn || turn.id !== turnId || turn.phase !== "speaking") return;
    turn.phase = "done";
    this.ui.state({ phase: "idle", transcript: turn.question, answer: turn.answer });
  }

  private async finish(turn: Turn): Promise<void> {
    const ms = (t: number) => `${Math.round(t - turn.releasedAt)} ms`;
    try {
      await Promise.race([turn.micEnded, delay(1200)]);
      const question = await turn.stt.finish();
      if (this.turn !== turn) return;
      const tStt = performance.now();
      turn.question = question;

      if (!question) {
        turn.phase = "done";
        log("turn", `#${turn.id} heard nothing | held ${Math.round(turn.releasedAt - turn.pressedAt)} ms | transcript wait ${ms(tStt)}`);
        this.ui.state({ phase: "idle", message: "I didn't catch that. Hold Ctrl+Alt while you talk." });
        return;
      }

      turn.phase = "thinking";
      this.ui.state({ phase: "thinking", transcript: question });
      const shot = await turn.shot;

      let tFirstText = 0;
      let tFirstAudio = 0;
      const speaker = new Speaker(this.worker, (seq, pcm) => {
        if (this.turn !== turn) return;
        if (!tFirstAudio) {
          tFirstAudio = performance.now();
          turn.phase = "speaking";
          this.ui.state({ phase: "speaking", transcript: question, answer: turn.answer });
        }
        this.ui.audioPlay(turn.id, seq, pcm);
      });
      turn.speaker = speaker;

      const splitter = new SentenceSplitter();
      const result = await this.brain.answer(
        question,
        shot,
        (delta) => {
          if (this.turn !== turn) return;
          if (!tFirstText) tFirstText = performance.now();
          turn.answer += delta;
          this.ui.state({ phase: turn.phase === "speaking" ? "speaking" : "thinking", transcript: question, answer: turn.answer });
          for (const sentence of splitter.push(delta)) speaker.say(sentence);
        },
        turn.abort.signal,
      );
      for (const sentence of splitter.flush()) speaker.say(sentence);
      if (result.refused) {
        turn.answer = "I can't help with that one.";
        speaker.say(turn.answer);
      }

      await speaker.finished();
      if (this.turn !== turn) return;

      log(
        "turn",
        `#${turn.id} done | held ${Math.round(turn.releasedAt - turn.pressedAt)} ms | transcript ${ms(tStt)} | first word ${tFirstText ? ms(tFirstText) : "-"} | first audio ${
          tFirstAudio ? ms(tFirstAudio) : "-"
        } (from key release) | screenshot ${shot ? `${shot.ms} ms, ${Math.round((shot.jpegBase64.length * 0.75) / 1024)} KB` : "failed"}`,
      );

      if (speaker.sentCount > 0 && speaker.failedCount === speaker.sentCount) {
        turn.phase = "done";
        this.ui.state({ phase: "error", transcript: question, answer: turn.answer, message: "Couldn't play the spoken answer (text-to-speech failed)." });
        return;
      }
      turn.phase = "speaking";
      this.ui.audioEnd(turn.id); // renderer replies with audioDrained once playback ends
    } catch (err) {
      if (turn.abort.signal.aborted || this.turn !== turn) return;
      turn.phase = "done";
      warn("turn", `#${turn.id} failed:`, err);
      this.ui.state({ phase: "error", transcript: turn.question || undefined, message: friendly(err, this.cfg) });
    }
  }

  private interrupt(turn: Turn): void {
    turn.abort.abort();
    turn.stt.abort();
    turn.speaker?.abort();
    turn.phase = "done";
    this.ui.audioFlush();
  }
}

function friendly(err: unknown, cfg: ClemConfig): string {
  if (err instanceof WorkerError || err instanceof SttError) return err.message;
  if (err instanceof Anthropic.AuthenticationError) {
    return "Authentication failed: check CLEM_APP_TOKEN (app and worker) and ANTHROPIC_API_KEY (worker).";
  }
  if (err instanceof Anthropic.RateLimitError) return "Claude is rate-limiting requests. Try again in a moment.";
  if (err instanceof Anthropic.APIConnectionError) {
    return `Can't reach the worker at ${cfg.workerUrl}. See worker.log (tray menu, Open logs).`;
  }
  if (err instanceof Anthropic.APIError) return `Claude error ${err.status ?? ""}: ${err.message}`.trim();
  return err instanceof Error ? err.message : String(err);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
