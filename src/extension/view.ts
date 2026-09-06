import * as vscode from "vscode";
import { randomBytes, randomUUID } from "node:crypto";
import type { ChatEngine } from "../conversations/engine";
import type { Approval, Decision, ProviderId } from "../shared/domain";
import {
  webviewMessage,
  type HostMessage,
  type WebviewMessage,
} from "../shared/messages";
import { collectContext, openLink } from "./context";
import { errorMessage, redact } from "../providers/runtime";

export class ChatView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private subscriptions: vscode.Disposable[] = [];
  private approvals = new Map<
    string,
    { approval: Approval; resolve: (decision: Decision) => void }
  >();
  private refresh?: Promise<void>;
  engine!: ChatEngine;
  constructor(
    private context: vscode.ExtensionContext,
    private root: string,
    private log: vscode.LogOutputChannel,
  ) {}
  post(event: HostMessage): void {
    if (event.type === "state") {
      event.approvals = [...this.approvals.values()].map(
        (item) => item.approval,
      );
      void this.context.workspaceState
        .update("lastChat", event.conversation.id)
        .then(undefined, (error) =>
          this.log.error(
            `Could not remember active chat: ${redact(errorMessage(error))}`,
          ),
        );
    }
    void this.view?.webview.postMessage(event);
  }
  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "dist"),
      ],
    };
    const nonce = randomBytes(24).toString("base64");
    const script = view.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js"),
    );
    const style = view.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.css"),
    );
    view.webview.html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${view.webview.cspSource}; img-src ${view.webview.cspSource} data:; font-src ${view.webview.cspSource}; connect-src 'none';"><link rel="stylesheet" href="${style}"><title>Crossbar</title></head><body><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
    const messages = view.webview.onDidReceiveMessage((value) => {
      const parsed = webviewMessage.safeParse(value);
      if (!parsed.success) {
        this.log.warn("Rejected invalid webview message.");
        return;
      }
      void this.handle(parsed.data).catch((error) => this.fail(error));
    });
    const disposed = view.onDidDispose(() => {
      messages.dispose();
      if (this.view === view) this.view = undefined;
    });
    this.subscriptions.push(messages, disposed);
  }
  fail(error: unknown): void {
    const message = redact(errorMessage(error));
    this.log.error(message);
    this.post({ type: "error", message });
  }
  async show(): Promise<void> {
    await vscode.commands.executeCommand("workbench.view.extension.crossbar");
    this.view?.show(true);
  }
  async panel(panel: "settings" | "usage" | "history"): Promise<void> {
    await this.show();
    this.post({ type: "panel", panel });
  }
  async composer(provider?: ProviderId, compare?: boolean): Promise<void> {
    await this.show();
    this.post({ type: "composer", provider, compare });
  }
  async attach(kind: "current" | "selection"): Promise<void> {
    await this.engine.attach(await collectContext(this.root, kind));
    await this.show();
  }
  approve(approval: Approval, signal: AbortSignal): Promise<Decision> {
    if (signal.aborted || !this.view) return Promise.resolve("deny");
    return new Promise((resolve) => {
      const settle = (decision: Decision) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.approvals.delete(approval.id);
        this.post({ type: "approvalResolved", id: approval.id });
        resolve(decision);
      };
      const abort = () => settle("deny");
      const timer = setTimeout(abort, 120_000);
      this.approvals.set(approval.id, { approval, resolve: settle });
      signal.addEventListener("abort", abort, { once: true });
      this.post({ type: "approval", approval });
    });
  }
  private refreshProviders(): Promise<void> {
    if (!this.refresh)
      this.refresh = this.engine.refresh().finally(() => {
        this.refresh = undefined;
      });
    return this.refresh;
  }
  private async handle(message: WebviewMessage): Promise<void> {
    if (!vscode.workspace.isTrusted)
      throw new Error("Trust the workspace to use Crossbar.");
    switch (message.type) {
      case "ready":
        await this.engine.state();
        await this.refreshProviders();
        break;
      case "refresh":
        await this.refreshProviders();
        break;
      case "new":
        await this.engine.newChat();
        break;
      case "open":
        await this.engine.open(message.id);
        break;
      case "rename":
        await this.engine.rename(message.id, message.title);
        break;
      case "delete":
        if (
          (await vscode.window.showWarningMessage(
            "Delete this local Crossbar conversation?",
            { modal: true },
            "Delete",
          )) === "Delete"
        )
          await this.engine.delete(message.id);
        break;
      case "send":
        await this.engine.send(
          message.requestId,
          message.text,
          message.provider,
          message.model,
          message.compare ? (message.otherModel ?? "default") : undefined,
        );
        break;
      case "stop":
        this.engine.stop();
        break;
      case "connect":
        this.engine.assertIdle();
        await this.engine.providers.get(message.provider)?.connect();
        await this.refreshProviders();
        break;
      case "disconnect": {
        this.engine.assertIdle();
        if (
          message.provider === "codex" &&
          (await vscode.window.showWarningMessage(
            "Disconnecting Codex signs out of the shared local Codex account. Continue?",
            { modal: true },
            "Disconnect",
          )) !== "Disconnect"
        )
          return;
        await this.engine.providers.get(message.provider)?.disconnect();
        await this.refreshProviders();
        break;
      }
      case "attach":
        await this.engine.attach(await collectContext(this.root, message.kind));
        break;
      case "removeAttachment":
        await this.engine.removeAttachment(message.id);
        break;
      case "summary":
        await this.engine.summarise(message.provider, message.model);
        break;
      case "approve": {
        const pending = this.approvals.get(message.id);
        if (pending?.approval.choices.includes(message.decision))
          pending.resolve(message.decision);
        break;
      }
      case "openLink":
        await openLink(this.root, message.target);
        break;
      case "copy":
        await vscode.env.clipboard.writeText(message.text);
        break;
      case "viewDiff": {
        const tool = this.engine
          .findMessage(message.messageId)
          .tools.find((tool) => tool.id === message.toolId);
        if (!tool?.diff) throw new Error("This diff is no longer available.");
        const document = await vscode.workspace.openTextDocument({
          content: tool.diff,
          language: "diff",
        });
        await vscode.window.showTextDocument(document, { preview: true });
        break;
      }
      case "choose":
        await this.engine.choose(message.messageId);
        break;
      case "review": {
        const response = this.engine.findMessage(message.messageId);
        await this.engine.send(
          randomUUID(),
          `Review this ${response.provider} response for mistakes and missing evidence. This is model review, not objective verification.\n\n${response.content}`,
          message.provider,
          message.model,
          undefined,
          true,
        );
        break;
      }
      case "older":
        this.engine.older(message.before);
        break;
    }
  }
  dispose(): void {
    for (const pending of this.approvals.values()) pending.resolve("deny");
    for (const subscription of this.subscriptions) subscription.dispose();
    this.engine.dispose();
  }
}
