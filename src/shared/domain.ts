import { z } from "zod";

export const providerId = z.enum(["codex", "claude"]);
export type ProviderId = z.infer<typeof providerId>;
export const attachmentSchema = z.object({
  id: z.string(),
  kind: z.enum(["file", "selection", "diff", "problems", "capsule"]),
  name: z.string(),
  content: z.string(),
  sourceId: z.string().optional(),
  createdAt: z.number(),
});
export type Attachment = z.infer<typeof attachmentSchema>;
export const toolSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["running", "completed", "failed"]),
  output: z.string().optional(),
  command: z.string().optional(),
  exitCode: z.number().optional(),
  diff: z.string().optional(),
});
export type ToolActivity = z.infer<typeof toolSchema>;
export const claimSchema = z.object({
  claim: z.string(),
  status: z.enum(["verified", "conflicting", "unverified"]),
  evidence: z.string(),
});
export type Claim = z.infer<typeof claimSchema>;
export const usageSchema = z.object({
  observedAt: z.number(),
  source: z.literal("provider"),
  quota: z
    .array(
      z.object({
        name: z.string(),
        remaining: z.number(),
        resetsAt: z.number().optional(),
      }),
    )
    .optional(),
  context: z.object({ used: z.number(), limit: z.number() }).optional(),
  tokens: z.object({ input: z.number(), output: z.number() }).optional(),
});
export type Usage = z.infer<typeof usageSchema>;
export const messageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  createdAt: z.number(),
  provider: providerId.optional(),
  model: z.string().optional(),
  status: z.enum(["streaming", "completed", "failed", "cancelled"]),
  error: z.string().optional(),
  attachments: z.array(attachmentSchema).default([]),
  tools: z.array(toolSchema).default([]),
  verification: z.array(claimSchema).default([]),
  usage: usageSchema.optional(),
  compareGroup: z.string().optional(),
  excluded: z.boolean().optional(),
  modelReview: z.boolean().optional(),
});
export type Message = z.infer<typeof messageSchema>;
export const sessionSchema = z.object({
  provider: providerId,
  id: z.string(),
  model: z.string(),
  syncedThrough: z.string().optional(),
});
export type Session = z.infer<typeof sessionSchema>;
export const conversationSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  workspace: z.string(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  messages: z.array(messageSchema),
  sessions: z.array(sessionSchema),
  attachments: z.array(attachmentSchema),
  sourceId: z.string().optional(),
});
export type Conversation = z.infer<typeof conversationSchema>;
export type ConversationSummary = Pick<
  Conversation,
  "id" | "title" | "updatedAt" | "workspace"
>;
export interface Model {
  id: string;
  name: string;
}
export interface Capabilities {
  models: boolean;
  resume: boolean;
  quota: boolean;
  context: boolean;
  tools: boolean;
  diffs: boolean;
  approvals: boolean;
  cancellation: boolean;
}
export interface ProviderStatus {
  id: ProviderId;
  state: "connected" | "disconnected" | "missing" | "error";
  detail: string;
  models: Model[];
  capabilities: Capabilities;
  usage?: Usage;
}
export interface Approval {
  id: string;
  provider: ProviderId;
  title: string;
  detail: string;
  choices: ("allow" | "session" | "deny")[];
}
export type Decision = Approval["choices"][number];
export type ProviderEvent =
  | { type: "text"; text: string }
  | { type: "session"; id: string }
  | { type: "model"; model: string }
  | { type: "tool"; tool: ToolActivity }
  | { type: "usage"; usage: Usage }
  | { type: "notice"; text: string };
export interface ProviderInput {
  prompt: string;
  model: string;
  sessionId?: string;
  cwd: string;
  readOnly?: boolean;
}
export interface Provider {
  id: ProviderId;
  status(): Promise<ProviderStatus>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(input: ProviderInput, signal: AbortSignal): AsyncIterable<ProviderEvent>;
  dispose(): void;
}
export type Approve = (
  approval: Approval,
  signal: AbortSignal,
) => Promise<Decision>;
