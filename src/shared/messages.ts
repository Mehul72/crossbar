import { z } from "zod";
import {
  providerId,
  type Approval,
  type Attachment,
  type Conversation,
  type ConversationSummary,
  type Message,
  type ProviderId,
  type ProviderStatus,
} from "./domain";
const id = z.string().min(1).max(200);
// Forwarded verbatim into a runtime RPC, so keep it to the shape a level name can take.
const effort = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/);
export const webviewMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({
    type: z.literal("send"),
    requestId: z.string().uuid(),
    text: z.string().trim().min(1).max(100_000),
    provider: providerId,
    model: id,
    effort: effort.optional(),
    compare: z.boolean(),
    otherModel: id.optional(),
    otherEffort: effort.optional(),
  }),
  z.object({ type: z.literal("stop") }),
  z.object({ type: z.literal("new") }),
  z.object({ type: z.literal("open"), id: z.string().uuid() }),
  z.object({
    type: z.literal("rename"),
    id: z.string().uuid(),
    title: z.string().trim().min(1).max(120),
  }),
  z.object({ type: z.literal("delete"), id: z.string().uuid() }),
  z.object({ type: z.literal("connect"), provider: providerId }),
  z.object({ type: z.literal("disconnect"), provider: providerId }),
  z.object({ type: z.literal("refresh") }),
  z.object({
    type: z.literal("attach"),
    kind: z.enum([
      "current",
      "selection",
      "file",
      "diff",
      "problems",
      "editors",
    ]),
  }),
  z
    .object({
      type: z.literal("dropFiles"),
      uris: z.array(z.string().min(1).max(4096)).max(20),
      files: z
        .array(
          z.object({
            name: z
              .string()
              .min(1)
              .max(255)
              .refine(
                (name) =>
                  !/[\\/]/.test(name) &&
                  [...name].every((char) => char.charCodeAt(0) >= 32),
              ),
            content: z.string().max(150_000),
          }),
        )
        .max(20),
    })
    .refine(
      (value) =>
        value.uris.length + value.files.length > 0 &&
        value.uris.length + value.files.length <= 20,
    ),
  z.object({ type: z.literal("removeAttachment"), id }),
  z.object({ type: z.literal("summary"), provider: providerId, model: id }),
  z.object({
    type: z.literal("approve"),
    id,
    decision: z.enum(["allow", "session", "deny"]),
  }),
  z.object({
    type: z.literal("openLink"),
    target: z.string().min(1).max(4096),
  }),
  z.object({ type: z.literal("viewDiff"), messageId: id, toolId: id }),
  z.object({ type: z.literal("choose"), messageId: id }),
  z.object({
    type: z.literal("review"),
    messageId: id,
    provider: providerId,
    model: id,
  }),
  z.object({ type: z.literal("copy"), text: z.string().max(2_000_000) }),
  z.object({ type: z.literal("older"), before: z.number().int().positive() }),
]);
export type WebviewMessage = z.infer<typeof webviewMessage>;
export type HostMessage =
  | {
      type: "state";
      conversation: Conversation;
      history: ConversationSummary[];
      providers: ProviderStatus[];
      busy: boolean;
      approvals: Approval[];
      totalMessages: number;
    }
  | { type: "message"; conversationId: string; message: Message }
  | { type: "delta"; conversationId: string; messageId: string; text: string }
  | { type: "attachments"; attachments: Attachment[] }
  | { type: "providers"; providers: ProviderStatus[] }
  | { type: "busy"; busy: boolean }
  | { type: "approval"; approval: Approval }
  | { type: "approvalResolved"; id: string }
  | { type: "error"; message: string }
  | { type: "notice"; message: string }
  | {
      type: "panel";
      panel: "settings" | "usage" | "history";
      provider?: ProviderId;
    }
  | { type: "composer"; provider?: ProviderId; compare?: boolean }
  | { type: "older"; messages: Message[] };
