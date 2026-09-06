import type {
  Attachment,
  Conversation,
  Message,
  Provider,
  ProviderId,
  ProviderStatus,
} from "../shared/domain";
import type { HostMessage } from "../shared/messages";
import { ConversationStore } from "../storage/conversations";
import {
  chooseComparison,
  continueFromSummary,
  createConversation,
  createMessage,
  summaryPrompt,
  syncPrompt,
} from "./context";
import { verifyClaims } from "../verification/claims";
import { errorMessage } from "../providers/runtime";

export interface GenerationTarget {
  provider: ProviderId;
  model: string;
  effort?: string;
}
export class ChatEngine {
  chat: Conversation;
  statuses: ProviderStatus[] = [];
  private controller?: AbortController;
  constructor(
    private store: ConversationStore,
    readonly providers: Map<ProviderId, Provider>,
    workspace: string,
    private emit: (event: HostMessage) => void,
    private timeout: () => number,
  ) {
    this.chat = createConversation(workspace);
  }
  get busy(): boolean {
    return !!this.controller;
  }
  assertIdle(): void {
    if (this.busy)
      throw new Error(
        "Stop the current generation before changing this conversation.",
      );
  }
  async initialize(lastId?: string): Promise<void> {
    if (lastId) {
      try {
        const chat = await this.store.load(lastId);
        if (chat.workspace === this.chat.workspace) this.chat = chat;
      } catch {
        this.emit({
          type: "notice",
          message:
            "The previous conversation could not be reopened. Its file was retained.",
        });
      }
    }
    await this.state();
  }
  async state(): Promise<void> {
    this.emit({
      type: "state",
      conversation: {
        ...this.chat,
        sessions: [],
        messages: this.chat.messages.slice(-80),
      },
      history: await this.store.list(this.chat.workspace),
      providers: this.statuses,
      busy: this.busy,
      approvals: [],
      totalMessages: this.chat.messages.length,
    });
  }
  async refresh(): Promise<void> {
    const settled = await Promise.allSettled(
      [...this.providers.values()].map((provider) => provider.status()),
    );
    this.statuses = settled.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    this.emit({ type: "providers", providers: this.statuses });
  }
  async newChat(): Promise<void> {
    this.assertIdle();
    this.chat = createConversation(this.chat.workspace);
    await this.store.save(this.chat);
    await this.state();
  }
  async open(id: string): Promise<void> {
    this.assertIdle();
    const chat = await this.store.load(id);
    if (chat.workspace !== this.chat.workspace)
      throw new Error("This conversation belongs to another workspace.");
    this.chat = chat;
    await this.state();
  }
  async rename(id: string, title: string): Promise<void> {
    this.assertIdle();
    await this.store.rename(id, title);
    if (id === this.chat.id) this.chat.title = title;
    await this.state();
  }
  async delete(id: string): Promise<void> {
    this.assertIdle();
    await this.store.delete(id);
    if (id === this.chat.id)
      this.chat = createConversation(this.chat.workspace);
    await this.state();
  }
  async attach(attachments: Attachment[]): Promise<void> {
    this.assertIdle();
    const combined = [...this.chat.attachments, ...attachments];
    if (
      combined.length > 20 ||
      combined.reduce((sum, item) => sum + item.content.length, 0) > 400_000
    )
      throw new Error(
        "Attachment limit reached (20 items or 400,000 characters). Remove an attachment first.",
      );
    this.chat.attachments = combined;
    await this.store.save(this.chat);
    this.emit({ type: "attachments", attachments: combined });
  }
  async removeAttachment(id: string): Promise<void> {
    this.assertIdle();
    this.chat.attachments = this.chat.attachments.filter(
      (item) => item.id !== id,
    );
    await this.store.save(this.chat);
    this.emit({ type: "attachments", attachments: this.chat.attachments });
  }
  async choose(id: string): Promise<void> {
    this.assertIdle();
    chooseComparison(this.chat, id);
    await this.store.save(this.chat);
    await this.state();
  }
  stop(): void {
    this.controller?.abort();
  }
  dispose(): void {
    this.stop();
    for (const provider of this.providers.values()) provider.dispose();
  }
  private begin(): { controller: AbortController; timer: NodeJS.Timeout } {
    this.assertIdle();
    const controller = new AbortController();
    this.controller = controller;
    this.emit({ type: "busy", busy: true });
    const timer = setTimeout(
      () => controller.abort(new Error("Generation timed out.")),
      this.timeout(),
    );
    return { controller, timer };
  }
  private end(timer: NodeJS.Timeout): void {
    clearTimeout(timer);
    this.controller = undefined;
    this.emit({ type: "busy", busy: false });
  }
  async send(
    requestId: string,
    text: string,
    target: GenerationTarget,
    other?: Omit<GenerationTarget, "provider">,
    modelReview = false,
  ): Promise<void> {
    this.assertIdle();
    if (this.chat.messages.some((message) => message.id === requestId)) return;
    const { controller, timer } = this.begin();
    try {
      const user = createMessage("user", text);
      user.id = requestId;
      user.attachments = [...this.chat.attachments];
      if (!this.chat.messages.length && this.chat.title === "New chat")
        this.chat.title = text.replace(/\s+/g, " ").slice(0, 72);
      this.chat.messages.push(user);
      this.chat.attachments = [];
      this.chat.updatedAt = Date.now();
      await this.store.save(this.chat);
      this.emit({
        type: "message",
        conversationId: this.chat.id,
        message: user,
      });
      this.emit({ type: "attachments", attachments: [] });
      const targets: GenerationTarget[] = [target];
      if (other)
        targets.push({
          ...other,
          provider: target.provider === "codex" ? "claude" : "codex",
        });
      const promptSnapshot = structuredClone(this.chat);
      const tasks = targets.map((each) =>
        this.generate(
          promptSnapshot,
          each,
          controller.signal,
          other ? requestId : undefined,
          modelReview,
        ),
      );
      const results = await Promise.allSettled(tasks);
      for (const result of results)
        if (result.status === "rejected")
          this.emit({ type: "error", message: errorMessage(result.reason) });
      if (other) this.chat.sessions = [];
      this.chat.updatedAt = Date.now();
      await this.store.save(this.chat);
    } finally {
      this.end(timer);
    }
  }
  private async generate(
    snapshot: Conversation,
    target: GenerationTarget,
    signal: AbortSignal,
    compareGroup?: string,
    modelReview = false,
  ): Promise<void> {
    const { provider: providerId, model, effort } = target;
    const message = createMessage("assistant", "");
    Object.assign(message, {
      provider: providerId,
      model,
      effort,
      compareGroup,
      modelReview,
    });
    this.chat.messages.push(message);
    const publish = () =>
      this.emit({
        type: "message",
        conversationId: this.chat.id,
        message: structuredClone(message),
      });
    publish();
    let pending = "";
    const flush = () => {
      if (pending) {
        this.emit({
          type: "delta",
          conversationId: this.chat.id,
          messageId: message.id,
          text: pending,
        });
        pending = "";
      }
    };
    const deltas = setInterval(flush, 40);
    const checkpoints = setInterval(() => {
      void this.store.save(this.chat).catch((error) => {
        this.emit({
          type: "error",
          message: `Could not save chat: ${errorMessage(error)}`,
        });
        this.stop();
      });
    }, 1500);
    let session = snapshot.sessions.find(
      (item) => item.provider === providerId,
    );
    try {
      const provider = this.providers.get(providerId);
      if (!provider) throw new Error("This provider is unavailable.");
      if (
        this.statuses.find((status) => status.id === providerId)?.state !==
        "connected"
      )
        throw new Error(
          `Connect ${providerId} in Provider Settings before sending.`,
        );
      if (
        session?.syncedThrough &&
        !snapshot.messages.some((item) => item.id === session?.syncedThrough)
      )
        session = undefined;
      const prompt = syncPrompt(snapshot, session);
      let sessionId = session?.id;
      for await (const event of provider.send(
        { prompt, model, effort, sessionId, cwd: snapshot.workspace },
        signal,
      )) {
        signal.throwIfAborted();
        if (event.type === "text") {
          if (message.content.length + event.text.length > 2_000_000)
            throw new Error("Response exceeded the local size limit.");
          message.content += event.text;
          pending += event.text;
        } else {
          flush();
          if (event.type === "session") sessionId = event.id;
          if (event.type === "model") message.model = event.model;
          if (event.type === "usage") {
            message.usage = { ...message.usage, ...event.usage };
            if (event.usage.quota) {
              this.statuses = this.statuses.map((status) =>
                status.id === providerId
                  ? { ...status, usage: { ...status.usage, ...event.usage } }
                  : status,
              );
              this.emit({ type: "providers", providers: this.statuses });
            }
          }
          if (event.type === "tool") {
            const index = message.tools.findIndex(
              (tool) => tool.id === event.tool.id,
            );
            if (index < 0) message.tools.push(event.tool);
            else
              message.tools[index] = {
                ...message.tools[index]!,
                ...event.tool,
                title:
                  event.tool.title === "Tool result"
                    ? message.tools[index]!.title
                    : event.tool.title,
              };
          }
          if (event.type === "notice")
            this.emit({ type: "notice", message: event.text });
          publish();
        }
      }
      signal.throwIfAborted();
      message.status = "completed";
      if (sessionId && !compareGroup) {
        this.chat.sessions = this.chat.sessions.filter(
          (item) => item.provider !== providerId,
        );
        this.chat.sessions.push({
          provider: providerId,
          model: message.model ?? model,
          id: sessionId,
          syncedThrough: message.id,
        });
      }
      message.verification = verifyClaims(message.content, message.tools);
    } catch (error) {
      message.status = signal.aborted ? "cancelled" : "failed";
      message.error = signal.aborted
        ? errorMessage(signal.reason) === "Generation timed out."
          ? "Generation timed out. Your partial response is saved."
          : "Generation stopped. Your partial response is saved."
        : errorMessage(error);
      this.chat.sessions = this.chat.sessions.filter(
        (item) => item.provider !== providerId,
      );
    } finally {
      clearInterval(deltas);
      clearInterval(checkpoints);
      flush();
      publish();
    }
  }
  async summarise(providerId: ProviderId, model: string): Promise<void> {
    if (!this.chat.messages.length)
      throw new Error("Start a conversation before creating a summary.");
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error("Provider unavailable.");
    const source = structuredClone(this.chat);
    const { controller, timer } = this.begin();
    try {
      let summary = "";
      for await (const event of provider.send(
        {
          cwd: source.workspace,
          model,
          prompt: summaryPrompt(source),
          readOnly: true,
        },
        controller.signal,
      ))
        if (event.type === "text") {
          summary += event.text;
          if (summary.length > 100_000)
            throw new Error("Summary exceeded its size limit.");
        }
      controller.signal.throwIfAborted();
      const next = continueFromSummary(source, summary);
      await this.store.save(next);
      this.chat = next;
    } finally {
      this.end(timer);
      await this.state();
    }
  }
  older(before: number): void {
    this.emit({
      type: "older",
      messages: this.chat.messages.slice(Math.max(0, before - 80), before),
    });
  }
  findMessage(id: string): Message {
    const message = this.chat.messages.find((message) => message.id === id);
    if (!message) throw new Error("Message no longer exists.");
    return message;
  }
}
