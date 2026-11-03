import type { ClemConfig } from "./config";
import { SYSTEM_PROMPT, TextHistory, describeTurn, type BrainLike, type BrainResult } from "./prompt";
import type { Screenshot } from "./screenshot";
import { WorkerError, type WorkerClient } from "./worker";

/** Yields the payload of each `data:` line in a Server-Sent Events stream. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buf += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
      if (done) {
        const last = buf.trim();
        if (last.startsWith("data:")) yield last.slice(5).trim();
        return;
      }
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}

interface WorkersAiPayload {
  choices?: { delta?: { content?: unknown }; message?: { content?: unknown } }[];
  response?: unknown;
  result?: { response?: unknown };
  error?: unknown;
  errors?: { message?: string }[];
}

/**
 * Pulls text out of one payload. Cloudflare doesn't document this model's stream format, so both
 * shapes are accepted: OpenAI-style (`choices`) and Workers AI's own (`response`).
 */
export function textFromPayload(raw: string): string {
  let j: WorkersAiPayload;
  try {
    j = JSON.parse(raw) as WorkersAiPayload;
  } catch {
    return "";
  }
  const problem = j.errors?.[0]?.message ?? (typeof j.error === "string" ? j.error : undefined);
  if (problem) throw new WorkerError(`Workers AI error: ${problem}`, null);
  const choice = j.choices?.[0];
  const text = choice?.delta?.content ?? choice?.message?.content ?? j.response ?? j.result?.response;
  // Workers AI sends digit tokens as JSON numbers ("content": 18), not strings.
  return typeof text === "string" ? text : typeof text === "number" ? String(text) : "";
}

/** A vision model on Cloudflare Workers AI, through the worker, which holds the API token. */
export class WorkersAiBrain implements BrainLike {
  private readonly history = new TextHistory();

  constructor(
    private readonly cfg: ClemConfig,
    private readonly worker: WorkerClient,
  ) {}

  async answer(
    question: string,
    shot: Screenshot | null,
    onText: (delta: string) => void,
    signal: AbortSignal,
  ): Promise<BrainResult> {
    const content: unknown[] = [{ type: "text", text: describeTurn(question, shot) }];
    if (shot) {
      content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${shot.jpegBase64}` } });
    }

    const res = await this.worker.workersAiChat(
      {
        model: this.cfg.model,
        // Workers AI defaults to only 256 tokens.
        max_tokens: 1024,
        stream: true,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...this.history.recent(), { role: "user", content }],
      },
      signal,
    );

    let text = "";
    const emit = (delta: string) => {
      if (!delta) return;
      text += delta;
      onText(delta);
    };

    if (res.body && (res.headers.get("content-type") ?? "").includes("event-stream")) {
      for await (const data of sseData(res.body)) {
        if (data === "[DONE]") break;
        emit(textFromPayload(data));
      }
    } else {
      emit(textFromPayload(await res.text()));
    }

    text = text.trim();
    if (!text) throw new WorkerError("Workers AI returned an empty answer.", null);
    this.history.add(question, text);
    return { text, refused: false };
  }
}
