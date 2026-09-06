import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexProvider, codexQuota, turnErrorReason, windowName } from '../src/providers/codex/provider';
import { startProcess } from '../src/providers/runtime';
import type { RpcFrame } from '../src/providers/codex/rpc';
import type { Approve, Decision } from '../src/shared/domain';
import { FakeProcess } from './fixtures/fake-process';

vi.mock('../src/providers/runtime', async importOriginal => ({ ...await importOriginal<typeof import('../src/providers/runtime')>(), startProcess: vi.fn() }));
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> { const values: T[] = []; for await (const value of source) values.push(value); return values; }
const params = (frame: RpcFrame) => frame.params as Record<string, unknown>;

describe('codexQuota', () => {
  it('converts provider reset seconds to milliseconds and clamps remaining percentages', () => {
    expect(codexQuota({ primary: { usedPercent: 30, resetsAt: 1234 }, secondary: { usedPercent: 120 } })).toMatchObject({ source: 'provider', quota: [{ name: 'primary', remaining: 70, resetsAt: 1234000, state: 'ok' }, { name: 'secondary', remaining: 0, state: 'exhausted' }] });
    expect(codexQuota({ primary: { usedPercent: -10 } }).quota?.[0]?.remaining).toBe(100);
    expect(codexQuota({ primary: null, secondary: null }).quota).toEqual([]);
    expect(() => codexQuota({ primary: { usedPercent: 'unknown' } })).toThrow();
  });
  it('names a window by how long it lasts and falls back to the raw key', () => {
    expect(codexQuota({ primary: { usedPercent: 0, windowDurationMins: 300 }, secondary: { usedPercent: 95, windowDurationMins: 10080 } }).quota?.map(window => [window.name, window.state])).toEqual([['5-hour limit', 'ok'], ['Weekly limit', 'warning']]);
    expect(codexQuota({ primary: { usedPercent: 0 } }).quota?.[0]?.name).toBe('primary');
    expect(windowName(90)).toBe('90-minute limit');
    expect(windowName(2880)).toBe('2-day limit');
    expect(windowName(null)).toBe('Rate limit');
  });
});

describe('CodexProvider', () => {
  let child: FakeProcess;
  let provider: CodexProvider;
  let account: unknown;
  let authUrl: string;
  let quotaFails: boolean;
  let resumeFails: boolean;
  let turn: (frame: RpcFrame) => void;
  let approve: ReturnType<typeof vi.fn<Approve>>;
  let openUrl: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>;
  let log: ReturnType<typeof vi.fn<(text: string) => void>>;
  const input = { cwd: '/workspace', model: 'codex-model', prompt: 'task' };
  const notification = (method: string, extra: Record<string, unknown> = {}) => child.send({ method, params: { threadId: 'thread-1', ...extra } });
  beforeEach(() => {
    vi.clearAllMocks(); account = { type: 'chatgpt' }; authUrl = 'https://auth.openai.com/authorize?state=fixture'; quotaFails = false; resumeFails = false;
    approve = vi.fn<Approve>(async (): Promise<Decision> => 'allow'); openUrl = vi.fn(async () => {}); log = vi.fn();
    turn = frame => { child.reply(frame, { turn: { id: 'turn-1' } }); notification('item/agentMessage/delta', { delta: 'answer' }); notification('turn/completed', { turn: { id: 'turn-1', status: 'completed' } }); };
    child = new FakeProcess(frame => {
      switch (frame.method) {
        case 'initialize': child.reply(frame, {}); break;
        case 'account/read': child.reply(frame, { account }); break;
        case 'model/list': child.reply(frame, params(frame).cursor ? { data: [{ id: 'second', model: 'second-model', displayName: 'Second' }], nextCursor: null } : { data: [{ id: 'first', model: 'codex-model', displayName: 'Codex', description: 'Fast general model', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fastest' }, { reasoningEffort: 'xhigh', description: 'Deepest' }], defaultReasoningEffort: 'low' }, { id: 'hidden', model: 'hidden-model', displayName: 'Hidden', hidden: true }], nextCursor: 'page-2' }); break;
        case 'account/rateLimits/read': if (quotaFails) child.reject(frame); else child.reply(frame, { rateLimits: { primary: { usedPercent: 25, resetsAt: 2000 } } }); break;
        case 'thread/start': child.reply(frame, { thread: { id: 'thread-1' } }); break;
        case 'thread/resume': if (resumeFails) child.reject(frame); else child.reply(frame, { thread: { id: 'thread-1' } }); break;
        case 'turn/start': turn(frame); break;
        case 'account/login/start': child.reply(frame, { type: 'chatgpt', authUrl, loginId: 'login-1' }); break;
        case 'account/login/cancel': case 'account/logout': case 'turn/interrupt': child.reply(frame, {}); break;
      }
    });
    vi.mocked(startProcess).mockReturnValue(child.asChild());
    provider = new CodexProvider(() => '/bin/codex', () => '/workspace', approve, openUrl, log);
  });
  afterEach(() => { provider.dispose(); });

  it('initializes one client, pages visible models, and reports provider quota', async () => {
    const status = await provider.status();
    expect(status).toMatchObject({ state: 'connected', models: [{ id: 'codex-model', name: 'Codex' }, { id: 'second-model', name: 'Second' }], usage: { quota: [{ name: 'primary', remaining: 75, resetsAt: 2000000 }] } });
    expect(child.frames.filter(frame => frame.method === 'model/list').map(frame => params(frame).cursor)).toEqual([null, 'page-2']);
    expect(child.frames).toContainEqual({ method: 'initialized', params: {} });
    await provider.status();
    expect(startProcess).toHaveBeenCalledTimes(1);
    expect(startProcess).toHaveBeenCalledWith('/bin/codex', ['app-server'], '/workspace');
  });
  it('reports the reasoning levels and default each model advertises', async () => {
    const [first, second] = (await provider.status()).models;
    expect(first).toEqual({ id: 'codex-model', name: 'Codex', description: 'Fast general model', efforts: [{ id: 'low', name: 'Low', description: 'Fastest' }, { id: 'xhigh', name: 'Xhigh', description: 'Deepest' }], defaultEffort: 'low' });
    expect(second).toEqual({ id: 'second-model', name: 'Second', description: undefined, efforts: [], defaultEffort: undefined });
  });
  it('sends the chosen reasoning effort with the turn and omits it when unset', async () => {
    await collect(provider.send({ ...input, effort: 'xhigh' }, new AbortController().signal));
    expect(params(child.frames.find(frame => frame.method === 'turn/start')!)).toMatchObject({ model: 'codex-model', effort: 'xhigh' });
    child.frames.length = 0;
    await collect(provider.send(input, new AbortController().signal));
    expect(params(child.frames.find(frame => frame.method === 'turn/start')!)).not.toHaveProperty('effort');
  });
  it('retains the last observed quota timestamp when a later quota request fails', async () => {
    const first = await provider.status(); quotaFails = true;
    const next = await provider.status();
    expect(next.state).toBe('connected'); expect(next.usage).toEqual(first.usage);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('quota unavailable'));
  });
  it.each([null, { type: 'apiKey' }])('does not expose models or generate with non-subscription account %j', async value => {
    account = value;
    expect((await provider.status()).state).toBe(value ? 'error' : 'disconnected');
    await expect(collect(provider.send(input, new AbortController().signal))).rejects.toThrow('ChatGPT account');
    expect(child.frames.some(frame => frame.method === 'thread/start' || frame.method === 'model/list')).toBe(false);
  });
  it('opens an approved login URL and cancels a previous pending login before replacing it', async () => {
    account = null;
    await provider.connect(); await provider.connect();
    expect(openUrl).toHaveBeenCalledTimes(2);
    expect(openUrl).toHaveBeenCalledWith(authUrl);
    expect(child.frames.filter(frame => frame.method?.startsWith('account/login/')).map(frame => frame.method)).toEqual(['account/login/start', 'account/login/cancel', 'account/login/start']);
    child.send({ method: 'account/login/completed', params: { loginId: 'login-1', success: true } });
    await provider.connect();
    expect(child.frames.filter(frame => frame.method === 'account/login/cancel')).toHaveLength(1);
  });
  it.each(['http://auth.openai.com/login', 'https://auth.openai.com.attacker.test/login', 'https://attacker.test/login'])('rejects an untrusted authentication URL %s', async url => {
    account = null; authUrl = url;
    await expect(provider.connect()).rejects.toThrow('unexpected login URL');
    expect(openUrl).not.toHaveBeenCalled();
  });
  it('reuses an existing subscription login and explicitly logs out on disconnect', async () => {
    await provider.connect(); expect(openUrl).not.toHaveBeenCalled();
    await provider.disconnect();
    expect(child.frames.some(frame => frame.method === 'account/logout')).toBe(true);
  });
  it('sends model and workspace constraints while translating text, tools, diffs, model changes and usage', async () => {
    turn = frame => {
      child.reply(frame, { turn: { id: 'turn-1' } });
      notification('turn/started', { turn: { id: 'turn-1' } });
      notification('item/agentMessage/delta', { delta: 'Hello ' }); notification('item/agentMessage/delta', { delta: 'world' });
      notification('model/rerouted', { toModel: 'actual-model' });
      notification('thread/compacted');
      notification('item/started', { item: { id: 'command', type: 'commandExecution', command: 'npm test' } });
      notification('item/completed', { item: { id: 'command', type: 'commandExecution', command: 'npm test', exitCode: 0, aggregatedOutput: 'passed sk-private123' } });
      notification('turn/diff/updated', { turnId: 'turn-1', diff: '+ change' });
      notification('thread/tokenUsage/updated', { tokenUsage: { last: { totalTokens: 100, inputTokens: 80, outputTokens: 20 }, modelContextWindow: 1000 } });
      notification('turn/completed', { turn: { status: 'completed' } });
    };
    const events = await collect(provider.send({ ...input, readOnly: true }, new AbortController().signal));
    expect(child.frames.find(frame => frame.method === 'thread/start')?.params).toMatchObject({ model: 'codex-model', cwd: '/workspace', sandbox: 'read-only', approvalPolicy: 'on-request' });
    expect(child.frames.find(frame => frame.method === 'turn/start')?.params).toMatchObject({ model: 'codex-model', input: [{ type: 'text', text: 'task' }] });
    expect(events[0]).toEqual({ type: 'session', id: 'thread-1' });
    expect(events.filter(event => event.type === 'text').map(event => event.text).join('')).toBe('Hello world');
    expect(events).toContainEqual({ type: 'model', model: 'actual-model' });
    expect(events.some(event => event.type === 'notice' && event.text.includes('compacted'))).toBe(true);
    const tools = events.filter(event => event.type === 'tool').map(event => event.tool);
    expect(tools.map(tool => tool.status)).toEqual(['running', 'completed', 'completed']);
    expect(tools[1]?.output).toBe('passed [redacted]'); expect(tools[2]?.diff).toBe('+ change');
    expect(events.find(event => event.type === 'usage')?.usage).toMatchObject({ context: { used: 100, limit: 1000 }, tokens: { input: 80, output: 20 } });
  });
  it('resumes the requested session and never retries a failed resume as a fresh turn', async () => {
    resumeFails = true;
    await expect(collect(provider.send({ ...input, sessionId: 'old-thread' }, new AbortController().signal))).rejects.toThrow('request failed');
    expect(child.frames.find(frame => frame.method === 'thread/resume')?.params).toMatchObject({ threadId: 'old-thread', sandbox: 'workspace-write' });
    expect(child.frames.some(frame => frame.method === 'thread/start' || frame.method === 'turn/start')).toBe(false);
  });
  it.each(['failed', 'interrupted'])('propagates a %s turn completion', async status => {
    turn = frame => { child.reply(frame, { turn: { id: 'turn-1' } }); notification('turn/completed', { turn: { status } }); };
    await expect(collect(provider.send(input, new AbortController().signal))).rejects.toThrow(status === 'failed' ? 'turn failed' : 'interrupted');
  });
  it('reports retry notices but fails a nonretryable provider error', async () => {
    turn = frame => { child.reply(frame, { turn: { id: 'turn-1' } }); notification('error', { willRetry: true }); notification('turn/completed', { turn: { status: 'completed' } }); };
    const events = await collect(provider.send(input, new AbortController().signal));
    expect(events).toContainEqual({ type: 'notice', text: 'Codex is retrying a provider error.' });
    turn = frame => { child.reply(frame, { turn: { id: 'turn-1' } }); notification('error', { willRetry: false }); };
    await expect(collect(provider.send(input, new AbortController().signal))).rejects.toThrow('generation failed');
  });
  it('surfaces the reason Codex gave for a failed turn', async () => {
    turn = frame => { child.reply(frame, { turn: { id: 'turn-1' } }); notification('error', { willRetry: false, error: { message: 'You have hit your usage limit.', additionalDetails: 'Resets at 15:49.' } }); };
    await expect(collect(provider.send(input, new AbortController().signal))).rejects.toThrow('You have hit your usage limit. Resets at 15:49.');
    turn = frame => { child.reply(frame, { turn: { id: 'turn-1' } }); notification('turn/completed', { turn: { status: 'failed', error: { message: 'Model is unavailable.', additionalDetails: null } } }); };
    await expect(collect(provider.send(input, new AbortController().signal))).rejects.toThrow('Model is unavailable.');
  });
  it('redacts secrets out of a runtime failure reason', () => {
    expect(turnErrorReason({ message: 'refused for sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' })).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });
  it('falls back to guidance when a failure carries no reason', () => {
    expect(turnErrorReason(undefined)).toContain('Check usage limits');
  });
  it.each([['allow', 'accept'], ['session', 'acceptForSession'], ['deny', 'decline']] as const)('maps %s approval to the native %s decision and rejects unsupported requests', async (decision, native) => {
    approve.mockResolvedValue(decision);
    turn = frame => {
      child.reply(frame, { turn: { id: 'turn-1' } });
      child.send({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', command: 'echo sk-private123', availableDecisions: ['accept', 'acceptForSession', 'decline'] } });
      child.send({ id: 'unsupported', method: 'item/unknown/request', params: { threadId: 'thread-1' } });
      child.send({ id: 'inactive', method: 'item/fileChange/requestApproval', params: { threadId: 'other-thread' } });
      notification('turn/completed', { turn: { status: 'completed' } });
    };
    await collect(provider.send(input, new AbortController().signal));
    expect(child.frames).toContainEqual({ id: 'approval', result: { decision: native } });
    expect(child.frames.find(frame => frame.id === 'unsupported')?.error?.code).toBe(-32601);
    expect(child.frames.find(frame => frame.id === 'inactive')?.error?.code).toBe(-32601);
    expect(approve.mock.calls[0]?.[0]).toMatchObject({ choices: ['allow', 'session', 'deny'], detail: 'echo [redacted]' });
  });
  it('interrupts a running turn on cancellation and retains the same process', async () => {
    turn = frame => { child.reply(frame, { turn: { id: 'turn-1' } }); notification('item/agentMessage/delta', { delta: 'partial' }); };
    const controller = new AbortController();
    const iterator = provider.send(input, controller.signal);
    expect((await iterator.next()).value).toEqual({ type: 'session', id: 'thread-1' });
    expect((await iterator.next()).value).toEqual({ type: 'text', text: 'partial' });
    controller.abort();
    await expect(iterator.next()).rejects.toThrow('Generation stopped');
    expect(child.frames.find(frame => frame.method === 'turn/interrupt')?.params).toEqual({ threadId: 'thread-1', turnId: 'turn-1' });
    expect(startProcess).toHaveBeenCalledTimes(1);
  });
  it('fails an active response when the runtime exits', async () => {
    turn = frame => { child.reply(frame, { turn: { id: 'turn-1' } }); child.emit('close', 1); };
    await expect(collect(provider.send(input, new AbortController().signal))).rejects.toThrow('exited (1)');
  });
  it('closes an active generation even when account logout fails', async () => {
    turn = frame => { child.reply(frame, { turn: { id: 'turn-1' } }); notification('item/agentMessage/delta', { delta: 'partial' }); };
    const iterator = provider.send(input, new AbortController().signal);
    await iterator.next(); await iterator.next();
    const respond = child.respond;
    Object.defineProperty(child, 'respond', { value: (frame: RpcFrame, process: FakeProcess) => frame.method === 'account/logout' ? process.reject(frame) : respond(frame, process) });
    await expect(provider.disconnect()).rejects.toThrow('request failed');
    const next = iterator.next();
    notification('turn/completed', { turn: { status: 'completed' } });
    await expect(next).rejects.toThrow('connection closed');
  });
  it('does not submit a turn when cancellation arrives after the session was created', async () => {
    const controller = new AbortController();
    const iterator = provider.send(input, controller.signal);
    await iterator.next(); controller.abort();
    await expect(iterator.next()).rejects.toThrow();
    expect(child.frames.some(frame => frame.method === 'turn/start')).toBe(false);
  });
  it('rejects a pre-cancelled request without spawning a process', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(collect(provider.send(input, controller.signal))).rejects.toThrow();
    expect(startProcess).not.toHaveBeenCalled();
  });
});
