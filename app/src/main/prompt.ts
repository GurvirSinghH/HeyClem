import type { Screenshot } from "./screenshot";

// What every brain shares: the instructions, how a turn is described, and short text memory.

export const SYSTEM_PROMPT = `You are Clem, a voice assistant on the user's Windows desktop. Each turn you get a screenshot of the display they are looking at, where their mouse pointer is, and what they just said out loud. Your reply is turned into speech.

Latency-sensitive; begin your visible answer immediately.

Speak the way a helpful person sitting next to them would: one to three short sentences unless they ask for more. Everything you write is read aloud, so use no markdown, lists, code blocks, URLs or emoji.

Ground the answer in what is on screen. Name buttons, menus and messages by their visible labels and say where they are ("the blue Export button, top right"). When they say "this" or "here", they usually mean what is near the mouse pointer. For an error, say what it means in plain words and the most likely fix. If the screenshot doesn't show enough to answer, say what you can see and what you'd need.

The question comes from speech-to-text, so if a word looks wrong, go with the most plausible reading.`;

export function describeTurn(question: string, shot: Screenshot | null): string {
  const context = shot
    ? `Screenshot of ${shot.displayLabel}, ${shot.width}x${shot.height} px. ${
        shot.cursor ? `Mouse pointer at x=${shot.cursor.x}, y=${shot.cursor.y}.` : "Mouse pointer is on another display."
      }`
    : "No screenshot this turn (screen capture failed).";
  return `${context}\n\nThey said: "${question}"`;
}

export interface BrainResult {
  text: string;
  refused: boolean;
}

export interface BrainLike {
  answer(
    question: string,
    shot: Screenshot | null,
    onText: (delta: string) => void,
    signal: AbortSignal,
  ): Promise<BrainResult>;
}

export interface TextTurn {
  role: "user" | "assistant";
  content: string;
}

/** Keep the last few exchanges so follow-ups like "and how do I undo that?" work. */
const MAX_HISTORY_MESSAGES = 6;
const HISTORY_IDLE_RESET_MS = 10 * 60_000;

/** Earlier turns keep only what was said; old screenshots are dropped. */
export class TextHistory {
  private turns: TextTurn[] = [];
  private lastTurnAt = 0;

  recent(): TextTurn[] {
    if (Date.now() - this.lastTurnAt > HISTORY_IDLE_RESET_MS) this.turns = [];
    return [...this.turns];
  }

  add(question: string, answer: string): void {
    this.turns.push({ role: "user", content: question }, { role: "assistant", content: answer });
    this.turns = this.turns.slice(-MAX_HISTORY_MESSAGES);
    this.lastTurnAt = Date.now();
  }
}
