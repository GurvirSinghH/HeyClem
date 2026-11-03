# HeyClem

A desktop helper that answers questions about whatever is on your screen, out loud.

**Stage 1: "Ask about my screen".** Hold **Ctrl + Alt**, ask something like "what's this error?", and let go. Clem takes a screenshot of the display your mouse is on, transcribes what you said, asks the model, and speaks the answer while it's still being written.

```
hold Ctrl+Alt ──► mic (WebM/Opus) ──► Deepgram live STT ─┐
             └──► screenshot of the display under the mouse ─┤
release ─────────────────────────────────────────────────────┴─► model (streamed)
                                     sentence by sentence ──► Deepgram Aura TTS ──► speakers
```

| Folder | What it is |
|---|---|
| `worker/` | Cloudflare Worker (Hono). Holds the API keys and relays live transcription, speech and model requests. Nothing secret ships in the app. |
| `app/` | Electron + TypeScript. Hold-to-talk hook, mic, screen capture, Claude streaming, and the status pill at the top of your screen. |

## Run it

You need a **Deepgram** key ([console.deepgram.com](https://console.deepgram.com)) and one of these for the model that answers:

- **Cloudflare Workers AI** (free daily allowance): in the Cloudflare dashboard, open Workers AI → **Use REST API**. Choose **Create a Workers AI API Token**, and copy both the token and the **Account ID**.
- **Anthropic** ([console.anthropic.com](https://console.anthropic.com)): an API key. Set `CLEM_MODEL` in `app/.env` to a Claude model.

1. Open `worker/.dev.vars` and paste your values after `DEEPGRAM_API_KEY=`, then `CLOUDFLARE_API_TOKEN=` and `CLOUDFLARE_ACCOUNT_ID=` (or `ANTHROPIC_API_KEY=`). The shared `CLEM_APP_TOKEN` is already generated and matches `app/.env`.
2. Terminal 1:
   ```powershell
   cd worker
   npm install
   npm run dev
   ```
3. Terminal 2:
   ```powershell
   cd app
   npm install
   npm start
   ```
4. A pill at the top of the screen says "Hold Ctrl+Alt and ask about your screen." Try it on an error message.

A magenta dot in the system tray has **Test the voice** and **Quit HeyClem**.

## Settings (`app/.env`)

| Key | Default | Notes |
|---|---|---|
| `CLEM_WORKER_URL` | `http://127.0.0.1:8787` | Change to your `*.workers.dev` URL after deploying. |
| `CLEM_APP_TOKEN` | generated | Must equal the worker's `CLEM_APP_TOKEN`. |
| `CLEM_MODEL` | `claude-opus-5-5` if unset | IDs starting with `@cf/` run on Workers AI (`@cf/meta/llama-4-scout-17b-16e-instruct`, `@cf/mistralai/mistral-small-3.1-24b-instruct`); others are Claude (`claude-haiku-5-5`, `claude-sonnet-5-5`). The worker must allow it. |
| `CLEM_EFFORT` | `low` | Claude only. `low` keeps spoken answers quick; raise it for harder questions. |
| `CLEM_STT_LANGUAGE` | `en` | `multi` handles mixed-language speech. |

Opus and Sonnet requests use Claude's server-side refusal fallback (`fallbacks: "default"`), so a false-positive safety decline is retried on Anthropic's recommended model instead of failing. Haiku has no fallback, so if it declines, Clem says "I can't help with that one."

## Is Stage 1 done?

The goal is a spoken answer **under 3 seconds** after you let go. Each question prints a timing line in the `npm start` terminal:

```
#3 done | transcript 310 ms | first word 1450 ms | first audio 1920 ms (from key release) | screenshot 140 ms
```

"First audio" is the number to watch. If it's over 3 s, try a different `CLEM_MODEL`.

## Deploy the worker

```powershell
cd worker
npx wrangler login
npx wrangler secret put DEEPGRAM_API_KEY
npx wrangler secret put CLEM_APP_TOKEN    # same value as app/.env
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID    # or ANTHROPIC_API_KEY for Claude
npx wrangler deploy
```

Then set `CLEM_WORKER_URL` in `app/.env` to the URL `wrangler deploy` prints.

## If something's wrong

- **"The worker is missing secrets"**: fill in `worker/.dev.vars` and restart `npm run dev`.
- **"Can't reach the worker"**: the worker terminal isn't running, or `CLEM_WORKER_URL` is wrong.
- **"Can't use the microphone"**: Windows Settings → Privacy & security → Microphone → turn on *Let desktop apps access your microphone*.
- **Nothing happens on Ctrl+Alt**: if the native keyboard hook can't load, Clem switches to **Ctrl+Alt+Space** (press to start, press again to send). The tray tooltip shows which one is active.
- **Ctrl+Alt is also your AltGr key** (some keyboard layouts): pressing another key while holding cancels the question, so typing with AltGr doesn't trigger Clem.

## Privacy

Clem only listens and captures while you hold the keys. The screenshot (display under your mouse, max 1568 px) and your words go through your worker to the model you chose. Your words also go to Deepgram. The pill is excluded from screen captures, so it never appears in Clem's own screenshots. The mic closes a minute after your last question.

## Next stages

See the build plan: point and draw on screen (week 2), guided walkthroughs (week 3), voice-spawned agents (weeks 4–5), Gmail and Notion (week 6).
