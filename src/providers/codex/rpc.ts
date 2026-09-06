import { z } from "zod";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { JsonLines, stopProcess } from "../runtime";
const frameSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});
export type RpcFrame = z.infer<typeof frameSchema>;
export class RpcClient {
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve: (data: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private listeners = new Set<(frame: RpcFrame) => void>();
  private closeListeners = new Set<(error: Error) => void>();
  private failure?: Error;
  constructor(
    private child: ChildProcessWithoutNullStreams,
    private timeoutMs = 30_000,
  ) {
    const lines = new JsonLines((value) =>
      this.receive(frameSchema.parse(value)),
    );
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        lines.push(chunk);
      } catch {
        this.fail(
          new Error("Codex sent a malformed protocol message. Restart Codex."),
        );
      }
    });
    child.stdout.on("end", () => {
      try {
        lines.end();
      } catch {
        this.fail(new Error("Codex ended with an incomplete message."));
      }
    });
    child.stderr.resume();
    child.stdin.on("error", () =>
      this.fail(new Error("Codex input stream closed. Reconnect Codex.")),
    );
    child.on("error", (error: NodeJS.ErrnoException) =>
      this.fail(
        new Error(
          error.code === "ENOENT"
            ? "Codex is not installed or not on PATH. Set crossbar.codexPath."
            : "Codex could not start. Check its executable path.",
        ),
      ),
    );
    child.on("close", (code) =>
      this.fail(
        new Error(
          `Codex exited (${code ?? "signal"}). Reconnect and retry; the chat is saved.`,
        ),
      ),
    );
  }
  get alive(): boolean {
    return !this.failure;
  }
  onFrame(listener: (frame: RpcFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onClose(listener: (error: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
  request(method: string, params: unknown): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`Codex ${method} timed out. Reconnect before retrying.`),
        );
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }
  notify(method: string, params: unknown = {}): void {
    this.write({ method, params });
  }
  reply(id: string | number, result: unknown): void {
    this.write({ id, result });
  }
  reject(id: string | number): void {
    this.write({
      id,
      error: {
        code: -32601,
        message: "Crossbar does not support this request.",
      },
    });
  }
  dispose(): void {
    this.fail(new Error("Codex connection closed."));
  }
  private write(frame: object): void {
    if (this.failure) return;
    this.child.stdin.write(`${JSON.stringify(frame)}\n`, (error) => {
      if (error) this.fail(new Error("Codex transport write failed."));
    });
  }
  private receive(frame: RpcFrame): void {
    if (frame.method) {
      for (const listener of this.listeners) listener(frame);
      return;
    }
    const pending =
      typeof frame.id === "number" ? this.pending.get(frame.id) : undefined;
    if (!pending) return;
    this.pending.delete(frame.id as number);
    clearTimeout(pending.timer);
    if (frame.error)
      pending.reject(
        new Error(
          `Codex request failed (${frame.error.code}). Check authentication, model availability and runtime status.`,
        ),
      );
    else if ("result" in frame) pending.resolve(frame.result);
    else pending.reject(new Error("Codex response omitted its result."));
  }
  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of this.closeListeners) listener(error);
    this.closeListeners.clear();
    this.listeners.clear();
    stopProcess(this.child);
  }
}
