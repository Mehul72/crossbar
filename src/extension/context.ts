import * as vscode from "vscode";
import { realpath, readFile, stat } from "node:fs/promises";
import { relative, resolve, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import type { Attachment } from "../shared/domain";
import { run } from "../providers/runtime";
const MAX_FILE_BYTES = 150_000;
export async function workspacePath(
  root: string,
  candidate: string,
): Promise<string> {
  const [base, path] = await Promise.all([
    realpath(root),
    realpath(resolve(root, candidate)),
  ]);
  const inside = relative(base, path);
  if (
    inside === ".." ||
    inside.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(inside)
  )
    throw new Error(
      "Only files inside this workspace can be opened or attached.",
    );
  return path;
}
function attachment(
  kind: Attachment["kind"],
  name: string,
  content: string,
): Attachment {
  return { id: randomUUID(), kind, name, content, createdAt: Date.now() };
}
async function fileAttachment(
  root: string,
  uri: vscode.Uri,
): Promise<Attachment> {
  if (uri.scheme !== "file")
    throw new Error("Only local workspace files can be attached.");
  const path = await workspacePath(root, uri.fsPath);
  if ((await stat(path)).size > MAX_FILE_BYTES)
    throw new Error("This file exceeds 150 KB. Attach a selection instead.");
  const document = vscode.workspace.textDocuments.find(
    (document) => document.uri.toString() === uri.toString(),
  );
  const content = document?.getText() ?? (await readFile(path, "utf8"));
  if (content.includes("\0"))
    throw new Error("Binary files cannot be attached as text.");
  return attachment("file", relative(root, path), content);
}
export async function collectContext(
  root: string,
  kind: "current" | "selection" | "file" | "diff" | "problems" | "editors",
): Promise<Attachment[]> {
  if (!vscode.workspace.isTrusted)
    throw new Error("Trust this workspace before attaching context.");
  if (kind === "diff") {
    const unstaged = await run(
      "git",
      ["diff", "--no-ext-diff", "--no-textconv", "--", "."],
      root,
    );
    const staged = await run(
      "git",
      ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--", "."],
      root,
    );
    if (!unstaged && !staged)
      throw new Error(
        "No tracked changes found. Untracked files can be attached separately.",
      );
    return [
      attachment(
        "diff",
        "Git diff",
        `${staged ? `Staged changes\n${staged}\n` : ""}${unstaged ? `Unstaged changes\n${unstaged}` : ""}`,
      ),
    ];
  }
  if (kind === "problems") {
    const lines: string[] = [];
    for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
      if (uri.scheme !== "file" || !vscode.workspace.getWorkspaceFolder(uri))
        continue;
      const path = relative(root, uri.fsPath);
      if (path.startsWith("..") || isAbsolute(path)) continue;
      for (const diagnostic of diagnostics)
        lines.push(
          `${path}:${diagnostic.range.start.line + 1} ${vscode.DiagnosticSeverity[diagnostic.severity]}: ${diagnostic.message}`,
        );
    }
    return [
      attachment(
        "problems",
        `${lines.length} Problems`,
        lines.join("\n") ||
          "VS Code reports no diagnostics for this workspace.",
      ),
    ];
  }
  if (kind === "file") {
    const files = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFolders: false,
      defaultUri: vscode.Uri.file(root),
      openLabel: "Attach to Crossbar",
    });
    const result: Attachment[] = [];
    for (const file of files ?? [])
      result.push(await fileAttachment(root, file));
    return result;
  }
  if (kind === "editors") {
    const files = new Map<string, vscode.Uri>();
    for (const group of vscode.window.tabGroups.all)
      for (const tab of group.tabs)
        if (
          tab.input instanceof vscode.TabInputText &&
          tab.input.uri.scheme === "file"
        )
          files.set(tab.input.uri.toString(), tab.input.uri);
    const result: Attachment[] = [];
    for (const file of files.values())
      if (vscode.workspace.getWorkspaceFolder(file)?.uri.fsPath === root)
        result.push(await fileAttachment(root, file));
    return result;
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor) throw new Error("Open a workspace file in the editor first.");
  if (kind === "current")
    return [await fileAttachment(root, editor.document.uri)];
  if (editor.selection.isEmpty)
    throw new Error("Select code in the editor first.");
  const path = await workspacePath(root, editor.document.uri.fsPath);
  return [
    attachment(
      "selection",
      `${relative(root, path)}:${editor.selection.start.line + 1}-${editor.selection.end.line + 1}`,
      editor.document.getText(editor.selection),
    ),
  ];
}
export async function openLink(root: string, target: string): Promise<void> {
  if (/^https?:\/\//i.test(target)) {
    await vscode.env.openExternal(vscode.Uri.parse(target));
    return;
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target))
    throw new Error("This link scheme is not supported.");
  const match = /^(.*?)(?::(\d+)(?::\d+)?)?(?:#L(\d+))?$/.exec(
    decodeURIComponent(target),
  );
  if (!match?.[1]) throw new Error("This file link is invalid.");
  const path = await workspacePath(root, match[1]);
  const line = Math.max(0, Number(match[2] ?? match[3] ?? 1) - 1);
  await vscode.window.showTextDocument(vscode.Uri.file(path), {
    selection: new vscode.Range(line, 0, line, 0),
    preview: true,
  });
}
