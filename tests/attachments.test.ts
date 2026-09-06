import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { collectDroppedFiles, collectContext } from "../src/extension/context";
import { webviewMessage } from "../src/shared/messages";
import * as vscode from "vscode";

vi.mock("vscode", () => ({
  workspace: { isTrusted: true, textDocuments: [] },
  window: { activeTextEditor: undefined },
  Uri: {
    parse: (value: string) => {
      const uri = new URL(value);
      return {
        scheme: uri.protocol.slice(0, -1),
        fsPath: uri.protocol === "file:" ? fileURLToPath(uri) : "",
        toString: () => value,
      };
    },
  },
}));

describe("chat attachments", () => {
  let directory: string;
  let root: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "crossbar-attachments-"));
    root = join(directory, "workspace");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(root);
    await writeFile(join(root, "source.ts"), "saved text");
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  it("attaches URI drops once and explicit file-manager content without reading an arbitrary path", async () => {
    const uri = pathToFileURL(join(root, "source.ts")).href;
    const result = await collectDroppedFiles(
      root,
      [uri, uri],
      [{ name: "notes.txt", content: "dropped bytes" }],
    );
    expect(result.map((item) => [item.name, item.content])).toEqual([
      ["source.ts", "saved text"],
      ["notes.txt", "dropped bytes"],
    ]);
  });
  it("rejects files outside the workspace, symlink escapes, directories and binary or oversized content", async () => {
    const outside = join(directory, "outside.txt");
    await writeFile(outside, "private");
    await symlink(outside, join(root, "escape.txt"));
    for (const path of [outside, join(root, "escape.txt")])
      await expect(
        collectDroppedFiles(root, [pathToFileURL(path).href], []),
      ).rejects.toThrow("inside this workspace");
    await expect(
      collectDroppedFiles(root, [pathToFileURL(root).href], []),
    ).rejects.toThrow("not folders");
    await expect(
      collectDroppedFiles(root, [], [{ name: "binary", content: "\0" }]),
    ).rejects.toThrow("Binary");
    await expect(
      collectDroppedFiles(
        root,
        [],
        [{ name: "large", content: "é".repeat(75_001) }],
      ),
    ).rejects.toThrow("150 KB");
    await expect(
      collectDroppedFiles(root, ["https://example.com/file"], []),
    ).rejects.toThrow("local workspace files");
  });
  it("captures the selected text with its file and line range", async () => {
    const uri = vscode.Uri.parse(pathToFileURL(join(root, "source.ts")).href);
    const selection = { isEmpty: false, start: { line: 2 }, end: { line: 4 } };
    const editor = {
      document: { uri, getText: vi.fn(() => "selected text") },
      selection,
    };
    Object.assign(vscode.window, { activeTextEditor: editor });
    try {
      expect(await collectContext(root, "selection")).toMatchObject([
        { kind: "selection", name: "source.ts:3-5", content: "selected text" },
      ]);
      expect(editor.document.getText).toHaveBeenCalledWith(selection);
    } finally {
      Object.assign(vscode.window, { activeTextEditor: undefined });
    }
  });
  it("validates the webview drop boundary before handling paths or content", () => {
    const drop = {
      type: "dropFiles",
      uris: [],
      files: [{ name: "safe.txt", content: "" }],
    };
    expect(webviewMessage.safeParse(drop).success).toBe(true);
    for (const files of [
      [],
      [{ name: "../escape", content: "" }],
      [{ name: "a", content: "x".repeat(150_001) }],
      Array(21).fill({ name: "a", content: "" }),
    ])
      expect(webviewMessage.safeParse({ ...drop, files }).success).toBe(false);
  });
});
