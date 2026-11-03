import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";

export type Effort = NonNullable<Anthropic.Beta.Messages.BetaOutputConfig["effort"]>;

export interface ClemConfig {
  workerUrl: string;
  appToken: string;
  model: string;
  /** Which brain serves the model: Workers AI model IDs start with "@cf/". */
  brain: "anthropic" | "workers-ai";
  effort: Effort;
  sttLanguage: string;
}

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

export class ConfigError extends Error {}

/** Reads app/.env (git-ignored). Values already in the environment win. */
export function loadConfig(): ClemConfig {
  const envPath = path.join(app.getAppPath(), ".env");
  if (fs.existsSync(envPath)) {
    for (const [key, value] of Object.entries(parseEnv(fs.readFileSync(envPath, "utf8")))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }

  const appToken = process.env.CLEM_APP_TOKEN?.trim() ?? "";
  if (!appToken || appToken.startsWith("change-me")) {
    throw new ConfigError("Set CLEM_APP_TOKEN in app/.env (same value as in worker/.dev.vars).");
  }

  const effort = (process.env.CLEM_EFFORT?.trim() || "low") as Effort;
  if (!EFFORTS.includes(effort)) {
    throw new ConfigError(`CLEM_EFFORT must be one of ${EFFORTS.join(", ")}.`);
  }

  const model = process.env.CLEM_MODEL?.trim() || "claude-opus-5-5";

  return {
    workerUrl: (process.env.CLEM_WORKER_URL?.trim() || "http://127.0.0.1:8787").replace(/\/+$/, ""),
    appToken,
    model,
    brain: model.startsWith("@cf/") ? "workers-ai" : "anthropic",
    effort,
    sttLanguage: process.env.CLEM_STT_LANGUAGE?.trim() || "en",
  };
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}
