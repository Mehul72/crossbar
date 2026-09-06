import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeProvider, assertSubscription, claudeConfigurationOptions, claudeEvents, claudeQuota, claudePlanUsage, resultReason, subscriptionEnvironment, type ClaudeConfiguration } from '../src/providers/claude/provider';
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
  let getUsage: ReturnType<typeof vi.fn>;
  let close: ReturnType<typeof vi.fn>;
  let login: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let approve: ReturnType<typeof vi.fn<Approve>>;
  let log: ReturnType<typeof vi.fn<(text: string) => void>>;
  let factory: typeof query;
  let stream: EventQueue<SDKMessage> | undefined;
  const input = { cwd: '/workspace', model: 'sonnet', prompt: 'private prompt' };
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(process.env)) if (key.startsWith('CLAUDE_CODE_USE_') || ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'].includes(key)) vi.stubEnv(key, undefined);
    vi.mocked(run).mockResolvedValue(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'pro' }));
    calls = []; messages = [assistant('Hello'), claudeSuccess]; account = { apiProvider: 'firstParty', apiKeySource: 'oauth' }; stream = undefined;
    accountInfo = vi.fn(async () => account);
    getUsage = vi.fn(async () => ({ rate_limits_available: true, rate_limits: {
      five_hour: { utilization: 23, resets_at: '2026-09-06T15:00:00Z' },
      seven_day: { utilization: 61, resets_at: '2026-09-12T15:00:00Z' },
    } }));
    supportedModels = vi.fn(async () => [{ value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 4.6 · Best for everyday tasks', supportsEffort: true, supportedEffortLevels: ['low', 'high'] }, { value: 'haiku', displayName: 'Haiku' }]);
    close = vi.fn(() => stream?.close()); login = vi.fn(async () => {}); approve = vi.fn<Approve>(async (): Promise<Decision> => 'allow'); log = vi.fn();
    factory = ((args: Parameters<typeof query>[0]) => {
      calls.push(args);
      return { accountInfo, supportedModels, usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: getUsage, close, async *[Symbol.asyncIterator]() { if (stream) yield* stream; else yield* messages; } };
    }) as unknown as typeof query;
    provider = new ClaudeProvider(() => '/bin/claude', () => '/workspace', factory, approve, login, log);
  });
  afterEach(() => { provider.dispose(); vi.unstubAllEnvs(); });

  it('discovers account models without submitting prompts and caches discovery while rechecking auth', async () => {
    expect(await provider.status()).toMatchObject({ state: 'connected', models: [{ id: 'sonnet', name: 'Sonnet' }, { id: 'haiku', name: 'Haiku' }] });
    expect(await collect(calls[0]!.prompt as AsyncIterable<SDKUserMessage>)).toEqual([]);
    await provider.status();
    expect(calls).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('reads both numeric subscription windows without submitting a prompt', async () => {
    const status = await provider.status();
    expect(status.usage?.quota).toEqual([
      { name: '5-hour limit', remaining: 77, resetsAt: Date.parse('2026-09-06T15:00:00Z'), state: 'ok' },
      { name: 'Weekly limit', remaining: 39, resetsAt: Date.parse('2026-09-12T15:00:00Z'), state: 'ok' },
    ]);
    expect(await collect(calls[0]!.prompt as AsyncIterable<SDKUserMessage>)).toEqual([]);
    expect(getUsage).toHaveBeenCalledWith({ skipBehaviors: true });
  });
  it('publishes rate limit events immediately and preserves both windows with final tokens', async () => {
    await provider.status();
    messages = [sdkMessage({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: Date.parse('2026-09-06T15:00:00Z') / 1000 } }), claudeSuccess];
    const events = (await collect(provider.send(input, new AbortController().signal))).filter(event => event.type === 'usage');
    expect(events[0]?.usage.quota).toHaveLength(2);
    expect(events[0]?.usage.quota?.[0]?.state).toBe('warning');
    expect(events.at(-1)?.usage.tokens).toBeDefined();
    expect(events.at(-1)?.usage.quota).toHaveLength(2);
  });
  it('bounds a stalled usage request and retains connected models', async () => {
    vi.useFakeTimers();
    try {
      getUsage.mockImplementation(() => new Promise(() => {}));
      const status = provider.status();
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await status).state).toBe('connected');
      expect(log).toHaveBeenCalledWith(expect.stringContaining('usage request timed out'));
      expect(close).toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('refreshes numeric windows after the cache interval without rediscovering models', async () => {
    vi.useFakeTimers();
    try {
      await provider.status();
      await provider.status();
      expect(getUsage).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      await provider.status();
      expect(getUsage).toHaveBeenCalledTimes(2);
      expect(supportedModels).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it('reports effort levels only for the models that support them', async () => {
    const [sonnet, haiku] = (await provider.status()).models;
    expect(sonnet).toEqual({ id: 'sonnet', name: 'Sonnet', description: 'Sonnet 4.6 · Best for everyday tasks', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] });
    expect(haiku).toEqual({ id: 'haiku', name: 'Haiku', description: undefined, efforts: [] });
  });
  it('sends a supported effort and drops one the selected model does not offer', async () => {
    await provider.status();
    await collect(provider.send({ ...input, model: 'sonnet', effort: 'high' }, new AbortController().signal));
    expect(calls.at(-1)?.options).toMatchObject({ effort: 'high' });
    await collect(provider.send({ ...input, model: 'sonnet', effort: 'max' }, new AbortController().signal));
    expect(calls.at(-1)?.options).not.toHaveProperty('effort');
    await collect(provider.send({ ...input, model: 'haiku', effort: 'high' }, new AbortController().signal));
    expect(calls.at(-1)?.options).not.toHaveProperty('effort');
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
    expect(call.options).toMatchObject({ model: undefined, resume: 'previous', tools: [], permissionMode: 'default' });
    expect(close).toHaveBeenCalledTimes(1);
    expect((await iterator.next()).done).toBe(true);
  });
  it('records the subscription window the runtime reports, without inventing a percentage', () => {
    const usage = claudeQuota({ status: 'allowed', resetsAt: 1788702600, rateLimitType: 'five_hour' });
    expect(usage?.quota).toEqual([{ name: '5-hour limit', resetsAt: 1788702600000, state: 'ok' }]);
    expect(claudeQuota({ status: 'rejected', rateLimitType: 'seven_day' })?.quota?.[0]).toEqual({ name: 'Weekly limit', resetsAt: undefined, state: 'exhausted' });
    expect(claudeQuota({ status: 'allowed_warning', rateLimitType: 'unheard_of' })?.quota?.[0]?.name).toBe('unheard of');
    expect(claudeQuota({ nonsense: true })).toBeUndefined();
  });
  it('retains the observed limit when the structured usage request fails', async () => {
    getUsage.mockRejectedValue(new Error('usage unavailable'));
    messages = [assistant('Hi'), sdkMessage({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1788702600, rateLimitType: 'five_hour' } }), claudeSuccess];
    await collect(provider.send(input, new AbortController().signal));
    expect((await provider.status()).usage?.quota?.[0]).toMatchObject({ state: 'exhausted', name: '5-hour limit' });
  });
  it('loads the local Claude Code configuration by default so skills and CLAUDE.md apply', async () => {
    await collect(provider.send(input, new AbortController().signal));
    const options = calls.at(-1)!.options as Record<string, unknown>;
    expect(options.settingSources).toBeUndefined();
    expect(options.settings).toBeUndefined();
    expect(options.strictMcpConfig).toBeUndefined();
    expect(options.mcpServers).toBeUndefined();
  });
  it.each([
    ['full', {}],
    ['skills', { settings: { disableAllHooks: true }, strictMcpConfig: true, mcpServers: {} }],
    ['isolated', { settingSources: [], settings: { disableAllHooks: true }, strictMcpConfig: true, mcpServers: {} }],
  ] as const)('maps the %s configuration to SDK options', (configuration, expected) => {
    expect(claudeConfigurationOptions(configuration)).toEqual(expected);
  });
  it('sends with the configuration selected at the time of the turn', async () => {
    let configuration: ClaudeConfiguration = 'isolated';
    const scoped = new ClaudeProvider(() => '/bin/claude', () => '/workspace', factory, approve, login, log, () => configuration);
    await collect(scoped.send(input, new AbortController().signal));
    expect(calls.at(-1)!.options).toMatchObject({ settingSources: [], strictMcpConfig: true });
    configuration = 'full';
    await collect(scoped.send(input, new AbortController().signal));
    expect((calls.at(-1)!.options as Record<string, unknown>).settingSources).toBeUndefined();
    scoped.dispose();
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


describe('claudePlanUsage', () => {
  it('preserves zero and exhausted percentages and does not invent missing windows', () => {
    expect(claudePlanUsage({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 0, resets_at: null }, seven_day: { utilization: 100, resets_at: 'invalid' } } })?.quota).toMatchObject([
      { remaining: 100, resetsAt: undefined, state: 'ok' }, { remaining: 0, resetsAt: undefined, state: 'exhausted' },
    ]);
    expect(claudePlanUsage({ rate_limits_available: false, rate_limits: null })).toBeUndefined();
    expect(claudePlanUsage({ rate_limits_available: true, rate_limits: { five_hour: { utilization: null, resets_at: null } } })?.quota?.[0]?.remaining).toBeUndefined();
    expect(() => claudePlanUsage({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 101, resets_at: null } } })).toThrow();
  });
});
