import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export function sdkMessage(value: Record<string, unknown>): SDKMessage {
  return { uuid: '00000000-0000-4000-8000-000000000001', session_id: 'session-123', ...value } as unknown as SDKMessage;
}
export const claudeSuccess = sdkMessage({ type: 'result', subtype: 'success', is_error: false, result: 'Hello', duration_ms: 10, duration_api_ms: 5, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 }, modelUsage: {}, permission_denials: [] });
export function assistant(text: string, parent: string | null = null): SDKMessage {
  return sdkMessage({ type: 'assistant', parent_tool_use_id: parent, message: { id: 'msg-123', type: 'message', role: 'assistant', model: 'claude-sonnet', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 7 } } });
}
export function textDelta(text: string, parent: string | null = null): SDKMessage {
  return sdkMessage({ type: 'stream_event', parent_tool_use_id: parent, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
}
