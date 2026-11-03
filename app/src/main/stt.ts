import WebSocket from "ws";
import { log, warn } from "./log";

interface DeepgramResults {
  type: "Results";
  is_final?: boolean;
  channel?: { alternatives?: { transcript?: string }[] };
}

export class SttError extends Error {}

/**
 * One live-transcription socket per push-to-talk hold, relayed by the worker, which holds the Deepgram key.
 * Audio is the WebM/Opus stream from the renderer's MediaRecorder; Deepgram reads
 * the container header, so no encoding or sample_rate parameters are sent.
 */
export class LiveTranscription {
  private readonly ws: WebSocket;
  private readonly queue: Buffer[] = [];
  private readonly finals: string[] = [];
  private interim = "";
  private open = false;
  private closed = false;
  private failure: SttError | null = null;
  private readonly opened: Promise<void>;
  private closeSeen: (() => void) | null = null;

  constructor(workerUrl: string, appToken: string, language: string, private readonly onUpdate: (text: string) => void) {
    const params = new URLSearchParams({
      model: "nova-3",
      language,
      smart_format: "true",
      punctuate: "true",
      interim_results: "true",
    });
    this.ws = new WebSocket(`${workerUrl.replace(/^http/, "ws")}/v1/listen?${params}`, {
      headers: { Authorization: `Bearer ${appToken}` },
    });

    this.opened = new Promise<void>((resolve) => {
      this.ws.once("open", () => {
        this.open = true;
        for (const chunk of this.queue.splice(0)) this.ws.send(chunk);
        resolve();
      });
      this.ws.once("close", () => resolve());
    });

    this.ws.on("unexpected-response", (_req, res) => {
      this.failure =
        res.statusCode === 401
          ? new SttError("The worker rejected the app token. CLEM_APP_TOKEN must match in app/.env and worker/.dev.vars.")
          : new SttError(`Deepgram refused the connection (HTTP ${res.statusCode}). Check DEEPGRAM_API_KEY in worker/.dev.vars.`);
      this.ws.terminate();
    });
    this.ws.on("error", (err) => {
      this.failure ??= new SttError(`Can't reach speech-to-text through the worker at ${workerUrl}: ${err.message}`);
    });
    this.ws.on("close", () => {
      this.closed = true;
      this.closeSeen?.();
    });
    this.ws.on("message", (data) => this.handle(data.toString()));
  }

  get text(): string {
    return [...this.finals, this.interim].join(" ").replace(/\s+/g, " ").trim();
  }

  send(chunk: Buffer): void {
    if (this.closed) return;
    if (this.open) this.ws.send(chunk);
    else this.queue.push(chunk);
  }

  /** Close the stream and return the transcript. */
  async finish(timeoutMs = 3000): Promise<string> {
    // A cold connection can take a couple of seconds; audio queues until it opens.
    await withTimeout(this.opened, 3000);
    if (this.failure) throw this.failure;
    if (!this.open) throw new SttError("Speech-to-text didn't connect in time.");
    if (this.closed) return this.text;

    // CloseStream makes Deepgram transcribe everything it still holds, send the results, then close.
    const closed = new Promise<void>((resolve) => (this.closeSeen = resolve));
    this.ws.send(JSON.stringify({ type: "CloseStream" }));
    await withTimeout(closed, timeoutMs);
    if (!this.closed) this.ws.terminate();

    // On a timeout, this still includes the latest interim words rather than losing them.
    return this.text;
  }

  abort(): void {
    if (!this.closed) this.ws.terminate();
  }

  private handle(raw: string): void {
    let msg: { type?: string };
    try {
      msg = JSON.parse(raw) as { type?: string };
    } catch {
      return;
    }
    if (msg.type === "Results") {
      const r = msg as DeepgramResults;
      const transcript = r.channel?.alternatives?.[0]?.transcript?.trim() ?? "";
      if (r.is_final) {
        if (transcript) this.finals.push(transcript);
        this.interim = "";
      } else {
        this.interim = transcript;
      }
      this.onUpdate(this.text);
    } else if (msg.type === "Error") {
      warn("stt", "Deepgram error message:", raw);
    } else if (msg.type === "Metadata") {
      log("stt", "stream closed by Deepgram");
    }
  }
}

function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    p.then(() => {
      clearTimeout(t);
      resolve();
    });
  });
}
