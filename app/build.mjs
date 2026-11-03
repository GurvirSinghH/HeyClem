// Bundles main, preload and renderer with esbuild into dist/.
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist/renderer", { recursive: true });

const common = { bundle: true, sourcemap: true, target: "es2022", logLevel: "warning" };

await Promise.all([
  build({
    ...common,
    entryPoints: ["src/main/main.ts"],
    outfile: "dist/main.js",
    platform: "node",
    format: "cjs",
    // Native or optional modules stay in node_modules.
    external: ["electron", "uiohook-napi", "bufferutil", "utf-8-validate"],
  }),
  build({
    ...common,
    entryPoints: ["src/preload/preload.ts"],
    outfile: "dist/preload.js",
    platform: "node",
    format: "cjs",
    external: ["electron"],
  }),
  build({
    ...common,
    entryPoints: ["src/renderer/renderer.ts"],
    outfile: "dist/renderer/renderer.js",
    platform: "browser",
    format: "iife",
  }),
  cp("src/renderer/index.html", "dist/renderer/index.html"),
  cp("src/renderer/styles.css", "dist/renderer/styles.css"),
]);

console.log("built dist/ (main, preload, renderer)");
