import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatEngine } from '../src/conversations/engine';
import { createConversation, createMessage } from '../src/conversations/context';
import { ConversationStore } from '../src/storage/conversations';
import type { Attachment, Provider, ProviderEvent, ProviderId, ProviderInput, ProviderStatus } from '../src/shared/domain';
import type { HostMessage } from '../src/shared/messages';

type Script = (input: ProviderInput, signal: AbortSignal) => AsyncIterable<ProviderEvent>;
class TestProvider implements Provider {
  inputs: ProviderInput[] = [];
  scripts: Script[] = [];
  state: ProviderStatus['state'] = 'connected';
  disposed = false;
  statusError?: Error;
  constructor(readonly id: ProviderId) {}
  async status(): Promise<ProviderStatus> {
    if (this.statusError) throw this.statusError;
    return { id: this.id, state: this.state, detail: this.state, models: [{ id: 'model', name: 'Model', efforts: [{ id: 'high', name: 'High' }] }], capabilities: { models: true, resume: true, quota: false, context: false, tools: true, diffs: true, approvals: true, cancellation: true } };
  }
  async connect(): Promise<void> { this.state = 'connected'; }
  async disconnect(): Promise<void> { this.state = 'disconnected'; }
  dispose(): void { this.disposed = true; }
  async *send(input: ProviderInput, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    this.inputs.push(structuredClone(input));
    const script = this.scripts.shift();
    if (script) { yield* script(input, signal); return; }
    yield { type: 'session', id: `${this.id}-session-${this.inputs.length}` };
    yield { type: 'text', text: `${this.id} answer ${this.inputs.length}` };
  }
}

function contents(input: ProviderInput | undefined): string[] {
  if (!input) throw new Error('Expected a provider request');
  return (JSON.parse(input.prompt.slice(input.prompt.indexOf('\n') + 1)) as { content: string }[]).map(message => message.content);
}

describe('ChatEngine', () => {
  let directory: string;
  let engine: ChatEngine;
  let store: ConversationStore;
  let codex: TestProvider;
  let claude: TestProvider;
  let events: HostMessage[];
  let reports: string[];
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'crossbar-engine-test-'));
    reports = []; events = [];
    store = new ConversationStore(directory, message => reports.push(message));
    codex = new TestProvider('codex'); claude = new TestProvider('claude');
    engine = new ChatEngine(store, new Map<ProviderId, Provider>([['codex', codex], ['claude', claude]]), '/workspace', event => events.push(structuredClone(event)), () => 5000);
    await engine.refresh();
  });
  afterEach(async () => { engine.dispose(); await rm(directory, { recursive: true, force: true }); });

  it.each([['codex', 'claude'], ['claude', 'codex']] as const)('preserves context through %s to %s and back', async (first, second) => {
    const providers = { codex, claude };
    await engine.send('request-1', 'first request', { provider: first, model: 'first-model' });
    await engine.send('request-2', 'second request', { provider: second, model: 'second-model' });
    expect(contents(providers[second].inputs[0])).toEqual(['first request', `${first} answer 1`, 'second request']);
    expect(providers[second].inputs[0]?.sessionId).toBeUndefined();
    await engine.send('request-3', 'third request', { provider: first, model: 'first-model' });
    expect(providers[first].inputs[1]?.sessionId).toBe(`${first}-session-1`);
    expect(contents(providers[first].inputs[1])).toEqual(['second request', `${second} answer 1`, 'third request']);
    expect((await store.load(engine.chat.id)).messages).toHaveLength(6);
    expect(engine.chat.sessions).toHaveLength(2);
    expect(engine.busy).toBe(false);
  });

  it('changes the requested model while preserving the established session context', async () => {
    await engine.send('one', 'first', { provider: 'codex', model: 'old-model' });
    await engine.send('two', 'next', { provider: 'codex', model: 'new-model' });
    expect(codex.inputs[1]).toMatchObject({ model: 'new-model', sessionId: 'codex-session-1' });
    expect(contents(codex.inputs[1])).toEqual(['next']);
    expect(engine.chat.messages.at(-1)?.model).toBe('new-model');
  });

  it('reseeds a stale session from canonical history without requesting a broken resume', async () => {
    await engine.send('one', 'first', { provider: 'codex', model: 'model' });
    engine.chat.sessions[0]!.syncedThrough = 'missing';
    await engine.send('two', 'next', { provider: 'codex', model: 'model' });
    expect(codex.inputs[1]?.sessionId).toBeUndefined();
    expect(contents(codex.inputs[1])).toEqual(['first', 'codex answer 1', 'next']);
    expect(engine.chat.sessions[0]?.syncedThrough).toBe(engine.chat.messages.at(-1)?.id);
  });

  it('retains a failed resume as one failed answer and starts fresh on the next explicit request', async () => {
    await engine.send('one', 'first', { provider: 'claude', model: 'model' });
    claude.scripts.push(async function* () { yield { type: 'text', text: 'partial' }; throw new Error('Session expired'); });
    await engine.send('two', 'resume', { provider: 'claude', model: 'model' });
    expect(claude.inputs).toHaveLength(2);
    expect(engine.chat.messages.at(-1)).toMatchObject({ status: 'failed', content: 'partial', error: 'Session expired' });
    expect(engine.chat.sessions).toEqual([]);
    await engine.send('three', 'try again', { provider: 'claude', model: 'model' });
    expect(claude.inputs[2]?.sessionId).toBeUndefined();
    expect(contents(claude.inputs[2])).toEqual(['first', 'claude answer 1', 'resume', 'try again']);
  });

  it('deduplicates a completed request ID after persistence and reopening', async () => {
    await engine.send('request', 'do work', { provider: 'codex', model: 'model' });
    await engine.initialize(engine.chat.id);
    await engine.send('request', 'do work', { provider: 'codex', model: 'model' });
    expect(codex.inputs).toHaveLength(1);
    expect(engine.chat.messages).toHaveLength(2);
  });

  it('routes each side of a comparison to its own reasoning effort and records it on the reply', async () => {
    await engine.send('compare', 'compare answers', { provider: 'codex', model: 'model', effort: 'high' }, { model: 'other-model', effort: 'low' });
    expect(codex.inputs[0]?.effort).toBe('high');
    expect(claude.inputs[0]?.effort).toBe('low');
    const replies = (await store.load(engine.chat.id)).messages.filter(message => message.role === 'assistant');
    expect(replies.map(message => message.effort)).toEqual(['high', 'low']);
  });
  it('leaves effort unset when none is chosen', async () => {
    await engine.send('plain', 'no effort', { provider: 'codex', model: 'model' });
    expect(codex.inputs[0]?.effort).toBeUndefined();
    expect(engine.chat.messages.find(message => message.role === 'assistant')?.effort).toBeUndefined();
  });

  it('compares from the same input snapshot and persists choosing a canonical response', async () => {
    await engine.send('compare', 'compare answers', { provider: 'codex', model: 'model' }, { model: 'other-model' });
    expect(contents(codex.inputs[0])).toEqual(['compare answers']);
    expect(contents(claude.inputs[0])).toEqual(['compare answers']);
    expect(engine.chat.messages.filter(message => message.compareGroup === 'compare')).toHaveLength(2);
    expect(engine.chat.sessions).toEqual([]);
    const choice = engine.chat.messages.find(message => message.provider === 'claude')!;
    await engine.choose(choice.id);
    await engine.send('next', 'continue chosen', { provider: 'codex', model: 'model' });
    expect(contents(codex.inputs[1])).toEqual(['compare answers', 'claude answer 1', 'continue chosen']);
    expect((await store.load(engine.chat.id)).messages.find(message => message.provider === 'codex')?.excluded).toBe(true);
  });

  it.each(['failure', 'disconnected'] as const)('preserves the successful comparison when the other provider is %s', async scenario => {
    if (scenario === 'disconnected') { claude.state = 'disconnected'; await engine.refresh(); }
    else claude.scripts.push(async function* () { yield { type: 'text', text: 'partial' }; throw new Error('quota reached'); });
    await engine.send('compare', 'compare', { provider: 'codex', model: 'model' }, { model: 'model' });
    expect(engine.chat.messages.find(message => message.provider === 'codex')).toMatchObject({ status: 'completed', content: 'codex answer 1' });
    expect(engine.chat.messages.find(message => message.provider === 'claude')?.status).toBe('failed');
    expect(claude.inputs).toHaveLength(scenario === 'failure' ? 1 : 0);
    expect(engine.chat.sessions).toEqual([]);
    expect(engine.busy).toBe(false);
  });

  it('stops both comparison generations, preserves partial output, and blocks mutation while busy', async () => {
    let started = 0;
    let bothStarted!: () => void;
    const ready = new Promise<void>(resolve => { bothStarted = resolve; });
    const script: Script = async function* (_input, signal) {
      yield { type: 'text', text: 'partial' };
      if (++started === 2) bothStarted();
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
      signal.throwIfAborted();
    };
    codex.scripts.push(script); claude.scripts.push(script);
    const pending = engine.send('compare', 'compare', { provider: 'codex', model: 'model' }, { model: 'model' });
    await ready;
    expect(engine.busy).toBe(true);
    expect(() => engine.assertIdle()).toThrow('Stop the current generation');
    await expect(engine.newChat()).rejects.toThrow('Stop the current generation');
    await expect(engine.send('another', 'duplicate concurrent work', { provider: 'codex', model: 'model' })).rejects.toThrow('Stop the current generation');
    engine.stop(); await pending;
    expect(engine.chat.messages.filter(message => message.role === 'assistant').map(message => [message.status, message.content])).toEqual([['cancelled', 'partial'], ['cancelled', 'partial']]);
    expect(engine.busy).toBe(false);
    expect(engine.chat.sessions).toEqual([]);
    expect(codex.inputs).toHaveLength(1);
    expect(claude.inputs).toHaveLength(1);
  });

  it('pushes subscription windows to the UI during a turn without a status refresh', async () => {
    const quota = [{ name: '5-hour limit', remaining: 70 }, { name: 'Weekly limit', remaining: 35 }];
    claude.scripts.push(async function* () {
      yield { type: 'usage', usage: { observedAt: 1, source: 'provider', quota } };
      expect(events.filter(event => event.type === 'providers').at(-1)).toMatchObject({
        providers: expect.arrayContaining([expect.objectContaining({ id: 'claude', usage: { observedAt: 1, source: 'provider', quota } })]),
      });
      yield { type: 'usage', usage: { observedAt: 2, source: 'provider', tokens: { input: 10, output: 5 } } };
    });
    await engine.send('usage', 'hello', { provider: 'claude', model: 'model' });
    expect(engine.chat.messages.at(-1)?.usage).toMatchObject({ quota, tokens: { input: 10, output: 5 } });
  });

  it('merges tool result activity, records reported model and usage, and verifies claims against command evidence', async () => {
    codex.scripts.push(async function* () {
      yield { type: 'session', id: 'native-session' };
      yield { type: 'model', model: 'actual-model' };
      yield { type: 'tool', tool: { id: 'tool', title: 'Run tests', command: 'npm test', status: 'running' } };
      yield { type: 'tool', tool: { id: 'tool', title: 'Tool result', status: 'completed', exitCode: 0, output: '19 passed' } };
      yield { type: 'usage', usage: { observedAt: 1, source: 'provider', tokens: { input: 20, output: 10 } } };
      yield { type: 'notice', text: 'Provider notice' };
      yield { type: 'text', text: 'Tests passed. Lint passed.' };
    });
    await engine.send('one', 'verify', { provider: 'codex', model: 'requested-model' }, undefined, true);
    const answer = engine.chat.messages.at(-1)!;
    expect(answer).toMatchObject({ status: 'completed', model: 'actual-model', modelReview: true, usage: { tokens: { input: 20, output: 10 } } });
    expect(answer.tools).toEqual([{ id: 'tool', title: 'Run tests', command: 'npm test', status: 'completed', exitCode: 0, output: '19 passed' }]);
    expect(answer.verification.map(claim => claim.status)).toEqual(['verified', 'unverified']);
    expect(engine.chat.sessions[0]).toMatchObject({ id: 'native-session', model: 'actual-model', syncedThrough: answer.id });
    expect(events).toContainEqual({ type: 'notice', message: 'Provider notice' });
    expect(events.filter(event => event.type === 'delta').map(event => event.text).join('')).toBe(answer.content);
  });

  it('moves pending attachments into exactly one user request and enforces attachment limits atomically', async () => {
    const attachment: Attachment = { id: 'file', kind: 'file', name: 'file.ts', content: 'source', createdAt: 1 };
    await engine.attach([attachment]);
    await expect(engine.attach(Array.from({ length: 20 }, (_, index) => ({ ...attachment, id: String(index) })))).rejects.toThrow('Attachment limit');
    await expect(engine.attach([{ ...attachment, id: 'large', content: 'x'.repeat(400_001) }])).rejects.toThrow('Attachment limit');
    expect(engine.chat.attachments).toEqual([attachment]);
    await engine.send('one', 'inspect', { provider: 'codex', model: 'model' });
    expect(engine.chat.messages[0]?.attachments).toEqual([attachment]);
    expect(engine.chat.attachments).toEqual([]);
    await engine.send('two', 'continue', { provider: 'codex', model: 'model' });
    expect(engine.chat.messages[2]?.attachments).toEqual([]);
  });

  it('creates a read-only summary in a linked conversation and allows removing its capsule', async () => {
    await engine.send('one', 'build', { provider: 'codex', model: 'model' });
    const source = structuredClone(engine.chat);
    claude.scripts.push(async function* () { yield { type: 'text', text: '# Goal\n' }; yield { type: 'text', text: 'Finish build' }; });
    await engine.summarise('claude', 'summary-model');
    expect(claude.inputs[0]).toMatchObject({ cwd: '/workspace', model: 'summary-model', readOnly: true });
    expect(claude.inputs[0]?.sessionId).toBeUndefined();
    expect(engine.chat).toMatchObject({ sourceId: source.id, messages: [], sessions: [] });
    expect(engine.chat.attachments[0]).toMatchObject({ kind: 'capsule', sourceId: source.id, content: '# Goal\nFinish build' });
    expect(await store.load(source.id)).toEqual(source);
    const capsuleId = engine.chat.attachments[0]!.id;
    await engine.removeAttachment(capsuleId);
    expect((await store.load(engine.chat.id)).attachments).toEqual([]);
  });

  it('keeps the original conversation when summary generation fails or returns empty text', async () => {
    await expect(engine.summarise('codex', 'model')).rejects.toThrow('Start a conversation');
    await engine.send('one', 'build', { provider: 'codex', model: 'model' });
    const original = structuredClone(engine.chat);
    claude.scripts.push(async function* () { yield { type: 'text', text: ' ' }; });
    await expect(engine.summarise('claude', 'model')).rejects.toThrow('empty summary');
    expect(engine.chat).toEqual(original);
    claude.scripts.push(async function* () { yield { type: 'text', text: 'partial' }; throw new Error('summary unavailable'); });
    await expect(engine.summarise('claude', 'model')).rejects.toThrow('summary unavailable');
    expect(engine.chat).toEqual(original);
    expect(engine.busy).toBe(false);
  });

  it('persists rename, reopens history, deletes the active conversation, and keeps workspaces isolated', async () => {
    await engine.newChat();
    const id = engine.chat.id;
    await engine.rename(id, 'Renamed conversation');
    expect(engine.chat.title).toBe('Renamed conversation');
    await engine.newChat();
    expect(engine.chat.id).not.toBe(id);
    await engine.open(id);
    expect(engine.chat.title).toBe('Renamed conversation');
    const foreign = createConversation('/another-workspace');
    await store.save(foreign);
    await expect(engine.open(foreign.id)).rejects.toThrow('another workspace');
    expect(engine.chat.id).toBe(id);
    await engine.initialize(foreign.id);
    expect(engine.chat.id).toBe(id);
    await engine.delete(id);
    expect(engine.chat.id).not.toBe(id);
    await expect(store.load(id)).rejects.toThrow();
    expect(await store.load(foreign.id)).toEqual(foreign);
  });

  it('retains a usable new conversation when the last conversation is unavailable', async () => {
    const id = engine.chat.id;
    await engine.initialize('00000000-0000-4000-8000-000000000000');
    expect(engine.chat.id).toBe(id);
    expect(events.some(event => event.type === 'notice' && event.message.includes('could not be reopened'))).toBe(true);
  });

  it('publishes recent and older history windows without exposing provider sessions', async () => {
    engine.chat.messages = Array.from({ length: 170 }, (_, index) => createMessage('user', String(index)));
    engine.chat.sessions = [{ provider: 'codex', id: 'private-native-session', model: 'model' }];
    await engine.state();
    const state = [...events].reverse().find(event => event.type === 'state');
    expect(state?.type).toBe('state');
    if (state?.type !== 'state') throw new Error('State event missing');
    expect(state.conversation.sessions).toEqual([]);
    expect(state.totalMessages).toBe(170);
    expect(state.conversation.messages.map(message => message.content)).toEqual(Array.from({ length: 80 }, (_, index) => String(index + 90)));
    engine.older(90);
    const older = events.at(-1);
    expect(older?.type).toBe('older');
    if (older?.type !== 'older') throw new Error('Older history event missing');
    expect(older.messages.map(message => message.content)).toEqual(Array.from({ length: 80 }, (_, index) => String(index + 10)));
    expect(engine.findMessage(engine.chat.messages[0]!.id).content).toBe('0');
    expect(() => engine.findMessage('missing')).toThrow('no longer exists');
  });

  it('keeps available provider status when another status lookup rejects and disposes both providers', async () => {
    claude.statusError = new Error('runtime unavailable');
    await engine.refresh();
    expect(engine.statuses.map(status => status.id)).toEqual(['codex']);
    engine.dispose();
    expect(codex.disposed).toBe(true);
    expect(claude.disposed).toBe(true);
    expect(reports).toEqual([]);
  });
});
