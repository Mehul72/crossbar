import type { WebviewMessage } from "../src/shared/messages";

export function isFileDrop(data: DataTransfer): boolean {
  return [
    "files",
    "text/uri-list",
    "application/vnd.code.resources",
    "codeeditors",
  ].some((type) => data.types.some((value) => value.toLowerCase() === type));
}

export async function droppedFiles(
  data: DataTransfer,
): Promise<Extract<WebviewMessage, { type: "dropFiles" }>> {
  const uris = data
    .getData("text/uri-list")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const resources = data.getData("application/vnd.code.resources");
  if (resources) {
    const parsed: unknown = JSON.parse(resources);
    if (
      !Array.isArray(parsed) ||
      !parsed.every((value) => typeof value === "string")
    )
      throw new Error("Could not read the dropped file paths.");
    uris.push(...parsed);
  }
  const editors = data.getData("CodeEditors");
  if (!uris.length && editors) {
    const parsed: unknown = JSON.parse(editors);
    if (!Array.isArray(parsed))
      throw new Error("Could not read the dropped editors.");
    for (const editor of parsed) {
      if (typeof editor?.resource === "string") uris.push(editor.resource);
      else if (
        editor?.resource?.scheme === "file" &&
        typeof editor.resource.path === "string"
      )
        uris.push(
          `file://${editor.resource.authority ?? ""}${encodeURI(editor.resource.path).replaceAll("#", "%23").replaceAll("?", "%3F")}`,
        );
    }
  }
  const unique = [...new Set(uris)];
  if (unique.length > 20 || data.files.length > 20)
    throw new Error("Attach at most 20 files at once.");
  // Explorer/editor drops expose URIs, preserving unsaved editor contents on the host.
  if (unique.length) return { type: "dropFiles", uris: unique, files: [] };
  const files = [];
  for (const file of Array.from(data.files)) {
    if (file.size > 150_000)
      throw new Error(
        `${file.name} exceeds 150 KB. Attach a selection instead.`,
      );
    const content = new TextDecoder("utf-8", { fatal: true }).decode(
      await file.arrayBuffer(),
    );
    if (content.includes("\0"))
      throw new Error("Binary files cannot be attached as text.");
    files.push({ name: file.name, content });
  }
  if (!files.length)
    throw new Error("Drop text files from Explorer or your file manager.");
  if (files.reduce((size, file) => size + file.content.length, 0) > 400_000)
    throw new Error(
      "Dropped files exceed the 400,000 character attachment limit.",
    );
  return { type: "dropFiles", uris: [], files };
}
