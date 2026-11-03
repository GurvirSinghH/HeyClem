import type { ClemConfig } from "./config";

export class WorkerError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
  }
}

/** Talks to the HeyClem Worker, which holds every API key. */
export class WorkerClient {
  constructor(private readonly cfg: ClemConfig) {}

  get url(): string {
    return this.cfg.workerUrl;
  }

  async health(): Promise<{ ok: boolean; missing: string[]; brains?: { anthropic: boolean; workersAi: boolean } }> {
    const res = await this.fetch("/health", { method: "GET" }, false);
    return (await res.json()) as { ok: boolean; missing: string[]; brains?: { anthropic: boolean; workersAi: boolean } };
  }

  /** OpenAI-style chat request to Cloudflare Workers AI; the response body is the model's stream. */
  async workersAiChat(body: unknown, signal: AbortSignal): Promise<Response> {
    return this.fetch("/v1/brain/workers-ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  }

  /** Text to a stream of raw 16-bit, 24 kHz PCM (Deepgram Aura via the worker). */
  async speakStream(text: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const res = await this.fetch("/v1/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal,
    });
    if (!res.body) throw new WorkerError("The worker returned no audio.", null);
    return res.body;
  }

  private async fetch(route: string, init: RequestInit, authed = true): Promise<Response> {
    const headers = new Headers(init.headers);
    if (authed) headers.set("Authorization", `Bearer ${this.cfg.appToken}`);
    let res: Response;
    try {
      res = await fetch(`${this.cfg.workerUrl}${route}`, { ...init, headers });
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      throw new WorkerError(`Can't reach the worker at ${this.cfg.workerUrl}. See worker.log (tray menu, Open logs).`, null);
    }
    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.json()) as { message?: string; error?: string; detail?: string };
        detail = body.message ?? body.detail ?? body.error ?? "";
      } catch {
        /* not JSON */
      }
      if (res.status === 401) {
        throw new WorkerError("The worker rejected the app token. CLEM_APP_TOKEN must match in app/.env and worker/.dev.vars.", 401);
      }
      throw new WorkerError(`Worker ${route} failed (${res.status})${detail ? `: ${detail}` : ""}`, res.status);
    }
    return res;
  }
}
