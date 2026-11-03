// IPC contract between the main process and the pill window (which also owns the mic and speaker).

export type Phase = "idle" | "listening" | "thinking" | "speaking" | "error";

export interface PillState {
  phase: Phase;
  /** What the user said (live while listening). */
  transcript?: string;
  /** Clem's answer, streamed as it is written. */
  answer?: string;
  /** A one-line status or problem description. */
  message?: string;
}

export interface AudioClip {
  turnId: number;
  seq: number;
  bytes: Uint8Array;
}

export const IPC = {
  state: "clem:state",
  micStart: "clem:mic-start",
  micStop: "clem:mic-stop",
  micChunk: "clem:mic-chunk",
  micEnded: "clem:mic-ended",
  micError: "clem:mic-error",
  audioPlay: "clem:audio-play",
  audioEnd: "clem:audio-end",
  audioFlush: "clem:audio-flush",
  audioDrained: "clem:audio-drained",
} as const;

/** What the preload script exposes to the renderer as `window.clem`. */
export interface ClemBridge {
  onState(cb: (state: PillState) => void): void;
  onMicStart(cb: () => void): void;
  onMicStop(cb: () => void): void;
  sendMicChunk(chunk: Uint8Array): void;
  micEnded(): void;
  micError(message: string): void;
  onAudioPlay(cb: (clip: AudioClip) => void): void;
  onAudioEnd(cb: (turnId: number) => void): void;
  onAudioFlush(cb: () => void): void;
  audioDrained(turnId: number): void;
}
