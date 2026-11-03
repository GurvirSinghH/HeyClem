import type { WorkerClient } from "./worker";
import { warn } from "./log";

// A sentence ends at . ! ? or … (plus closing quotes/brackets) followed by whitespace, or at a newline.
const BOUNDARY = /([.!?…]["')\]]*)\s+|\n+/g;
// Periods that don't end a sentence.
const ABBREVIATION = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|approx|mr|mrs|ms|dr|st|no|fig)\.$/i;
// The opening clause can be spoken without waiting for the full stop, once it's long enough to sound natural.
const CLAUSE_BREAK = /[,;:]\s/g;
const MIN_OPENING_CLAUSE = 25;

/**
 * Cuts streamed text into pieces so the opening can be spoken while the model is still writing.
 */
export class SentenceSplitter {
  private buf = "";
  private started = false;

  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    const emit = (end: number) => {
      const piece = this.buf.slice(0, end).trim();
      this.buf = this.buf.slice(end);
      this.started = true;
      if (piece) out.push(piece);
    };

    let from = 0;
    for (;;) {
      BOUNDARY.lastIndex = from;
      const m = BOUNDARY.exec(this.buf);
      if (m) {
        const end = m.index + m[0].length;
        if (m[1]?.startsWith(".") && ABBREVIATION.test(this.buf.slice(0, m.index + 1))) {
          from = end;
          continue;
        }
        emit(end);
        from = 0;
        continue;
      }
      if (!this.started) {
        CLAUSE_BREAK.lastIndex = MIN_OPENING_CLAUSE;
        const clause = CLAUSE_BREAK.exec(this.buf);
        if (clause) {
          emit(clause.index + clause[0].length);
          from = 0;
          continue;
        }
      }
      // A very long run with no full stop: break at the last comma or space so speech isn't held back.
      if (this.buf.length > 220) {
        const cut = Math.max(this.buf.lastIndexOf(", ", 200), this.buf.lastIndexOf(" ", 200));
        if (cut > 40) {
          emit(cut + 1);
          from = 0;
          continue;
        }
      }
      break;
    }
    return out;
  }

  flush(): string[] {
    const rest = this.buf.trim();
    this.buf = "";
    return rest ? [rest] : [];
  }
}

/** Removes formatting that would be read aloud literally. */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, "the link")
    .replace(/`{1,3}/g, "")
    .replace(/[*_#>]+/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Starts speech for each piece as soon as it arrives (in parallel), and hands the audio to the
 * speaker strictly in order, chunk by chunk, so playback starts on the first bytes.
 */
export class Speaker {
  private tail: Promise<void> = Promise.resolve();
  private seq = 0;
  private readonly controller = new AbortController();
  private failures = 0;

  constructor(
    private readonly worker: WorkerClient,
    /** Receives raw 16-bit PCM, always a whole number of samples. */
    private readonly deliver: (seq: number, pcm: Buffer) => void,
  ) {}

  say(sentence: string): void {
    const text = cleanForSpeech(sentence);
    if (!text || this.controller.signal.aborted) return;
    const seq = this.seq++;
    const audio = this.worker.speakStream(text, this.controller.signal);
    audio.catch(() => {}); // handled below, in order; this only prevents an early unhandled-rejection warning
    this.tail = this.tail
      .then(async () => {
        const reader = (await audio).getReader();
        let odd: Buffer | null = null; // a chunk can end halfway through a 16-bit sample
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          if (this.controller.signal.aborted) return;
          const joined: Buffer = odd ? Buffer.concat([odd, value]) : Buffer.from(value);
          const whole = joined.length - (joined.length % 2);
          if (whole > 0) this.deliver(seq, joined.subarray(0, whole));
          odd = whole < joined.length ? joined.subarray(whole) : null;
        }
      })
      .catch((err: Error) => {
        if (err.name === "AbortError") return;
        this.failures++;
        warn("tts", `sentence ${seq} failed:`, err.message);
      });
  }

  get failedCount(): number {
    return this.failures;
  }

  get sentCount(): number {
    return this.seq;
  }

  /** Resolves once every queued sentence has been delivered (or failed). */
  finished(): Promise<void> {
    return this.tail;
  }

  abort(): void {
    this.controller.abort();
  }
}
