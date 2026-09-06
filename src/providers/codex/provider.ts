import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  Approve,
  Capabilities,
  Model,
  Provider,
  ProviderEvent,
  ProviderInput,
  ProviderStatus,
  Usage,
} from "../../shared/domain";
import { EventQueue, errorMessage, redact, startProcess } from "../runtime";
import { RpcClient, type RpcFrame } from "./rpc";

const object = z.record(z.string(), z.unknown());
const record = (value: unknown): Record<string, unknown> => object.parse(value);
const string = (value: unknown): string => z.string().parse(value);
const capabilities: Capabilities = {
  models: true,
  resume: true,
  quota: true,
  context: true,
  tools: true,
  diffs: true,
  approvals: true,
  cancellation: true,
};
const rateWindow = z.object({
  usedPercent: z.number(),
  resetsAt: z.number().nullable().optional(),
});
export function codexQuota(value: unknown): Usage {
  const limits = z
    .object({
      primary: rateWindow.nullable().optional(),
      secondary: rateWindow.nullable().optional(),
    })
    .parse(value);
  return {
    observedAt: Date.now(),
    source: "provider",
    quota: Object.entries(limits).flatMap(([name, window]) =>
      window
        ? [
            {
              name,
              remaining: Math.max(0, Math.min(100, 100 - window.usedPercent)),
              resetsAt: window.resetsAt ? window.resetsAt * 1000 : undefined,
            },
          ]
        : [],
    ),
  };
}
const turnError = z.object({
  message: z.string(),
  additionalDetails: z.string().nullable().optional(),
});
// Codex reports why a turn failed; without it the user cannot tell a usage limit
// from a network fault, so pass the runtime's own wording through redaction.
export function turnErrorReason(value: unknown): string {
  const parsed = turnError.safeParse(value);
  if (!parsed.success)
    return "Check usage limits, authentication, network and model availability.";
  const { message, additionalDetails } = parsed.data;
  return redact([message, additionalDetails].filter(Boolean).join(" ")).slice(
    0,
    2000,
  );
}
export class CodexProvider implements Provider {
  readonly id = "codex" as const;
  private rpc?: RpcClient;
  private starting?: Promise<RpcClient>;
  private usage?: Usage;
  private active = new Map<
    string,
    { queue: EventQueue<ProviderEvent>; signal: AbortSignal; turnId?: string }
  >();
  private loginId?: string;
  constructor(
    private executable: () => string,
    private cwd: () => string,
    private approve: Approve,
    private openUrl: (url: string) => Promise<void>,
    private log: (text: string) => void,
  ) {}
  private client(): Promise<RpcClient> {
    if (this.rpc?.alive) return Promise.resolve(this.rpc);
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  private async start(): Promise<RpcClient> {
    const rpc = new RpcClient(
      startProcess(this.executable(), ["app-server"], this.cwd()),
    );
    rpc.onFrame((frame) => {
      void this.handle(frame, rpc).catch((error) => {
        this.log(errorMessage(error));
        for (const active of this.active.values())
          active.queue.fail(
            new Error(
              "Codex sent an unsupported or malformed event. Reconnect Codex.",
            ),
          );
        rpc.dispose();
      });
    });
    rpc.onClose((error) => {
      for (const active of this.active.values()) active.queue.fail(error);
    });
    try {
      await rpc.request("initialize", {
        clientInfo: { name: "crossbar", title: "Crossbar", version: "0.1.0" },
        capabilities: { experimentalApi: false },
      });
      rpc.notify("initialized");
      this.rpc = rpc;
      return rpc;
    } catch (error) {
      rpc.dispose();
      throw error;
    }
  }
  async status(): Promise<ProviderStatus> {
    try {
      const rpc = await this.client();
      const account = record(
        await rpc.request("account/read", { refreshToken: false }),
      ).account;
      if (!account)
        return {
          id: this.id,
          state: "disconnected",
          detail: "Connect your ChatGPT account.",
          models: [],
          capabilities,
        };
      if (record(account).type !== "chatgpt")
        return {
          id: this.id,
          state: "error",
          detail:
            "Codex is not using ChatGPT subscription authentication. Connect with ChatGPT to continue.",
          models: [],
          capabilities,
        };
      const models: Model[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page++) {
        const response: {
          data: {
            id: string;
            model: string;
            displayName: string;
            hidden?: boolean;
          }[];
          nextCursor: string | null;
        } = z
          .object({
            data: z.array(
              z.object({
                id: z.string(),
                model: z.string(),
                displayName: z.string(),
                hidden: z.boolean().optional(),
              }),
            ),
            nextCursor: z.string().nullable(),
          })
          .parse(
            await rpc.request("model/list", {
              cursor,
              limit: 100,
              includeHidden: false,
            }),
          );
        models.push(
          ...response.data
            .filter((model) => !model.hidden)
            .map((model) => ({ id: model.model, name: model.displayName })),
        );
        cursor = response.nextCursor;
        if (!cursor) break;
      }
      try {
        this.usage = codexQuota(
          record(await rpc.request("account/rateLimits/read", {})).rateLimits,
        );
      } catch (error) {
        this.log(`Codex quota unavailable: ${errorMessage(error)}`);
      }
      return {
        id: this.id,
        state: "connected",
        detail: "ChatGPT account",
        models,
        capabilities,
        usage: this.usage,
      };
    } catch (error) {
      const detail = errorMessage(error);
      return {
        id: this.id,
        state: detail.includes("not installed") ? "missing" : "error",
        detail,
        models: [],
        capabilities,
      };
    }
  }
  async connect(): Promise<void> {
    const rpc = await this.client();
    const account = record(
      await rpc.request("account/read", { refreshToken: false }),
    ).account;
    if (account && record(account).type === "chatgpt") return;
    if (this.loginId)
      await rpc.request("account/login/cancel", { loginId: this.loginId });
    const result = z
      .object({
        type: z.literal("chatgpt"),
        authUrl: z.string().url(),
        loginId: z.string(),
      })
      .parse(await rpc.request("account/login/start", { type: "chatgpt" }));
    this.loginId = result.loginId;
    const url = new URL(result.authUrl);
    if (
      url.protocol !== "https:" ||
      !["auth.openai.com", "auth0.openai.com", "chatgpt.com"].includes(
        url.hostname,
      )
    )
      throw new Error(
        "Codex returned an unexpected login URL. Use codex login in a terminal.",
      );
    await this.openUrl(result.authUrl);
  }
  async disconnect(): Promise<void> {
    try {
      if (this.rpc?.alive) await this.rpc.request("account/logout", {});
    } finally {
      this.dispose();
    }
  }
  dispose(): void {
    this.rpc?.dispose();
    this.rpc = undefined;
  }
  async *send(
    input: ProviderInput,
    signal: AbortSignal,
  ): AsyncGenerator<ProviderEvent> {
    signal.throwIfAborted();
    const rpc = await this.client();
    const account = record(
      await rpc.request("account/read", { refreshToken: false }),
    ).account;
    if (!account || record(account).type !== "chatgpt")
      throw new Error(
        "Connect Codex with your ChatGPT account before sending.",
      );
    const params = {
      cwd: input.cwd,
      model: input.model,
      approvalPolicy: "on-request",
      sandbox: input.readOnly ? "read-only" : "workspace-write",
    };
    // A failed resume is never retried as a turn: the domain reseeds a fresh session on the next explicit send.
    const response = record(
      await rpc.request(
        input.sessionId ? "thread/resume" : "thread/start",
        input.sessionId ? { ...params, threadId: input.sessionId } : params,
      ),
    );
    const threadId = string(record(response.thread).id);
    signal.throwIfAborted();
    yield { type: "session", id: threadId };
    const queue = new EventQueue<ProviderEvent>();
    const active = { queue, signal, turnId: undefined as string | undefined };
    this.active.set(threadId, active);
    const abort = () => {
      queue.fail(new Error("Generation stopped."));
      if (active.turnId)
        void rpc
          .request("turn/interrupt", { threadId, turnId: active.turnId })
          .catch(() => rpc.dispose());
      else rpc.dispose();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      const result = record(
        await rpc.request("turn/start", {
          threadId,
          model: input.model,
          input: [{ type: "text", text: input.prompt }],
        }),
      );
      active.turnId = string(record(result.turn).id);
      if (signal.aborted) abort();
      for await (const event of queue) yield event;
    } finally {
      signal.removeEventListener("abort", abort);
      this.active.delete(threadId);
    }
  }
  private async handle(frame: RpcFrame, rpc: RpcClient): Promise<void> {
    const method = frame.method;
    if (!method) return;
    const params = record(frame.params ?? {});
    if (method === "account/rateLimits/updated") {
      this.usage = codexQuota(params.rateLimits);
      return;
    }
    if (method === "account/login/completed") {
      this.loginId = undefined;
      return;
    }
    const threadId = typeof params.threadId === "string" ? params.threadId : "";
    const active = this.active.get(threadId);
    if (frame.id !== undefined) {
      if (!active) {
        rpc.reject(frame.id);
        return;
      }
      const commandApproval =
        method === "item/commandExecution/requestApproval";
      const fileApproval = method === "item/fileChange/requestApproval";
      if (!commandApproval && !fileApproval) {
        rpc.reject(frame.id);
        return;
      }
      const available = Array.isArray(params.availableDecisions)
        ? params.availableDecisions
        : ["accept", "acceptForSession", "decline"];
      const decision = await this.approve(
        {
          id: randomUUID(),
          provider: this.id,
          title: commandApproval ? "Run command" : "Modify files",
          detail: redact(
            String(
              params.command ??
                params.reason ??
                "Codex requests workspace access.",
            ),
          ),
          choices: [
            ...(available.includes("accept") ? ["allow" as const] : []),
            ...(available.includes("acceptForSession")
              ? ["session" as const]
              : []),
            "deny",
          ],
        },
        active.signal,
      );
      rpc.reply(frame.id, {
        decision:
          decision === "allow"
            ? "accept"
            : decision === "session"
              ? "acceptForSession"
              : "decline",
      });
      return;
    }
    if (!active) return;
    const { queue } = active;
    switch (method) {
      case "turn/started":
        active.turnId = string(record(params.turn).id);
        break;
      case "item/agentMessage/delta":
        queue.push({ type: "text", text: string(params.delta) });
        break;
      case "model/rerouted":
        if (typeof params.toModel === "string")
          queue.push({ type: "model", model: params.toModel });
        break;
      case "thread/compacted":
        queue.push({
          type: "notice",
          text: "Codex compacted its session context. Crossbar history is retained.",
        });
        break;
      case "thread/tokenUsage/updated": {
        const usage = z
          .object({
            last: z.object({
              totalTokens: z.number(),
              inputTokens: z.number(),
              outputTokens: z.number(),
            }),
            modelContextWindow: z.number().nullable(),
          })
          .parse(params.tokenUsage);
        queue.push({
          type: "usage",
          usage: {
            observedAt: Date.now(),
            source: "provider",
            context: usage.modelContextWindow
              ? {
                  used: usage.last.totalTokens,
                  limit: usage.modelContextWindow,
                }
              : undefined,
            tokens: {
              input: usage.last.inputTokens,
              output: usage.last.outputTokens,
            },
          },
        });
        break;
      }
      case "turn/diff/updated":
        queue.push({
          type: "tool",
          tool: {
            id: `diff-${String(params.turnId)}`,
            title: "Workspace changes",
            status: "completed",
            diff: string(params.diff),
          },
        });
        break;
      case "item/started":
      case "item/completed": {
        const item = record(params.item);
        if (
          ![
            "commandExecution",
            "fileChange",
            "mcpToolCall",
            "webSearch",
            "contextCompaction",
          ].includes(String(item.type))
        )
          break;
        queue.push({
          type: "tool",
          tool: {
            id: string(item.id),
            title: String(item.command ?? item.tool ?? item.type),
            status:
              item.status === "failed" ||
              (typeof item.exitCode === "number" && item.exitCode !== 0)
                ? "failed"
                : method === "item/started"
                  ? "running"
                  : "completed",
            command:
              typeof item.command === "string" ? item.command : undefined,
            output:
              typeof item.aggregatedOutput === "string"
                ? redact(item.aggregatedOutput).slice(-100_000)
                : undefined,
            exitCode:
              typeof item.exitCode === "number" ? item.exitCode : undefined,
          },
        });
        break;
      }
      case "error": {
        if (params.willRetry === true)
          queue.push({
            type: "notice",
            text: "Codex is retrying a provider error.",
          });
        else
          queue.fail(
            new Error(
              `Codex generation failed. ${turnErrorReason(params.error)}`,
            ),
          );
        break;
      }
      case "turn/completed": {
        const turn = record(params.turn);
        if (turn.status === "failed")
          queue.fail(
            new Error(`Codex turn failed. ${turnErrorReason(turn.error)}`),
          );
        else if (turn.status === "interrupted")
          queue.fail(new Error("Codex turn was interrupted."));
        else queue.close();
        break;
      }
    }
  }
}
