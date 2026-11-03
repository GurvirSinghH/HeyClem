import fs from "node:fs";
import path from "node:path";
import { format } from "node:util";

const MAX_LOG_BYTES = 5 * 1024 * 1024;

let file: fs.WriteStream | null = null;

function timestamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** Moves a log that has grown too big to `<name>.old`, so logs can't fill the disk. */
export function rotateLog(logFile: string): void {
  try {
    if (fs.statSync(logFile).size > MAX_LOG_BYTES) fs.renameSync(logFile, `${logFile}.old`);
  } catch {
    /* no log yet */
  }
}

/** In the background there's no terminal, so logs also go to a file. */
export function logToFile(logFile: string): void {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  rotateLog(logFile);
  file = fs.createWriteStream(logFile, { flags: "a" });
  file.on("error", () => {
    file = null;
  });
}

function write(scope: string, args: unknown[]): void {
  const line = `${timestamp()} [${scope}] ${format(...args)}`;
  file?.write(`${line}\n`);
  try {
    console.log(line);
  } catch {
    /* no console attached */
  }
}

export function log(scope: string, ...args: unknown[]): void {
  write(scope, args);
}

export function warn(scope: string, ...args: unknown[]): void {
  write(scope, ["WARN", ...args]);
}
