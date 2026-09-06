import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export function run(
  executable: string,
  args: string[],
  cwd?: string,
  env = process.env,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      { cwd, env, timeout: 15_000, maxBuffer: 2_000_000, windowsHide: true },
      (error, stdout) => {
        if (error)
          reject(
            new Error(
              error.code === "ENOENT"
                ? `${executable} is not installed or not on PATH. Configure its executable path in Crossbar settings.`
                : `${executable} failed (${error.code ?? "timeout"}). Check the runtime in a terminal.`,
            ),
          );
        else resolve(stdout);
      },
    );
  });
}
export function startProcess(
  executable: string,
  args: string[],
  cwd?: string,
): ChildProcessWithoutNullStreams {
  return spawn(executable, args, {
    cwd,
    stdio: "pipe",
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
  });
}
export function stopProcess(child: ChildProcessWithoutNullStreams): void {
  if (!child.pid) return;
  const pid = child.pid;
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH")
        child.emit("error", error);
    }
  };
  kill("SIGTERM");
  // Kill the group even after the parent exits so shell grandchildren cannot outlive the host.
  const timer = setTimeout(() => kill("SIGKILL"), 1500);
  timer.unref();
}
export class JsonLines {
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  constructor(
    private readonly receive: (value: unknown) => void,
    private readonly maxBytes = 8_000_000,
  ) {}
  push(chunk: Buffer | string): void {
    this.buffer +=
      typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (Buffer.byteLength(line) > this.maxBytes)
        throw new Error("Provider message exceeded the transport limit.");
      if (line) {
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          throw new Error(
            "Provider sent malformed JSON. Update or restart the runtime.",
          );
        }
        this.receive(value);
      }
    }
    if (Buffer.byteLength(this.buffer) > this.maxBytes)
      throw new Error("Provider message exceeded the transport limit.");
  }
  end(): void {
    this.buffer += this.decoder.end();
    if (this.buffer.trim()) this.push("\n");
  }
}
export class EventQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private wake?: () => void;
  private ended = false;
  private error?: Error;
  push(value: T): void {
    if (this.ended) return;
    if (this.values.length >= 10_000) {
      this.fail(new Error("Provider events exceeded the queue limit."));
      return;
    }
    this.values.push(value);
    this.wake?.();
  }
  close(): void {
    this.ended = true;
    this.wake?.();
  }
  fail(error: Error): void {
    this.error = error;
    this.close();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      if (this.error) throw this.error;
      const next = this.values.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
}
export function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "An unexpected operation failed.";
}
export function redact(text: string): string {
  return text
    .replace(/\b(?:sk-[\w-]+|Bearer\s+[\w.+/=-]+)\b/gi, "[redacted]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)\s*[=:]\s*)[^\s,;]+/gi,
      "$1[redacted]",
    );
}
