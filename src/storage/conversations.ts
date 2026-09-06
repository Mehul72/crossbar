import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  open,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  conversationSchema,
  type Conversation,
  type ConversationSummary,
} from "../shared/domain";

export class ConversationStore {
  private writes = new Map<string, Promise<void>>();
  constructor(
    private directory: string,
    private report: (message: string) => void,
  ) {}
  private path(id: string): string {
    return join(this.directory, `${z.string().uuid().parse(id)}.json`);
  }
  async save(conversation: Conversation): Promise<void> {
    const parsed = conversationSchema.parse(conversation);
    const data = JSON.stringify(parsed);
    const previous = this.writes.get(parsed.id);
    const write = (
      previous
        ? previous.catch((error) =>
            this.report(`Previous history write failed: ${String(error)}`),
          )
        : Promise.resolve()
    ).then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const destination = this.path(parsed.id);
      const temporary = `${destination}.${randomUUID()}.tmp`;
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(data);
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await rename(temporary, destination);
      } catch (error) {
        await unlink(temporary).catch((cleanup) =>
          this.report(`History cleanup failed: ${String(cleanup)}`),
        );
        throw error;
      }
    });
    this.writes.set(parsed.id, write);
    try {
      await write;
    } finally {
      if (this.writes.get(parsed.id) === write) this.writes.delete(parsed.id);
    }
  }
  async load(id: string): Promise<Conversation> {
    await this.writes.get(id);
    const conversation = conversationSchema.parse(
      JSON.parse(await readFile(this.path(id), "utf8")),
    );
    if (conversation.id !== id)
      throw new Error("Conversation identity does not match its file.");
    for (const message of conversation.messages)
      if (message.status === "streaming") {
        message.status = "cancelled";
        message.error =
          "VS Code closed during this response. Send a new message to continue.";
        conversation.sessions = [];
      }
    return conversation;
  }
  async list(workspace: string): Promise<ConversationSummary[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const summaries: ConversationSummary[] = [];
    for (const name of await readdir(this.directory)) {
      if (!/^[0-9a-f-]{36}\.json$/i.test(name)) continue;
      try {
        const chat = await this.load(name.slice(0, -5));
        if (chat.workspace === workspace)
          summaries.push({
            id: chat.id,
            title: chat.title,
            updatedAt: chat.updatedAt,
            workspace,
          });
      } catch {
        this.report(
          `Could not read conversation ${name}. Its file was retained for recovery.`,
        );
      }
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async rename(id: string, title: string): Promise<void> {
    const chat = await this.load(id);
    chat.title = title.trim().slice(0, 120) || "Untitled chat";
    chat.updatedAt = Date.now();
    await this.save(chat);
  }
  async delete(id: string): Promise<void> {
    await this.writes.get(id);
    try {
      await unlink(this.path(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
