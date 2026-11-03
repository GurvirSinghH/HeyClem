import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface LocalWorkerOptions {
  /** The worker project folder (holds wrangler, wrangler.toml and .dev.vars). */
  workerDir: string;
  url: string;
  logFile: string;
  log(message: string): void;
}

const RESTART_MIN_MS = 2_000;
const RESTART_MAX_MS = 60_000;
/** A run this long counts as healthy, so the next crash restarts quickly again. */
const STABLE_RUN_MS = 60_000;

export class LocalWorkerError extends Error {}

/**
 * Runs the worker on this PC while the app is open: restarts it if it dies, and stops the
 * whole process tree (wrangler and its workerd children) when the app quits.
 */
export class LocalWorker {
  private child: ChildProcess | null = null;
  private stopped = false;
  private restartDelay = RESTART_MIN_MS;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: LocalWorkerOptions) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(): void {
    this.stopped = false;
    this.launch();
  }

  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.opts.url}/health`, { signal: AbortSignal.timeout(1500) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async waitUntilHealthy(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isHealthy()) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  /** Synchronous, so it finishes while the app is quitting. */
  stop(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const pid = this.child?.pid;
    this.child = null;
    if (!pid) return;
    // /T takes workerd too; killing wrangler alone leaves it holding the port.
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  }

  private launch(): void {
    const { workerDir, url, logFile, log } = this.opts;
    const wrangler = path.join(workerDir, "node_modules", "wrangler", "bin", "wrangler.js");
    if (!fs.existsSync(wrangler)) {
      throw new LocalWorkerError(`Wrangler isn't installed. Run "npm install" in ${workerDir}.`);
    }
    const { hostname, port } = new URL(url);

    const out = fs.openSync(logFile, "a");
    const startedAt = Date.now();
    // Real Node, not Electron running as Node: wrangler's argument parser sees Electron and misreads the command.
    const child = spawn("node", [wrangler, "dev", "--port", port || "8787", "--ip", hostname], {
      cwd: workerDir,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" },
      stdio: ["ignore", out, out],
      windowsHide: true,
    });
    fs.closeSync(out);
    this.child = child;
    log(`started (pid ${child.pid})`);

    child.on("error", (err) => log(`couldn't start: ${err.message}`));
    child.on("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      if (this.stopped) return;
      if (Date.now() - startedAt > STABLE_RUN_MS) this.restartDelay = RESTART_MIN_MS;
      log(`exited (${signal ?? code}); restarting in ${this.restartDelay / 1000} s`);
      this.restartTimer = setTimeout(() => {
        if (!this.stopped) this.launch();
      }, this.restartDelay);
      this.restartDelay = Math.min(this.restartDelay * 2, RESTART_MAX_MS);
    });
  }
}
