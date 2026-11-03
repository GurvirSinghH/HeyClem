// HeyClem Worker: the only place API keys live.
//
//   GET  /v1/listen               -> WebSocket relay to Deepgram live transcription
//   POST /v1/speak                -> Deepgram Aura text-to-speech (mp3 stream)
//   POST /anthropic/v1/messages   -> Claude Messages API proxy (the app's Anthropic SDK
//                                    points its baseURL here and sends the app token as its key)
//   POST /v1/brain/workers-ai     -> Cloudflare Workers AI chat proxy (OpenAI-compatible, streamed)
//   GET  /health                  -> liveness check
//
// Stage 1 auth is a single shared app token (CLEM_APP_TOKEN). Supabase sign-in replaces it later.

import { Hono } from "hono";
import type { Context } from "hono";

type Env = {
  DEEPGRAM_API_KEY: string;
  CLEM_APP_TOKEN: string;
  /** The app's brain needs one of: an Anthropic key, or a Cloudflare token + account ID. */
  ANTHROPIC_API_KEY?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  /** Comma-separated Claude model IDs the app may request. */
  ALLOWED_MODELS?: string;
  /** Comma-separated Workers AI model IDs the app may request. */
  WORKERS_AI_MODELS?: string;
  /** Deepgram Aura voice, e.g. aura-2-thalia-en */
  TTS_MODEL?: string;
};

const DEFAULT_ALLOWED_MODELS = "claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5";
const DEFAULT_WORKERS_AI_MODELS = "@cf/meta/llama-4-scout-17b-16e-instruct,@cf/mistralai/mistral-small-3.1-24b-instruct";
const DEFAULT_TTS_MODEL = "aura-2-thalia-en";
const MAX_TOKENS_CAP = 8192;
const MAX_TTS_CHARS = 1200;

const app = new Hono<{ Bindings: Env }>();

/** The runtime can reuse a pooled connection that has died ("Network connection lost"). One retry fixes it. */
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    return fetch(url, init);
  }
}

/** Constant-time string comparison so the token check doesn't leak timing. */
function safeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function brains(env: Env) {
  return {
    anthropic: Boolean(env.ANTHROPIC_API_KEY),
    workersAi: Boolean(env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID),
  };
}

function missingSecrets(env: Env): string[] {
  const missing: string[] = (["DEEPGRAM_API_KEY", "CLEM_APP_TOKEN"] as const).filter((k) => !env[k]);
  const available = brains(env);
  if (!available.anthropic && !available.workersAi) {
    missing.push("ANTHROPIC_API_KEY (or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID)");
  }
  return missing;
}

app.get("/health", (c) => {
  const missing = missingSecrets(c.env);
  return c.json({ ok: missing.length === 0, missing, brains: brains(c.env) });
});

// Bearer-token gate for the app's own routes.
app.use("/v1/*", async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "");
  if (!safeEqual(token, c.env.CLEM_APP_TOKEN)) {
    return c.json({ error: "unauthorized", message: "Missing or wrong app token." }, 401);
  }
  await next();
});

// The params the app may set on Deepgram's live endpoint.
const STT_PARAMS = ["model", "language", "smart_format", "punctuate", "interim_results"];

/** Relays one live-transcription socket, so the Deepgram key never leaves the worker. */
app.get("/v1/listen", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return c.json({ error: "bad_request", message: "Expected a WebSocket upgrade." }, 426);
  }

  const url = new URL("https://api.deepgram.com/v1/listen");
  for (const name of STT_PARAMS) {
    const value = c.req.query(name);
    if (value) url.searchParams.set(name, value);
  }

  const res = await fetch(url.toString(), {
    headers: { Upgrade: "websocket", Authorization: `Token ${c.env.DEEPGRAM_API_KEY}` },
  });
  const upstream = res.webSocket;
  if (!upstream) {
    return c.json({ error: "deepgram_listen_failed", status: res.status, message: "Deepgram refused the connection. Check DEEPGRAM_API_KEY." }, 502);
  }

  const [client, server] = Object.values(new WebSocketPair());
  // Keep audio frames binary. The default here is Blob, which send() would turn into text.
  upstream.binaryType = "arraybuffer";
  server.binaryType = "arraybuffer";
  upstream.accept();
  server.accept();

  const relay = (from: WebSocket, to: WebSocket) => {
    from.addEventListener("message", (e) => {
      try {
        to.send(e.data);
      } catch {
        /* the other side has already closed */
      }
    });
    from.addEventListener("close", (e) => {
      try {
        // 1005 and 1006 describe a missing close frame and can't be sent.
        to.close(e.code === 1005 || e.code === 1006 ? 1000 : e.code, e.reason);
      } catch {
        /* already closed */
      }
    });
    from.addEventListener("error", () => {
      try {
        to.close(1011, "relay error");
      } catch {
        /* already closed */
      }
    });
  };
  relay(server, upstream);
  relay(upstream, server);

  return new Response(null, { status: 101, webSocket: client });
});

app.post("/v1/speak", async (c) => {
  let text = "";
  try {
    const body = await c.req.json<{ text?: unknown }>();
    text = typeof body.text === "string" ? body.text.trim() : "";
  } catch {
    return c.json({ error: "bad_request", message: "Body must be JSON: {\"text\": \"...\"}" }, 400);
  }
  if (!text) return c.json({ error: "bad_request", message: "text is required" }, 400);
  if (text.length > MAX_TTS_CHARS) text = text.slice(0, MAX_TTS_CHARS);

  const model = c.env.TTS_MODEL || DEFAULT_TTS_MODEL;
  const res = await fetchWithRetry(`https://api.deepgram.com/v1/speak?model=${encodeURIComponent(model)}&encoding=mp3`, {
    method: "POST",
    headers: {
      Authorization: `Token ${c.env.DEEPGRAM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });
  if (!res.ok || !res.body) {
    return c.json({ error: "deepgram_speak_failed", status: res.status, detail: await res.text() }, 502);
  }
  return new Response(res.body, {
    headers: { "Content-Type": res.headers.get("content-type") ?? "audio/mpeg", "Cache-Control": "no-store" },
  });
});

app.post("/v1/brain/workers-ai", async (c) => {
  const token = c.env.CLOUDFLARE_API_TOKEN;
  const account = c.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) {
    return c.json(
      { error: "workers_ai_not_configured", message: "Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in worker/.dev.vars, then restart the worker." },
      503,
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "bad_request", message: "Body must be JSON." }, 400);
  }

  const allowed = (c.env.WORKERS_AI_MODELS || DEFAULT_WORKERS_AI_MODELS).split(",").map((m) => m.trim());
  if (typeof body.model !== "string" || !allowed.includes(body.model)) {
    return c.json({ error: "bad_request", message: `Model not allowed by this worker. Allowed: ${allowed.join(", ")}` }, 400);
  }
  if (typeof body.max_tokens !== "number" || body.max_tokens > MAX_TOKENS_CAP) {
    body.max_tokens = Math.min(Number(body.max_tokens) || MAX_TOKENS_CAP, MAX_TOKENS_CAP);
  }

  const upstream = await fetchWithRetry(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await cloudflareErrorMessage(upstream);
    // Sent as 502, not 401/403: the app would otherwise blame its own app token.
    const message =
      upstream.status === 401 || upstream.status === 403
        ? `Cloudflare rejected the request. Check CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in worker/.dev.vars. (${detail})`
        : `Workers AI returned ${upstream.status}: ${detail}`;
    return c.json({ error: "workers_ai_failed", status: upstream.status, message }, 502);
  }
  return new Response(upstream.body, {
    headers: { "Content-Type": upstream.headers.get("content-type") ?? "text/event-stream", "Cache-Control": "no-store" },
  });
});

async function cloudflareErrorMessage(res: Response): Promise<string> {
  const raw = await res.text();
  try {
    const parsed = JSON.parse(raw) as { errors?: { message?: string }[]; error?: { message?: string } | string };
    const first = parsed.errors?.[0]?.message ?? (typeof parsed.error === "string" ? parsed.error : parsed.error?.message);
    if (first) return first;
  } catch {
    /* not JSON */
  }
  return raw.slice(0, 300) || "no details";
}

/** Errors in the Anthropic API's own shape, so the SDK in the app raises its typed errors. */
function anthropicError(c: Context<{ Bindings: Env }>, status: 400 | 401, type: string, message: string) {
  return c.json({ type: "error", error: { type, message } }, status);
}

app.post("/anthropic/v1/messages", async (c) => {
  if (!safeEqual(c.req.header("x-api-key") ?? "", c.env.CLEM_APP_TOKEN)) {
    return anthropicError(c, 401, "authentication_error", "Missing or wrong app token.");
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return anthropicError(c, 400, "invalid_request_error", "Body must be JSON.");
  }

  const allowed = (c.env.ALLOWED_MODELS || DEFAULT_ALLOWED_MODELS).split(",").map((m) => m.trim());
  if (typeof body.model !== "string" || !allowed.includes(body.model)) {
    return anthropicError(c, 400, "invalid_request_error", `Model not allowed by this worker. Allowed: ${allowed.join(", ")}`);
  }
  if (typeof body.max_tokens !== "number" || body.max_tokens > MAX_TOKENS_CAP) {
    body.max_tokens = Math.min(Number(body.max_tokens) || MAX_TOKENS_CAP, MAX_TOKENS_CAP);
  }

  const headers = new Headers({
    "x-api-key": c.env.ANTHROPIC_API_KEY ?? "",
    "content-type": "application/json",
    "anthropic-version": c.req.header("anthropic-version") ?? "2023-06-01",
  });
  const beta = c.req.header("anthropic-beta");
  if (beta) headers.set("anthropic-beta", beta);

  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  // Stream the response (SSE or JSON) straight back to the app.
  const out = new Headers();
  for (const name of ["content-type", "request-id", "retry-after", "anthropic-ratelimit-requests-remaining"]) {
    const v = upstream.headers.get(name);
    if (v) out.set(name, v);
  }
  out.set("Cache-Control", "no-store");
  return new Response(upstream.body, { status: upstream.status, headers: out });
});

app.notFound((c) => c.json({ error: "not_found" }, 404));

export default app;
