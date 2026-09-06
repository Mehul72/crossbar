import type { WebviewMessage } from "../src/shared/messages";
export interface Preferences {
  provider?: "codex" | "claude";
  models?: Partial<Record<"codex" | "claude", string>>;
  draft?: string;
}
declare function acquireVsCodeApi(): {
  postMessage(message: WebviewMessage): void;
  getState(): Preferences | undefined;
  setState(state: Preferences): void;
};
export const vscode = acquireVsCodeApi();
export const post = (message: WebviewMessage): void =>
  vscode.postMessage(message);
