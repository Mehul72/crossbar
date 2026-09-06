# Crossbar

One chat for your coding agents. Crossbar is a VS Code sidebar that talks to the
Codex and Claude Code runtimes already installed on your machine, keeps a single
conversation history that survives switching between them, and shows what each
provider actually reported rather than a guess.

## What it does

- One conversation across both providers. Switching provider mid-thread carries
  the history forward instead of starting over.
- Compare a prompt across both providers side by side, then keep the answer you
  prefer as the one that continues the thread.
- Context Capsules: summarise a long thread into a structured attachment and
  continue from it when a session gets close to its context limit.
- Attach workspace files or selections, or drop text files from your file manager.
- Per-model reasoning effort. Each model advertises its own levels, and the
  composer offers only those, defaulting to the model's own setting.
- The selected model names itself. "Default (recommended)" shows the provider's
  own description underneath, so you always know what will actually run.
- Enter sends, Shift + Enter starts a new line.
- Tool calls, command output and diffs are shown as the runtime reports them,
  with approvals prompted in VS Code before anything runs.
- Usage and quota come from the provider itself. Nothing is estimated. When a
  limit is spent, the composer says so and when it lifts, instead of failing on
  your next send.
- Your local Claude Code configuration applies by default, so your skills,
  CLAUDE.md, hooks and MCP servers work as they do in the terminal.

## Requirements

- VS Code 1.136 or newer, desktop. Crossbar lives in the secondary
  sidebar, alongside Claude Code and Codex, which needs that version.
- Node.js 20.19 or newer to build.
- A trusted, local, single-folder workspace. Crossbar stays inert in an untrusted
  or virtual workspace.
- At least one runtime installed and signed in:
  - Codex CLI, signed in with your ChatGPT account.
  - Claude Code, signed in with your Claude subscription.

## Install

```
npm install
npm run package
```

That produces `crossbar-0.1.0.vsix`. Install it with
`code --install-extension crossbar-0.1.0.vsix`, or from the Extensions view via
"Install from VSIX".

## Connecting providers

Open the secondary sidebar (View: Toggle Secondary Side Bar), pick the
**Crossbar** tab, then **Provider settings**.

- **Codex** connects through the Codex CLI's own ChatGPT login. If Crossbar
  reports Codex as missing, the CLI is not on `PATH`. Set `crossbar.codexPath`
  to the executable. The Codex CLI bundled inside the ChatGPT VS Code extension
  works, for example
  `~/.vscode/extensions/openai.chatgpt-<version>/bin/macos-aarch64/codex`.
- **Claude** connects through the Claude Code executable and the Agent SDK,
  using the subscription login already on the machine. Set `crossbar.claudePath`
  to choose an executable explicitly. By default Crossbar uses the runtime bundled
  with the official Claude Code extension, falling back to `claude` on `PATH`.
  The bundled runtime supports numeric subscription usage; older CLIs may not.

Settings:

| Setting                        | Default  | Purpose                                                              |
| ------------------------------ | -------- | -------------------------------------------------------------------- |
| `crossbar.codexPath`           | `codex`  | Codex executable.                                                    |
| `crossbar.claudePath`          | `claude` | Claude Code executable.                                              |
| `crossbar.claudeConfiguration` | `full`   | How much of your local Claude Code configuration each session loads. |
| `crossbar.turnTimeoutSeconds`  | `600`    | Maximum generation time, including waits for approval.               |

### Claude configuration modes

`crossbar.claudeConfiguration` decides how much of your machine's Claude Code
setup a session loads. Verified command counts in a directory with a large skill
library installed: `full` and `skills` both see 144, `isolated` sees 15.

| Mode             | Skills and CLAUDE.md | Hooks | Configured MCP servers |
| ---------------- | -------------------- | ----- | ---------------------- |
| `full` (default) | yes                  | yes   | yes                    |
| `skills`         | yes                  | no    | no                     |
| `isolated`       | no                   | no    | no                     |

Hooks run shell commands without a Crossbar approval prompt, since they are your
own configuration. Choose `skills` if you want your skills without that.

## Limitations

These are deliberate, not pending work.

- **Subscription only.** Crossbar never accepts an API key and never falls back
  to API billing. It drives the official local runtimes and uses whatever
  authentication they already hold. When you reach a plan limit, generation
  stops and Crossbar shows the runtime's own message, including when it resets.
  Keep paid extra usage disabled in your provider account if you want a hard
  ceiling.
- **Shared limits.** Usage through Crossbar draws on the same plan limits as
  using the runtimes directly. It does not add capacity.
- **Desktop and local only.** No remote, virtual, or untrusted workspaces, and a
  single workspace folder per window.
- **No telemetry, no network of its own.** Crossbar makes no network calls; only
  the provider runtimes do.
- **Not published.** The package identifier is `crossbar` with a local
  publisher. No Marketplace name is claimed or reserved.
- **Effort levels are the provider's, not ours.** Crossbar lists exactly what
  each model reports and sends nothing when you leave it on default. The sets
  differ per model, so a level chosen for one model is dropped rather than
  forced onto another that does not offer it. Models with no levels show no
  control.
- **Usage refreshes automatically.** Opening Usage requests current information,
  then refreshes every minute while visible and after responses. Claude and Codex
  show remaining percentages and reset times for their 5-hour and weekly windows
  when the runtime supplies them. Missing percentages are labelled unavailable;
  failed refreshes retain the last reading, which is marked stale after five minutes.
  Claude uses the pinned SDK's experimental structured usage request without
  submitting a model prompt; older runtimes may provide only limit status.

To attach context, drop text files onto the composer from VS Code Explorer or
from your file manager. Explorer paths must stay inside the workspace. File-manager
uploads attach the bytes you explicitly drop. Each file is limited to 150 KB;
attachments together are limited to 20 items and 400,000 characters. Binary files
are not supported. To attach an excerpt, select it in the editor, right-click,
and choose **Add to Crossbar chat**. Review or remove attachments before sending.

## Data

Conversations are stored as JSON under the extension's global storage directory,
written atomically per conversation. Secrets matching common token shapes are
redacted from logs and stored output. Nothing leaves the machine except the
prompts the provider runtimes send on your behalf.

## Development

```
npm run typecheck      # TypeScript, no emit
npm run lint           # ESLint
npm test               # Vitest, fake runtimes only
npm run build          # esbuild extension + webview
npm run test:webview   # Renders the webview in Chromium, dark and light, with axe
npm run test:vscode    # Launches VS Code in a throwaway profile and drives the view
npm run check:runtimes # Live check against your real accounts
```

`check:runtimes` and `test:vscode` accept `CROSSBAR_CODEX_PATH` and
`CROSSBAR_CLAUDE_PATH` when the runtimes are not on `PATH`. Add `--turn` to
`check:runtimes` to send one small real prompt to each connected provider; that
consumes plan usage.

The unit tests never touch a real account. They drive the providers through fake
processes and fake SDK streams.

## License

MIT. See `LICENSE`. The bundled Claude Agent SDK keeps its own license, included
in the build output as `CLAUDE-SDK-LICENSE.md`.
