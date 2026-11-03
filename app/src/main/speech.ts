import type { WorkerClient } from "./worker";
import { warn } from "./log";

/**
 * Cuts streamed text into sentences so the first one can be spoken while Claude is still writing.
 */
// A sentence ends at . ! ? or … (plus closing quotes/brackets) followed by whitespace, or at a newline.
const BOUNDARY = /([.!?…]["')\]]*)\s+|\n+/g;
// Periods that don't end a sentence.
const ABBREVIATION = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|approx|mr|mrs|ms|dr|st|no|fig)\.$/i;

export class SentenceSplitter {
  private buf = "";

  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
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
        const sentence = this.buf.slice(0, end).trim();
        this.buf = this.buf.slice(end);
        from = 0;
        if (sentence) out.push(sentence);
        continue;
      }
      // A very long run with no full stop: break at the last comma or space so speech isn't held back.
      if (this.buf.length > 220) {
        const cut = Math.max(this.buf.lastIndexOf(", ", 200), this.buf.lastIndexOf(" ", 200));
        if (cut > 40) {
          out.push(this.buf.slice(0, cut + 1).trim());
          this.buf = this.buf.slice(cut + 1);
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
 * Fetches speech for each sentence as soon as it arrives (in parallel) but hands the audio
 * to the speaker strictly in order.
 */
export class Speaker {
  private tail: Promise<void> = Promise.resolve();
  private seq = 0;
  private readonly controller = new AbortController();
  private failures = 0;

  constructor(
    private readonly worker: WorkerClient,
    private readonly deliver: (seq: number, mp3: Buffer) => void,
  ) {}

  say(sentence: string): void {
    const text = cleanForSpeech(sentence);
    if (!text || this.controller.signal.aborted) return;
    const seq = this.seq++;
    const audio = this.worker.speak(text, this.controller.signal);
    audio.catch(() => {}); // handled below, in order; this only prevents an early unhandled-rejection warning
    this.tail = this.tail
      .then(async () => {
        const mp3 = await audio;
        if (!this.controller.signal.aborted) this.deliver(seq, mp3);
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
