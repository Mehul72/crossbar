import type { HostMessage } from "../src/shared/messages";
import type {
  Approval,
  Conversation,
  ConversationSummary,
  ProviderStatus,
} from "../src/shared/domain";
export interface State {
  chat?: Conversation;
  history: ConversationSummary[];
  providers: ProviderStatus[];
  busy: boolean;
  approvals: Approval[];
  total: number;
  error?: string;
  notice?: string;
  panel?: "settings" | "usage" | "history";
}
export const initialState: State = {
  history: [],
  providers: [],
  busy: false,
  approvals: [],
  total: 0,
};
export function reduce(state: State, event: HostMessage): State {
  switch (event.type) {
    case "state":
      return {
        ...state,
        chat: event.conversation,
        history: event.history,
        providers: event.providers,
        busy: event.busy,
        approvals: event.approvals,
        total: event.totalMessages,
      };
    case "message": {
      if (!state.chat || state.chat.id !== event.conversationId) return state;
      const exists = state.chat.messages.some(
        (message) => message.id === event.message.id,
      );
      return {
        ...state,
        total: state.total + (exists ? 0 : 1),
        chat: {
          ...state.chat,
          messages: exists
            ? state.chat.messages.map((message) =>
                message.id === event.message.id ? event.message : message,
              )
            : [...state.chat.messages, event.message],
        },
      };
    }
    case "delta":
      return !state.chat || state.chat.id !== event.conversationId
        ? state
        : {
            ...state,
            chat: {
              ...state.chat,
              messages: state.chat.messages.map((message) =>
                message.id === event.messageId
                  ? { ...message, content: message.content + event.text }
                  : message,
              ),
            },
          };
    case "attachments":
      return state.chat
        ? { ...state, chat: { ...state.chat, attachments: event.attachments } }
        : state;
    case "busy":
      return {
        ...state,
        busy: event.busy,
        ...(event.busy ? { error: undefined, notice: undefined } : {}),
      };
    case "providers":
      return { ...state, providers: event.providers };
    case "approval":
      return {
        ...state,
        approvals: [
          ...state.approvals.filter((item) => item.id !== event.approval.id),
          event.approval,
        ],
      };
    case "approvalResolved":
      return {
        ...state,
        approvals: state.approvals.filter((item) => item.id !== event.id),
      };
    case "error":
      return { ...state, error: event.message };
    case "notice":
      return { ...state, notice: event.message };
    case "panel":
      return { ...state, panel: event.panel };
    case "older":
      return state.chat
        ? {
            ...state,
            chat: {
              ...state.chat,
              messages: [
                ...event.messages.filter(
                  (item) =>
                    !state.chat!.messages.some(
                      (existing) => existing.id === item.id,
                    ),
                ),
                ...state.chat.messages,
              ],
            },
          }
        : state;
    case "composer":
      return state;
  }
}
