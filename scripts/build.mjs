import { build, context } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await copyFile(
  "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
  "dist/claude-sdk.mjs",
);
await copyFile(
  "node_modules/@anthropic-ai/claude-agent-sdk/README.md",
  "dist/CLAUDE-SDK-LICENSE.md",
);
const targets = [
  {
    entryPoints: ["src/extension/index.ts"],
    outfile: "dist/extension.cjs",
    platform: "node",
    format: "cjs",
    external: ["vscode", "./claude-sdk.mjs"],
    target: "node20",
  },
  {
    entryPoints: ["webview/index.tsx"],
    outfile: "dist/webview.js",
    platform: "browser",
    format: "iife",
    target: "es2022",
  },
];
for (const target of targets) {
  const options = {
    ...target,
    bundle: true,
    sourcemap: false,
    minify: !process.argv.includes("--watch"),
    logLevel: "info",
  };
  if (process.argv.includes("--watch")) await (await context(options)).watch();
  else await build(options);
}
