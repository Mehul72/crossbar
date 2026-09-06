import { build } from "esbuild";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
await mkdir(".test-output", { recursive: true });
const directory = await mkdtemp(
  join(process.cwd(), ".test-output", "runtime-"),
);
const source = `
import { CodexProvider } from '${process.cwd()}/src/providers/codex/provider.ts';
import { ClaudeProvider } from '${process.cwd()}/src/providers/claude/provider.ts';
import { query } from '${process.cwd()}/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
const deny = async () => 'deny' as const;
const providers = [new CodexProvider(() => process.env.CROSSBAR_CODEX_PATH || 'codex', () => process.cwd(), deny, async () => {}, text => process.stderr.write(text + '\\n')), new ClaudeProvider(() => process.env.CROSSBAR_CLAUDE_PATH || 'claude', () => process.cwd(), query, deny, async () => {}, text => process.stderr.write(text + '\\n'))];
try {
  for (const provider of providers) {
    const status = await provider.status();
    process.stdout.write(JSON.stringify({ provider: provider.id, state: status.state, detail: status.detail, modelCount: status.models.length, usageAvailable: !!status.usage }) + '\\n');
    if (process.argv.includes('--turn') && status.state === 'connected') {
      let text = '';
      let sessionId: string | undefined;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);
      try {
        for await (const event of provider.send({ cwd: process.cwd(), model: status.models[0]!.id, prompt: 'Reply with CROSSBAR_OK only. Do not read files or use tools.', readOnly: true }, controller.signal)) { if (event.type === 'text') text += event.text; if (event.type === 'session') sessionId = event.id; }
        if (!text.includes('CROSSBAR_OK')) throw new Error(provider.id + ' did not return the expected response');
        process.stdout.write(JSON.stringify({ provider: provider.id, streamingTurn: 'passed', sessionReturned: !!sessionId }) + '\\n');
      } finally { clearTimeout(timeout); }
    }
  }
} finally { for (const provider of providers) provider.dispose(); }
`;
try {
  await writeFile(join(directory, "check.ts"), source);
  await build({
    entryPoints: [join(directory, "check.ts")],
    outfile: join(directory, "check.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
  });
  await import(pathToFileURL(join(directory, "check.mjs")).href);
} finally {
  await rm(directory, { recursive: true, force: true });
}
