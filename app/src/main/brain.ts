import Anthropic from "@anthropic-ai/sdk";
import type { ClemConfig } from "./config";
import { SYSTEM_PROMPT, TextHistory, describeTurn, type BrainLike, type BrainResult } from "./prompt";
import type { Screenshot } from "./screenshot";

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;

/** Claude, through the worker's /anthropic proxy. */
export class Brain implements BrainLike {
  private readonly client: Anthropic;
  /**
   * Plain-text history: no thinking blocks are replayed, so the history-binding check on newer
   * Claude models has nothing to reject, and dropping old screenshots is safe.
   */
  private readonly history = new TextHistory();

  constructor(private readonly cfg: ClemConfig) {
    // The worker holds the real Anthropic key; the app token is what it checks.
    this.client = new Anthropic({
      apiKey: cfg.appToken,
      baseURL: `${cfg.workerUrl}/anthropic`,
      maxRetries: 1,
      timeout: 60_000,
    });
  }

  async answer(
    question: string,
    shot: Screenshot | null,
    onText: (delta: string) => void,
    signal: AbortSignal,
  ): Promise<BrainResult> {
    const content: ContentBlockParam[] = [];
    if (shot) {
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: shot.jpegBase64 } });
    }
    content.push({ type: "text", text: describeTurn(question, shot) });

    const messages: MessageParam[] = [...this.history.recent(), { role: "user", content }];

    const stream = this.client.beta.messages.stream(
      {
        model: this.cfg.model,
        max_tokens: 4096,
        // Thinking stays on by default for these models; low effort keeps spoken answers fast.
        output_config: { effort: this.cfg.effort },
        // Server-side refusal fallback: a policy decline is retried on Anthropic's recommended model.
        // Haiku has no server-side fallback, so the parameter is left off for it.
        ...(this.cfg.model.startsWith("claude-haiku")
          ? {}
          : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
        system: SYSTEM_PROMPT,
        messages,
      },
      { signal },
    );
    stream.on("text", onText);
    const final = await stream.finalMessage();

    const refused = final.stop_reason === "refusal";
    const text = final.content
      .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    if (!refused && text) this.history.add(question, text);
    return { text, refused };
  }
}
