import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  query,
  EffortLevel,
  SDKMessage,
  SDKUserMessage,
  Options,
} from "@anthropic-ai/claude-agent-sdk";
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
import { EventQueue, errorMessage, redact, run } from "../runtime";

type QueryFactory = typeof query;
const capabilities: Capabilities = {
  models: true,
  resume: true,
  quota: true,
  context: false,
  tools: true,
  diffs: false,
  approvals: true,
  cancellation: true,
};
export function subscriptionEnvironment(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const blocked = Object.keys(env).filter(
    (key) =>
      env[key] &&
      ([
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
      ].includes(key) ||
        /^CLAUDE_CODE_USE_/.test(key)),
  );
  if (blocked.length)
    throw new Error(
      `Subscription-only mode: ${blocked.join(", ")} is active. Remove this configuration from the environment used to launch VS Code. Crossbar will not use API billing.`,
    );
  return {
    ...env,
    CLAUDE_AGENT_SDK_CLIENT_APP: "crossbar/0.1.0",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_FAST_MODE: "1",
    CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
  };
}
const accountSchema = z.object({
  loggedIn: z.boolean(),
  authMethod: z.string().optional(),
  apiProvider: z.string().optional(),
  subscriptionType: z.string().nullable().optional(),
});
export function assertSubscription(value: unknown): void {
  const account = accountSchema.parse(value);
  if (
    !account.loggedIn ||
    account.authMethod !== "claude.ai" ||
    (account.apiProvider && account.apiProvider !== "firstParty")
  )
    throw new Error(
      "Sign in to Claude Code with your Claude subscription. API and cloud-provider billing are disabled in Crossbar.",
    );
}
// A failed result names why it stopped; hiding that behind generic advice leaves a
// usage limit indistinguishable from a tool crash.
export function resultReason(message: {
  subtype: string;
  result?: string;
  errors?: string[];
}): string {
  const reported = [
    message.subtype === "success"
      ? undefined
      : message.subtype.replaceAll("_", " "),
    message.result,
    ...(message.errors ?? []),
  ]
    .filter((part): part is string => !!part?.trim())
    .join(" ");
  return reported
    ? redact(reported).slice(0, 2000)
    : "Check subscription limits, model availability, and runtime authentication.";
}
export function supportedEffort(
  models: Model[],
  modelId: string,
  requested: string | undefined,
): EffortLevel | undefined {
  if (!requested) return undefined;
  const offered = models.find((model) => model.id === modelId)?.efforts ?? [];
  // A match can only equal a level copied out of the SDK's own supportedEffortLevels
  // for this model, so the narrowing holds without restating the union here.
  return offered.some((option) => option.id === requested)
    ? (requested as EffortLevel)
    : undefined;
}
export function claudeEvents(
  message: SDKMessage,
  streamed: Set<string>,
): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  if ("session_id" in message && message.session_id)
    events.push({ type: "session", id: message.session_id });
  if (message.type === "system" && message.subtype === "init")
    events.push({ type: "model", model: message.model });
  if (message.type === "system" && message.subtype === "compact_boundary")
    events.push({
      type: "notice",
      text: "Claude compacted its session context. Crossbar history is retained.",
    });
  if (message.type === "stream_event") {
    const event = message.event;
    if (event.type === "message_start")
      events.push({ type: "model", model: event.message.model });
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      streamed.add(message.parent_tool_use_id ?? "main");
      if (!message.parent_tool_use_id)
        events.push({ type: "text", text: event.delta.text });
    }
  }
  if (message.type === "assistant") {
    events.push({ type: "model", model: message.message.model });
    for (const block of message.message.content) {
      if (
        block.type === "text" &&
        !message.parent_tool_use_id &&
        !streamed.has("main")
      )
        events.push({ type: "text", text: block.text });
      if (block.type === "tool_use")
        events.push({
          type: "tool",
          tool: {
            id: block.id,
            title: block.name,
            status: "running",
            output: redact(JSON.stringify(block.input)).slice(0, 100_000),
          },
        });
    }
    streamed.delete(message.parent_tool_use_id ?? "main");
    if (message.error)
      throw new Error(
        `Claude reported ${message.error.replaceAll("_", " ")}. Check your subscription, usage limits, and selected model.`,
      );
  }
  if (message.type === "user" && Array.isArray(message.message.content)) {
    for (const block of message.message.content)
      if (block.type === "tool_result")
        events.push({
          type: "tool",
          tool: {
            id: block.tool_use_id,
            title: "Tool result",
            status: block.is_error ? "failed" : "completed",
            output: redact(
              typeof block.content === "string"
                ? block.content
                : JSON.stringify(block.content),
            ).slice(-100_000),
          },
        });
  }
  if (message.type === "result") {
    if (message.is_error || message.subtype !== "success")
      throw new Error(
        `Claude could not finish the turn. ${resultReason(message)}`,
      );
    events.push({
      type: "usage",
      usage: {
        observedAt: Date.now(),
        source: "provider",
        tokens: {
          input:
            message.usage.input_tokens +
            message.usage.cache_read_input_tokens +
            message.usage.cache_creation_input_tokens,
          output: message.usage.output_tokens,
        },
      },
    });
  }
  return events;
}
const rateLimitInfo = z.object({
  status: z.enum(["allowed", "allowed_warning", "rejected"]),
  resetsAt: z.number().optional(),
  rateLimitType: z.string().optional(),
});
const windowNames: Record<string, string> = {
  five_hour: "5-hour limit",
  seven_day: "Weekly limit",
  seven_day_opus: "Weekly limit (Opus)",
  seven_day_sonnet: "Weekly limit (Sonnet)",
  seven_day_overage_included: "Weekly limit (with overage)",
  overage: "Extra usage",
};
// The runtime reports which window applies and whether it is spent, but no percentage,
// so record the state it gives rather than deriving a number it never sent.
export function claudeQuota(value: unknown): Usage | undefined {
  const parsed = rateLimitInfo.safeParse(value);
  if (!parsed.success) return undefined;
  const { status, resetsAt, rateLimitType } = parsed.data;
  return {
    observedAt: Date.now(),
    source: "provider",
    quota: [
      {
        name:
          (rateLimitType && windowNames[rateLimitType]) ??
          rateLimitType?.replaceAll("_", " ") ??
          "Rate limit",
        resetsAt: resetsAt ? resetsAt * 1000 : undefined,
        state:
          status === "rejected"
            ? "exhausted"
            : status === "allowed_warning"
              ? "warning"
              : "ok",
      },
    ],
  };
}
const planWindow = z.object({
  utilization: z.number().min(0).max(100).nullable(),
  resets_at: z.string().nullable(),
});
const planUsage = z.object({
  rate_limits_available: z.boolean(),
  rate_limits: z
    .object({
      five_hour: planWindow.nullish(),
      seven_day: planWindow.nullish(),
      seven_day_opus: planWindow.nullish(),
      seven_day_sonnet: planWindow.nullish(),
    })
    .nullable(),
});
export function claudePlanUsage(value: unknown): Usage | undefined {
  const data = planUsage.parse(value);
  if (!data.rate_limits_available || !data.rate_limits) return undefined;
  const quota = Object.entries(data.rate_limits).flatMap(([key, window]) => {
    if (!window) return [];
    const reset = window.resets_at ? Date.parse(window.resets_at) : NaN;
    return [
      {
        name: windowNames[key] ?? key,
        remaining:
          window.utilization === null ? undefined : 100 - window.utilization,
        resetsAt: Number.isFinite(reset) ? reset : undefined,
        state:
          window.utilization === null
            ? undefined
            : window.utilization >= 100
              ? ("exhausted" as const)
              : ("ok" as const),
      },
    ];
  });
  return quota.length
    ? { observedAt: Date.now(), source: "provider", quota }
    : undefined;
}
export type ClaudeConfiguration = "full" | "skills" | "isolated";
// Skills, CLAUDE.md and plugin commands all come from the on-disk setting sources;
// omitting settingSources is what makes the session behave like the CLI.
export function claudeConfigurationOptions(
  configuration: ClaudeConfiguration,
): Pick<
  Options,
  "settingSources" | "settings" | "strictMcpConfig" | "mcpServers"
> {
  if (configuration === "full") return {};
  const withoutExtensions = {
    settings: { disableAllHooks: true },
    strictMcpConfig: true,
    mcpServers: {},
  };
  return configuration === "skills"
    ? withoutExtensions
    : { ...withoutExtensions, settingSources: [] };
}
export class ClaudeProvider implements Provider {
  readonly id = "claude" as const;
  private running = new Set<ReturnType<QueryFactory>>();
  private models: Model[] = [];
  private modelsAt = 0;
  private usage?: Usage;
  private usageAttemptAt = 0;
  private disconnected = false;
  constructor(
    private executable: () => string,
    private cwd: () => string,
    private factory: QueryFactory,
    private approve: Approve,
    private login: () => Promise<void>,
    private log: (text: string) => void,
    private configuration: () => ClaudeConfiguration = () => "full",
  ) {}
  private options(controller: AbortController, cwd: string): Options {
    return {
      cwd,
      pathToClaudeCodeExecutable: this.executable(),
      abortController: controller,
      env: subscriptionEnvironment(process.env),
      permissionMode: "default",
      ...claudeConfigurationOptions(this.configuration()),
      includePartialMessages: true,
      stderr: () => {
        /* Raw runtime stderr can contain authentication payloads. */
      },
      canUseTool: async (tool, input, options) => {
        const decision = await this.approve(
          {
            id: randomUUID(),
            provider: this.id,
            title: options.title ?? tool,
            detail: redact(JSON.stringify(input, null, 2)).slice(0, 30_000),
            choices: ["allow", "deny"],
          },
          options.signal,
        );
        return decision === "allow"
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: "Denied by the user." };
      },
    };
  }
  private async checkAuth(): Promise<void> {
    const env = subscriptionEnvironment(process.env);
    let value: unknown;
    try {
      value = JSON.parse(
        await run(
          this.executable(),
          ["auth", "status", "--json"],
          this.cwd(),
          env,
        ),
      );
    } catch (error) {
      throw new Error(
        `Claude authentication check failed. ${errorMessage(error)}`,
      );
    }
    assertSubscription(value);
  }
  private async readUsage(query: ReturnType<QueryFactory>): Promise<void> {
    this.usageAttemptAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
          skipBehaviors: true,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Claude usage request timed out.")),
            10_000,
          );
        }),
      ]);
      const usage = claudePlanUsage(value);
      if (usage) this.usage = { ...this.usage, ...usage };
      else
        this.log(
          "Claude subscription percentages are unavailable from the runtime.",
        );
    } catch (error) {
      this.log(`Claude usage unavailable: ${errorMessage(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  async status(): Promise<ProviderStatus> {
    if (this.disconnected)
      return {
        id: this.id,
        state: "disconnected",
        detail:
          "Disconnected from Crossbar. Your Claude Code login is retained.",
        models: [],
        capabilities,
      };
    try {
      await this.checkAuth();
      const discoverModels =
        Date.now() - this.modelsAt > 300_000 || !this.models.length;
      if (discoverModels || Date.now() - this.usageAttemptAt >= 60_000) {
        const controller = new AbortController();
        const prompts = new EventQueue<SDKUserMessage>();
        const query = this.factory({
          prompt: prompts,
          options: this.options(controller, this.cwd()),
        });
        this.running.add(query);
        const timer = setTimeout(() => {
          controller.abort();
          query.close();
        }, 15_000);
        try {
          if (discoverModels)
            this.models = (await query.supportedModels()).map((model) => ({
              id: model.value,
              name: model.displayName,
              description: model.description,
              efforts: model.supportsEffort
                ? (model.supportedEffortLevels ?? []).map((level) => ({
                    id: level,
                    name: level.charAt(0).toUpperCase() + level.slice(1),
                  }))
                : [],
            }));
          if (discoverModels) this.modelsAt = Date.now();
          await this.readUsage(query);
        } catch (error) {
          this.log(
            `Claude model discovery unavailable: ${errorMessage(error)}`,
          );
          // Effort levels are per model and unknown without discovery, so offer none
          // rather than guess a set the selected model may reject.
          this.models = [
            { id: "default", name: "Account default", efforts: [] },
            { id: "sonnet", name: "Sonnet (runtime alias)", efforts: [] },
            { id: "opus", name: "Opus (runtime alias)", efforts: [] },
          ];
          this.modelsAt = Date.now();
        } finally {
          clearTimeout(timer);
          prompts.close();
          query.close();
          this.running.delete(query);
        }
      }
      return {
        id: this.id,
        state: "connected",
        detail: "Claude subscription · shared plan limits",
        models: this.models,
        capabilities,
        usage: this.usage,
      };
    } catch (error) {
      const detail = errorMessage(error);
      return {
        id: this.id,
        state: detail.includes("not installed") ? "missing" : "disconnected",
        detail,
        models: [],
        capabilities,
      };
    }
  }
  async connect(): Promise<void> {
    subscriptionEnvironment(process.env);
    this.disconnected = false;
    this.modelsAt = 0;
    try {
      await this.checkAuth();
    } catch {
      await this.login();
    }
  }
  async disconnect(): Promise<void> {
    this.disconnected = true;
    this.dispose();
  }
  dispose(): void {
    for (const query of this.running) query.close();
    this.running.clear();
  }
  async *send(
    input: ProviderInput,
    signal: AbortSignal,
  ): AsyncGenerator<ProviderEvent> {
    if (this.disconnected) throw new Error("Connect Claude before sending.");
    signal.throwIfAborted();
    await this.checkAuth();
    signal.throwIfAborted();
    const controller = new AbortController();
    const prompts = new EventQueue<SDKUserMessage>();
    const options = this.options(controller, input.cwd);
    // Sending a level the chosen model does not offer would be silently downgraded,
    // so drop it and let the model's own default stand.
    const effort = supportedEffort(this.models, input.model, input.effort);
    const query = this.factory({
      prompt: prompts,
      options: {
        ...options,
        model: input.model === "default" ? undefined : input.model,
        ...(effort ? { effort } : {}),
        resume: input.sessionId,
        ...(input.readOnly ? { tools: [] } : {}),
      },
    });
    this.running.add(query);
    const abort = () => {
      controller.abort();
      query.close();
      prompts.close();
    };
    signal.addEventListener("abort", abort, { once: true });
    const startup = setTimeout(abort, 30_000);
    try {
      const account = await query.accountInfo();
      if (
        (account.apiProvider && account.apiProvider !== "firstParty") ||
        (account.apiKeySource &&
          !["none", "oauth"].includes(account.apiKeySource))
      )
        throw new Error(
          "Claude selected non-subscription credentials. Crossbar stopped before sending your prompt.",
        );
      signal.throwIfAborted();
      clearTimeout(startup);
      prompts.push({
        type: "user",
        message: { role: "user", content: input.prompt },
        parent_tool_use_id: null,
        session_id: input.sessionId ?? "",
      });
      const streamed = new Set<string>();
      let completed = false;
      for await (const message of query) {
        if (message.type === "rate_limit_event") {
          const update = claudeQuota(message.rate_limit_info);
          if (update) {
            const windows = new Map(
              this.usage?.quota?.map((window) => [window.name, window]),
            );
            for (const window of update.quota ?? [])
              windows.set(window.name, window);
            this.usage = {
              ...this.usage,
              ...update,
              quota: [...windows.values()],
            };
            yield { type: "usage", usage: this.usage };
          }
        }
        for (const event of claudeEvents(message, streamed)) {
          if (event.type === "usage") {
            this.usage = { ...this.usage, ...event.usage };
            yield { type: "usage", usage: this.usage };
          } else yield event;
        }
        if (message.type === "result") {
          this.usageAttemptAt = 0;
          completed = true;
          break;
        }
      }
      if (!completed)
        throw new Error(
          "Claude exited before completing its response. Reconnect and retry; the chat is saved.",
        );
    } finally {
      clearTimeout(startup);
      signal.removeEventListener("abort", abort);
      prompts.close();
      query.close();
      this.running.delete(query);
    }
  }
}
