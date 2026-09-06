import * as vscode from "vscode";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ConversationStore } from "../storage/conversations";
import { ChatEngine } from "../conversations/engine";
import { CodexProvider } from "../providers/codex/provider";
import {
  ClaudeProvider,
  type ClaudeConfiguration,
} from "../providers/claude/provider";
import { ChatView } from "./view";
import type { Provider, ProviderId } from "../shared/domain";
import { redact } from "../providers/runtime";

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const output = vscode.window.createOutputChannel("Crossbar", { log: true });
  context.subscriptions.push(output);
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root || root.scheme !== "file" || !vscode.workspace.isTrusted) {
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider("crossbar.chat", {
        resolveWebviewView(view) {
          view.webview.html =
            '<!doctype html><html lang="en"><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"></head><body><p>Open and trust a local workspace folder to use Crossbar.</p></body></html>';
        },
      }),
    );
    return;
  }
  const config = () => vscode.workspace.getConfiguration("crossbar");
  const view = new ChatView(context, root.fsPath, output);
  const log = (text: string) => output.warn(redact(text));
  const codex = new CodexProvider(
    () => config().get<string>("codexPath", "codex"),
    () => root.fsPath,
    (approval, signal) => view.approve(approval, signal),
    async (url) => {
      if (!(await vscode.env.openExternal(vscode.Uri.parse(url))))
        throw new Error(
          "Could not open the Codex login page. Run codex login in a terminal.",
        );
    },
    log,
  );
  const claudeExecutable = () => {
    const configured = config().get<string>("claudePath", "claude");
    if (configured !== "claude") return configured;
    const extension = vscode.extensions.getExtension("anthropic.claude-code");
    if (extension) {
      const bundled = join(
        extension.extensionPath,
        "resources",
        "native-binary",
        process.platform === "win32" ? "claude.exe" : "claude",
      );
      if (existsSync(bundled)) return bundled;
    }
    return configured;
  };
  const sdk = (await import(
    pathToFileURL(join(__dirname, "claude-sdk.mjs")).href
  )) as typeof import("@anthropic-ai/claude-agent-sdk");
  const claude = new ClaudeProvider(
    claudeExecutable,
    () => root.fsPath,
    sdk.query,
    (approval, signal) => view.approve(approval, signal),
    async () => {
      const terminal = vscode.window.createTerminal({
        name: "Claude login",
        shellPath: claudeExecutable(),
        shellArgs: ["auth", "login"],
        cwd: root.fsPath,
      });
      context.subscriptions.push(terminal);
      terminal.show();
      void vscode.window.showInformationMessage(
        "Complete Claude subscription login in the terminal, then press Refresh in Crossbar Provider Settings. Keep paid extra usage disabled in your Claude account.",
      );
    },
    log,
    () => config().get<ClaudeConfiguration>("claudeConfiguration", "full"),
  );
  const providers = new Map<ProviderId, Provider>([
    ["codex", codex],
    ["claude", claude],
  ]);
  const store = new ConversationStore(
    join(context.globalStorageUri.fsPath, "conversations"),
    log,
  );
  view.engine = new ChatEngine(
    store,
    providers,
    root.fsPath,
    (event) => view.post(event),
    () =>
      Math.max(
        30,
        Math.min(3600, config().get<number>("turnTimeoutSeconds", 600)),
      ) * 1000,
  );
  context.subscriptions.push(
    view,
    vscode.window.registerWebviewViewProvider("crossbar.chat", view, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  const register = (name: string, action: () => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(`crossbar.${name}`, () =>
        Promise.resolve()
          .then(action)
          .catch((error) => view.fail(error)),
      ),
    );
  register("open", () => view.show());
  register("newChat", async () => {
    await view.engine.newChat();
    await view.show();
  });
  register("askCodex", () => view.composer("codex"));
  register("askClaude", () => view.composer("claude"));
  register("compare", () => view.composer(undefined, true));
  register("addFile", () => view.attach("current"));
  register("addSelection", () => view.attach("selection"));
  register("settings", () => view.panel("settings"));
  register("usage", () => view.panel("usage"));
  register("summarise", async () => {
    view.engine.assertIdle();
    const choices = view.engine.statuses
      .filter((provider) => provider.state === "connected")
      .flatMap((provider) =>
        provider.models.map((model) => ({
          label: `${provider.id} · ${model.name}`,
          provider: provider.id,
          model: model.id,
        })),
      );
    const selected = await vscode.window.showQuickPick(choices, {
      title: "Provider for Context Capsule",
    });
    if (selected)
      await view.engine.summarise(selected.provider, selected.model);
  });
  await view.engine.initialize(context.workspaceState.get<string>("lastChat"));
}
export function deactivate(): void {}
