import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, screen, session, Tray } from "electron";
import path from "node:path";
import { IPC, type PillState } from "../shared/ipc";
import { Brain } from "./brain";
import { ConfigError, loadConfig, type ClemConfig } from "./config";
import { log, warn } from "./log";
import { TurnController, type PillUi } from "./turn";
import { WorkerClient } from "./worker";
import { WorkersAiBrain } from "./workersAiBrain";

// The pill plays speech without ever being clicked.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const PILL_WIDTH = 560;
const PILL_HEIGHT = 260;
const FALLBACK_SHORTCUT = "Control+Alt+Space";

let pill: BrowserWindow | null = null;
let tray: Tray | null = null;
let stopHotkey: (() => void) | null = null;

function createPill(): BrowserWindow {
  const area = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({
    width: PILL_WIDTH,
    height: PILL_HEIGHT,
    x: Math.round(area.x + (area.width - PILL_WIDTH) / 2),
    y: area.y + 10,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    title: "HeyClem",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keep recording and playback running while unfocused
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setIgnoreMouseEvents(true); // Stage 1: the pill only shows status; clicks pass through
  win.setContentProtection(true); // keep the pill out of screenshots, including Clem's own
  // The pill's console (mic and playback problems) goes to the terminal log.
  win.webContents.on("console-message", (e) => {
    if (e.level === "debug") return;
    const line = `${e.message}${e.level === "info" ? "" : ` (${e.sourceId}:${e.lineNumber})`}`;
    if (e.level === "info") log("pill", line);
    else warn("pill", line);
  });
  void win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.once("ready-to-show", () => win.showInactive());
  return win;
}

function pillUi(win: BrowserWindow): PillUi {
  const send = (channel: string, ...args: unknown[]) => {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args);
  };
  return {
    state: (s: PillState) => send(IPC.state, s),
    micStart: () => send(IPC.micStart),
    micStop: () => send(IPC.micStop),
    audioPlay: (turnId, seq, mp3) => send(IPC.audioPlay, { turnId, seq, bytes: new Uint8Array(mp3) }),
    audioEnd: (turnId) => send(IPC.audioEnd, turnId),
    audioFlush: () => send(IPC.audioFlush),
  };
}

/** A small magenta dot for the tray, drawn in code so no icon file is needed. */
function dotIcon(size = 32): Electron.NativeImage {
  const buf = Buffer.alloc(size * size * 4);
  const r = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - r, y + 0.5 - r);
      const a = Math.max(0, Math.min(1, r - 3 - d + 0.5));
      const i = (y * size + x) * 4;
      // BGRA, premultiplied: #ff2d95
      buf[i] = Math.round(0x95 * a);
      buf[i + 1] = Math.round(0x2d * a);
      buf[i + 2] = Math.round(0xff * a);
      buf[i + 3] = Math.round(255 * a);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function createTray(howToAsk: string, onTestVoice: (() => void) | null): Tray {
  const t = new Tray(dotIcon());
  t.setToolTip(`HeyClem: ${howToAsk}`);
  t.setContextMenu(
    Menu.buildFromTemplate([
      { label: howToAsk, enabled: false },
      { label: "Test the voice", enabled: onTestVoice !== null, click: () => onTestVoice?.() },
      { type: "separator" },
      { label: "Quit HeyClem", click: () => app.quit() },
    ]),
  );
  return t;
}

function toBuffer(chunk: unknown): Buffer | null {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof ArrayBuffer) return Buffer.from(chunk);
  if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return null;
}

async function startHotkey(turns: TurnController): Promise<string> {
  try {
    const { startHoldToTalk } = await import("./hotkey");
    const handle = startHoldToTalk({
      onStart: () => turns.begin(),
      onEnd: () => turns.end(),
      onCancel: () => turns.cancel(),
    });
    stopHotkey = () => handle.stop();
    return "Hold Ctrl+Alt and ask";
  } catch (err) {
    // Without the native keyboard hook, fall back to press-to-start / press-to-stop.
    warn("hotkey", "hold-to-talk hook unavailable, using toggle shortcut:", (err as Error).message);
    let listening = false;
    globalShortcut.register(FALLBACK_SHORTCUT, () => {
      listening = !listening;
      if (listening) turns.begin();
      else turns.end();
    });
    return "Press Ctrl+Alt+Space, ask, press again";
  }
}

async function main(): Promise<void> {
  await app.whenReady();

  // The pill window is the only web content, and it only needs the microphone.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === "media"));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === "media");

  pill = createPill();
  const ui = pillUi(pill);
  await new Promise<void>((resolve) => pill!.webContents.once("did-finish-load", () => resolve()));

  let cfg: ClemConfig;
  try {
    cfg = loadConfig();
  } catch (err) {
    const message = err instanceof ConfigError ? err.message : String(err);
    ui.state({ phase: "error", message });
    tray = createTray("Not configured: see app/.env", null);
    warn("config", message);
    return;
  }

  const worker = new WorkerClient(cfg);
  const brain = cfg.brain === "workers-ai" ? new WorkersAiBrain(cfg, worker) : new Brain(cfg);
  const turns = new TurnController(cfg, worker, brain, ui);

  ipcMain.on(IPC.micChunk, (_e, chunk: unknown) => {
    const buf = toBuffer(chunk);
    if (buf) turns.onMicChunk(buf);
  });
  ipcMain.on(IPC.micEnded, () => turns.onMicEnded());
  ipcMain.on(IPC.micError, (_e, message: string) => turns.onMicError(message));
  ipcMain.on(IPC.audioDrained, (_e, turnId: number) => turns.onAudioDrained(turnId));

  const howToAsk = await startHotkey(turns);
  let testTurn = -1;
  tray = createTray(howToAsk, () => {
    void worker
      .speak("Hi, I'm Clem. Hold Control and Alt, ask about your screen, then let go.", new AbortController().signal)
      .then((mp3) => {
        ui.audioFlush();
        ui.audioPlay(testTurn, 0, mp3);
        ui.audioEnd(testTurn--);
      })
      .catch((err: Error) => ui.state({ phase: "error", message: err.message }));
  });

  const effort = cfg.brain === "anthropic" ? ` (effort ${cfg.effort})` : "";
  log("app", `worker ${cfg.workerUrl} | model ${cfg.model}${effort} | stt ${cfg.sttLanguage}`);
  try {
    const health = await worker.health();
    if (!health.ok) {
      ui.state({ phase: "error", message: `The worker is missing secrets: ${health.missing.join(", ")}. Fill in worker/.dev.vars.` });
      return;
    }
    const brainReady = cfg.brain === "workers-ai" ? health.brains?.workersAi : health.brains?.anthropic;
    if (!brainReady) {
      const needs = cfg.brain === "workers-ai" ? "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID" : "ANTHROPIC_API_KEY";
      ui.state({ phase: "error", message: `${cfg.model} needs ${needs} in worker/.dev.vars. Add it, then restart the worker.` });
      return;
    }
    ui.state({ phase: "idle", message: `${howToAsk} about your screen.` });
  } catch (err) {
    ui.state({ phase: "error", message: (err as Error).message });
  }
}

app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => {
  stopHotkey?.();
  globalShortcut.unregisterAll();
  tray?.destroy();
});

main().catch((err) => {
  warn("app", "startup failed:", err);
  app.quit();
});
