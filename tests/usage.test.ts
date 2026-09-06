import { describe, expect, it } from 'vitest';
import { resetLabel, tightestWindow, usageLabel, windowLabel } from '../src/verification/claims';
import type { Usage } from '../src/shared/domain';

const now = Date.parse('2026-09-06T12:00:00Z');
const usage = (quota: Usage['quota']): Usage => ({ observedAt: now, source: 'provider', quota });

describe('resetLabel', () => {
  it('answers how long the wait is, not just when it ends', () => {
    expect(resetLabel(now + 45_000, now)).toBe('Resets in under a minute');
    expect(resetLabel(now + 25 * 60_000, now)).toMatch(/^Resets in 25 min \(/);
    expect(resetLabel(now + 3 * 3_600_000 + 26 * 60_000, now)).toMatch(/^Resets in 3h 26m \(/);
    expect(resetLabel(now + 4 * 86_400_000, now)).toMatch(/^Resets in 4 days \(/);
    expect(resetLabel(now + 86_400_000, now)).toMatch(/^Resets in 1 day \(/);
  });
  it('says so when the reset time is unknown or already past', () => {
    expect(resetLabel(undefined, now)).toBe('Reset time unavailable');
    expect(resetLabel(now - 1, now)).toBe('Reset time passed; refresh usage');
  });
});

describe('tightestWindow', () => {
  it('picks the window that stops work first', () => {
    expect(tightestWindow([{ name: 'weekly', remaining: 40 }, { name: 'hourly', state: 'exhausted' }])?.name).toBe('hourly');
    expect(tightestWindow([{ name: 'weekly', remaining: 40 }, { name: 'hourly', remaining: 5, state: 'warning' }])?.name).toBe('hourly');
    expect(tightestWindow([{ name: 'weekly', remaining: 40 }, { name: 'hourly', remaining: 12 }])?.name).toBe('hourly');
    expect(tightestWindow([])).toBeUndefined();
    expect(tightestWindow(undefined)).toBeUndefined();
  });
  it('prefers a known percentage over a window that reports none', () => {
    expect(tightestWindow([{ name: 'unknown' }, { name: 'weekly', remaining: 80 }])?.name).toBe('weekly');
  });
});

describe('usageLabel', () => {
  it('leads with the blocking limit and when it lifts', () => {
    expect(usageLabel(usage([{ name: '5-hour limit', state: 'exhausted', resetsAt: now + 3_600_000 }]), now)).toMatch(/^Limit reached · resets in 1h 0m/);
  });
  it('reports a percentage when the provider gives one', () => {
    expect(usageLabel(usage([{ name: '5-hour limit', remaining: 74.6 }]), now)).toBe('75% remaining');
  });
  it('describes a window that reports state without a percentage', () => {
    expect(usageLabel(usage([{ name: 'Weekly limit', state: 'ok' }]), now)).toBe('Percentage unavailable');
    expect(usageLabel(usage([{ name: 'Weekly limit', state: 'warning' }]), now)).toBe('Percentage unavailable');
  });
  it('marks readings that are no longer fresh', () => {
    expect(usageLabel({ observedAt: now - 400_000, source: 'provider', quota: [{ name: 'w', remaining: 50 }] }, now)).toBe('50% remaining · stale');
  });
  it('falls back to context and tokens, then admits it knows nothing', () => {
    expect(usageLabel({ observedAt: now, source: 'provider', context: { used: 30, limit: 120 } }, now)).toBe('25% context');
    expect(usageLabel({ observedAt: now, source: 'provider', tokens: { input: 10, output: 5 } }, now)).toBe('15 tokens reported');
    expect(usageLabel(undefined, now)).toBe('Usage unavailable');
  });
});

describe('windowLabel', () => {
  it('names the window and its state in plain words', () => {
    expect(windowLabel({ name: '5-hour limit', state: 'exhausted' })).toBe('5-hour limit: limit reached');
    expect(windowLabel({ name: 'Weekly limit', remaining: 43 })).toBe('Weekly limit: 43% remaining');
    expect(windowLabel({ name: 'Weekly limit', state: 'warning' })).toBe('Weekly limit: percentage unavailable');
    expect(windowLabel({ name: 'Weekly limit', state: 'ok' })).toBe('Weekly limit: percentage unavailable');
  });
});
