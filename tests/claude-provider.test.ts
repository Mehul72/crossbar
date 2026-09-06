import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeProvider, assertSubscription, claudeEvents, resultReason, subscriptionEnvironment } from '../src/providers/claude/provider';
import { EventQueue, run } from '../src/providers/runtime';
import type { Approve, Decision, ProviderEvent } from '../src/shared/domain';
import { assistant, claudeSuccess, sdkMessage, textDelta } from './fixtures/claude-events';

vi.mock('../src/providers/runtime', async importOriginal => ({ ...await importOriginal<typeof import('../src/providers/runtime')>(), run: vi.fn() }));

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> { const values: T[] = []; for await (const value of source) values.push(value); return values; }
const text = (events: ProviderEvent[]) => events.filter(event => event.type === 'text').map(event => event.text).join('');

describe('subscription safeguards', () => {
  it.each(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'])('rejects active %s without disclosing its value', key => {
    expect(() => subscriptionEnvironment({ [key]: 'private-credential' })).toThrow(key);
    try { subscriptionEnvironment({ [key]: 'private-credential' }); } catch (error) { expect(String(error)).not.toContain('private-credential'); }
  });
  it('preserves the original environment while disabling extra runtime facilities', () => {
    const env = { PATH: '/bin', ANTHROPIC_API_KEY: '' };
    expect(subscriptionEnvironment(env)).toMatchObject({ PATH: '/bin', CLAUDE_CODE_DISABLE_FAST_MODE: '1', CLAUDE_CODE_DISABLE_1M_CONTEXT: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' });
    expect(env).toEqual({ PATH: '/bin', ANTHROPIC_API_KEY: '' });
  });
  it.each([{}, { loggedIn: false }, { loggedIn: true, authMethod: 'api-key' }, { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'bedrock' }])('rejects a non-subscription authentication record %j', account => { expect(() => assertSubscription(account)).toThrow(); });
  it('accepts the official authenticated subscription record', () => { expect(() => assertSubscription({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'pro' })).not.toThrow(); });
});

describe('claudeEvents', () => {
  it('deduplicates streamed main text, suppresses nested text, and resets dedup for the next response', () => {
    const streamed = new Set<string>();
    const events = [textDelta('Hel'), textDelta('lo'), textDelta('private subagent', 'tool-1'), assistant('private subagent', 'tool-1'), assistant('Hello'), assistant('Next')].flatMap(message => claudeEvents(message, streamed));
    expect(text(events)).toBe('HelloNext');
    expect(streamed.size).toBe(0);
    expect(events).toContainEqual({ type: 'session', id: 'session-123' });
  });
  it('reports model initialization, compaction, tool inputs/results, and cache-inclusive token usage', () => {
    const messages = [sdkMessage({ type: 'system', subtype: 'init', model: 'opus' }), sdkMessage({ type: 'system', subtype: 'compact_boundary' }), sdkMessage({ type: 'assistant', parent_tool_use_id: null, message: { model: 'opus', content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'source.ts', token: 'sk-secret123' } }] } }), sdkMessage({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', is_error: false, content: 'file contents' }] } }), claudeSuccess];
    const events = messages.flatMap(message => claudeEvents(message, new Set()));
    expect(events).toContainEqual({ type: 'model', model: 'opus' });
    expect(events.some(event => event.type === 'notice' && event.text.includes('compacted'))).toBe(true);
    const tools = events.filter(event => event.type === 'tool');
    expect(tools[0]?.tool).toMatchObject({ id: 'tool-1', title: 'Read', status: 'running' });
    expect(tools[0]?.tool.output).not.toContain('sk-secret123');
    expect(tools[1]?.tool).toMatchObject({ id: 'tool-1', status: 'completed', output: 'file contents' });
    expect(events.find(event => event.type === 'usage')?.usage.tokens).toEqual({ input: 35, output: 7 });
  });
  it('marks failed tool results and rejects assistant and turn-level failures', () => {
    const events = claudeEvents(sdkMessage({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'bad', is_error: true, content: [{ type: 'text', text: 'failed' }] }] } }), new Set());
    expect(events.find(event => event.type === 'tool')?.tool.status).toBe('failed');
    expect(() => claudeEvents(sdkMessage({ type: 'assistant', error: 'rate_limit', message: { model: 'sonnet', content: [] } }), new Set())).toThrow('rate limit');
    expect(() => claudeEvents(sdkMessage({ type: 'result', subtype: 'error_during_execution', is_error: true }), new Set())).toThrow('could not finish');
  });
  it('names why a turn stopped instead of only advising', () => {
    expect(() => claudeEvents(sdkMessage({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['tool loop detected'] }), new Set())).toThrow('error max turns tool loop detected');
    expect(() => claudeEvents(sdkMessage({ type: 'result', subtype: 'success', is_error: true, result: 'Usage limit reached. Resets at 15:49.' }), new Set())).toThrow('Usage limit reached. Resets at 15:49.');
  });
  it('redacts secrets from a failure reason and advises when none is given', () => {
    expect(resultReason({ subtype: 'success', result: 'rejected sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' })).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(resultReason({ subtype: 'success' })).toContain('Check subscription limits');
  });
});

describe('ClaudeProvider', () => {
  let provider: ClaudeProvider;
  let calls: Parameters<typeof query>[0][];
  let messages: SDKMessage[];
  let account: { apiProvider?: string; apiKeySource?: string };
  let accountInfo: ReturnType<typeof vi.fn>;
  let supportedModels: ReturnType<typeof vi.fn>;
  let close: ReturnType<typeof vi.fn>;
  let login: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let approve: ReturnType<typeof vi.fn<Approve>>;
  let log: ReturnType<typeof vi.fn<(text: string) => void>>;
  let stream: EventQueue<SDKMessage> | undefined;
  const input = { cwd: '/workspace', model: 'sonnet', prompt: 'private prompt' };
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(process.env)) if (key.startsWith('CLAUDE_CODE_USE_') || ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'].includes(key)) vi.stubEnv(key, undefined);
    vi.mocked(run).mockResolvedValue(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'pro' }));
    calls = []; messages = [assistant('Hello'), claudeSuccess]; account = { apiProvider: 'firstParty', apiKeySource: 'oauth' }; stream = undefined;
    accountInfo = vi.fn(async () => account);
    supportedModels = vi.fn(async () => [{ value: 'sonnet', displayName: 'Sonnet' }]);
    close = vi.fn(() => stream?.close()); login = vi.fn(async () => {}); approve = vi.fn<Approve>(async (): Promise<Decision> => 'allow'); log = vi.fn();
    const factory = ((args: Parameters<typeof query>[0]) => {
      calls.push(args);
      return { accountInfo, supportedModels, close, async *[Symbol.asyncIterator]() { if (stream) yield* stream; else yield* messages; } };
    }) as unknown as typeof query;
    provider = new ClaudeProvider(() => '/bin/claude', () => '/workspace', factory, approve, login, log);
  });
  afterEach(() => { provider.dispose(); vi.unstubAllEnvs(); });

  it('discovers account models without submitting prompts and caches discovery while rechecking auth', async () => {
    expect(await provider.status()).toMatchObject({ state: 'connected', models: [{ id: 'sonnet', name: 'Sonnet' }] });
    expect(await collect(calls[0]!.prompt as AsyncIterable<SDKUserMessage>)).toEqual([]);
    await provider.status();
    expect(calls).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('returns runtime aliases when model discovery fails and reports the failure', async () => {
    supportedModels.mockRejectedValue(new Error('discovery unavailable'));
    const status = await provider.status();
    expect(status.state).toBe('connected');
    expect(status.models.map(model => model.id)).toEqual(['default', 'sonnet', 'opus']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('discovery unavailable'));
    expect(close).toHaveBeenCalled();
  });
  it('reports missing runtime and malformed auth without starting a query', async () => {
    vi.mocked(run).mockRejectedValueOnce(new Error('claude is not installed'));
    expect((await provider.status()).state).toBe('missing');
    vi.mocked(run).mockResolvedValueOnce('not json');
    expect((await provider.status()).state).toBe('disconnected');
    expect(calls).toEqual([]);
  });
  it('disconnects locally and reconnects through the official login only when necessary', async () => {
    await provider.disconnect();
    expect((await provider.status()).state).toBe('disconnected');
    await expect(collect(provider.send(input, new AbortController().signal))).rejects.toThrow('Connect Claude');
    expect(run).not.toHaveBeenCalled();
    vi.mocked(run).mockRejectedValueOnce(new Error('not logged in'));
    await provider.connect();
    expect(login).toHaveBeenCalledTimes(1);
    await provider.connect();
    expect(login).toHaveBeenCalledTimes(1);
  });
  it('validates SDK authentication before enqueuing a prompt and forwards model, resume, and read-only options', async () => {
    let validate!: () => void;
    accountInfo.mockImplementation(() => new Promise(resolve => { validate = () => resolve(account); }));
    const pending = collect(provider.send({ ...input, model: 'default', sessionId: 'previous', readOnly: true }, new AbortController().signal));
    await vi.waitFor(() => expect(accountInfo).toHaveBeenCalled());
    const call = calls[0]!;
    const iterator = (call.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
    let delivered = false;
    const first = iterator.next().then(value => { delivered = true; return value; });
    await Promise.resolve(); expect(delivered).toBe(false);
    validate();
    const events = await pending;
    expect(text(events)).toBe('Hello');
    expect((await first).value).toMatchObject({ type: 'user', session_id: 'previous', message: { content: input.prompt } });
    expect(call.options).toMatchObject({ model: undefined, resume: 'previous', tools: [], permissionMode: 'default', settingSources: [], settings: { disableAllHooks: true }, strictMcpConfig: true, mcpServers: {} });
    expect(close).toHaveBeenCalledTimes(1);
    expect((await iterator.next()).done).toBe(true);
  });
  it.each([{ apiProvider: 'bedrock', apiKeySource: 'oauth' }, { apiProvider: 'firstParty', apiKeySource: 'api_key' }])('blocks SDK billing credentials %j before delivering any user prompt', async credentials => {
    account = credentials;
    await expect(collect(provider.send(input, new AbortController().signal))).rejects.toThrow('before sending your prompt');
    expect(await collect(calls[0]!.prompt as AsyncIterable<SDKUserMessage>)).toEqual([]);
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('rejects CLI API authentication before creating the SDK query', async () => {
    vi.mocked(run).mockResolvedValue(JSON.stringify({ loggedIn: true, authMethod: 'api-key' }));
    await expect(collect(provider.send(input, new AbortController().signal))).rejects.toThrow('API and cloud-provider billing');
    expect(calls).toEqual([]);
  });
  it('routes tool decisions with redacted input and does not turn session approval into automatic permission', async () => {
    await collect(provider.send(input, new AbortController().signal));
    const permission = calls[0]!.options!.canUseTool!;
    const signal = new AbortController().signal;
    const options = { signal, toolUseID: 'tool', requestId: 'request-1', title: 'Run command' };
    const toolInput = { command: 'echo sk-secret123' };
    expect(await permission('Bash', toolInput, options)).toEqual({ behavior: 'allow', updatedInput: toolInput });
    expect(approve.mock.calls[0]?.[0]).toMatchObject({ provider: 'claude', title: 'Run command', choices: ['allow', 'deny'] });
    expect(approve.mock.calls[0]?.[0].detail).not.toContain('sk-secret123');
    approve.mockResolvedValueOnce('deny');
    expect(await permission('Bash', toolInput, options)).toMatchObject({ behavior: 'deny' });
  });
  it('closes the query when the runtime ends without a final result', async () => {
    messages = [textDelta('partial')];
    await expect(collect(provider.send(input, new AbortController().signal))).rejects.toThrow('exited before completing');
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('closes the active query and propagates cancellation without starting a replacement', async () => {
    stream = new EventQueue<SDKMessage>();
    const controller = new AbortController();
    const pending = collect(provider.send(input, controller.signal));
    const rejection = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(accountInfo).toHaveBeenCalled());
    stream.push(textDelta('partial'));
    controller.abort();
    await rejection;
    expect(calls).toHaveLength(1);
    expect(close).toHaveBeenCalled();
    expect(calls[0]?.options?.abortController?.signal.aborted).toBe(true);
  });
  it('does not launch a query for a request already cancelled', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(collect(provider.send(input, controller.signal))).rejects.toThrow();
    expect(run).not.toHaveBeenCalled(); expect(calls).toEqual([]);
  });
});
