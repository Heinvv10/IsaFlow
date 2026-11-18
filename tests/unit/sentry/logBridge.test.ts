/**
 * Logger -> Sentry bridge: every error-level log call reaches Bugsink, grouped by component + message,
 * rate-limited per fingerprint, scrubbed, and without expected 4xx/validation rejections.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Event } from '@sentry/nextjs';

const scope = vi.hoisted(() => ({ setTag: vi.fn(), setFingerprint: vi.fn(), setUser: vi.fn(), setLevel: vi.fn() }));
const m = vi.hoisted(() => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  withScope: vi.fn((cb: (s: typeof scope) => void) => cb(scope)),
}));
vi.mock('@sentry/nextjs', () => m);

import { forwardLogError, resetLogBridgeForTests } from '@/lib/sentry/logBridge';
import { scrubEvent } from '@/lib/sentry/scrub';

beforeEach(() => {
  vi.clearAllMocks();
  resetLogBridgeForTests();
  vi.stubEnv('SENTRY_ENABLED', 'true');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('forwarding', () => {
  it('captureException when an Error is in the data', () => {
    const err = new Error('permission denied for table vat_returns');
    forwardLogError({ message: 'Workbench card failed', component: 'Workbench', data: { error: err } });
    expect(m.captureException).toHaveBeenCalledWith(err);
    expect(m.captureMessage).not.toHaveBeenCalled();
  });
  it('captureMessage at level error when no Error is present', () => {
    forwardLogError({ message: 'Workbench card failed', component: 'Workbench', data: { x: 1 } });
    expect(m.captureMessage).toHaveBeenCalledWith('Workbench card failed', 'error');
    expect(m.captureException).not.toHaveBeenCalled();
  });
  it('tags component, company_id, user_id, request_id', () => {
    forwardLogError({
      message: 'boom', component: 'Bank', requestId: 'req-1',
      data: { companyId: 'c-1', userId: 'u-1' },
    });
    expect(scope.setTag).toHaveBeenCalledWith('component', 'Bank');
    expect(scope.setTag).toHaveBeenCalledWith('company_id', 'c-1');
    expect(scope.setTag).toHaveBeenCalledWith('user_id', 'u-1');
    expect(scope.setTag).toHaveBeenCalledWith('request_id', 'req-1');
  });
  it('is a no-op when Sentry is disabled', () => {
    vi.stubEnv('SENTRY_ENABLED', 'false');
    forwardLogError({ message: 'boom', data: { error: new Error('x') } });
    expect(m.withScope).not.toHaveBeenCalled();
  });
  it('skips entries already captured at the call site', () => {
    forwardLogError({ message: 'boom', data: { error: new Error('x'), sentryCaptured: true } });
    expect(m.withScope).not.toHaveBeenCalled();
  });
});

describe('fingerprint', () => {
  it('groups by component + message, not interpolated values', () => {
    vi.useFakeTimers();
    forwardLogError({ message: 'Card 123 failed for 7f3a9c2e-1111-4222-8333-444455556666', component: 'W', data: {} });
    vi.advanceTimersByTime(61_000);
    forwardLogError({ message: 'Card 456 failed for 00000000-1111-4222-8333-444455556666', component: 'W', data: {} });
    const fps = scope.setFingerprint.mock.calls.map((c) => c[0]);
    expect(fps).toHaveLength(2);
    expect(fps[0]).toEqual(fps[1]);
    expect(fps[0][0]).toContain('W');
  });
  it('differs across components', () => {
    forwardLogError({ message: 'same', component: 'A', data: {} });
    forwardLogError({ message: 'same', component: 'B', data: {} });
    expect(scope.setFingerprint.mock.calls[0][0]).not.toEqual(scope.setFingerprint.mock.calls[1][0]);
  });
});

describe('review findings', () => {
  it('two different errors under one log message are not merged or rate-limited together', () => {
    const a = new Error('db down'); const b = new TypeError('other bug');
    forwardLogError({ message: 'Failed to load', component: 'X', data: { error: a } });
    forwardLogError({ message: 'Failed to load', component: 'X', data: { error: b } });
    expect(m.captureException).toHaveBeenCalledTimes(2);
    expect(scope.setFingerprint.mock.calls[0][0]).toContain('{{ default }}');
  });
  it('finds an Error nested one level down, or passed as data itself', () => {
    const e = new Error('deep');
    forwardLogError({ message: 'nested lookup', data: { details: { err: e } } });
    forwardLogError({ message: 'direct lookup', data: e });
    expect(m.captureException).toHaveBeenCalledTimes(2);
  });
  it('drops the bare default "error" message with no Error (junk shared issue)', () => {
    forwardLogError({ message: 'error', component: 'API', data: { type: 'error' } });
    expect(m.withScope).not.toHaveBeenCalled();
  });
  it('redacts emails in a message sent without an Error', () => {
    forwardLogError({ message: 'Failed for user a.b@example.co.za', data: {} });
    expect(m.captureMessage.mock.calls[0][0]).not.toContain('example.co.za');
  });
});

describe('rate limit', () => {
  it('one event per fingerprint per minute', () => {
    vi.useFakeTimers();
    for (let i = 0; i < 5; i++) forwardLogError({ message: 'again', component: 'C', data: {} });
    expect(m.captureMessage).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(61_000);
    forwardLogError({ message: 'again', component: 'C', data: {} });
    expect(m.captureMessage).toHaveBeenCalledTimes(2);
  });
  it('a different fingerprint is not limited by another', () => {
    forwardLogError({ message: 'one', data: {} });
    forwardLogError({ message: 'two', data: {} });
    expect(m.captureMessage).toHaveBeenCalledTimes(2);
  });
});

describe('expected rejections are skipped', () => {
  it.each([
    ['Invalid journal entry', new Error('Invalid journal entry: debits != credits')],
    ['zod', Object.assign(new Error('bad'), { name: 'ZodError' })],
    ['named', Object.assign(new Error('bad'), { name: 'AdminRequestError' })],
  ])('%s', (_n, err) => {
    forwardLogError({ message: 'handler failed', data: { error: err } });
    expect(m.withScope).not.toHaveBeenCalled();
  });
  it('a 4xx status in the data', () => {
    forwardLogError({ message: 'rejected', data: { statusCode: 422 } });
    expect(m.withScope).not.toHaveBeenCalled();
  });
  it('a 5xx status in the data is forwarded', () => {
    forwardLogError({ message: 'failed', data: { status: 500 } });
    expect(m.captureMessage).toHaveBeenCalled();
  });
});

describe('scrub is applied to what is sent', () => {
  it('the project scrubEvent redacts URL values in the message', () => {
    const ev = scrubEvent({ message: 'failed GET /x?token=abc123secret' } as Event);
    expect(JSON.stringify(ev)).not.toContain('abc123secret');
  });
  it('sentry.server.config routes every event, including bridged ones, through scrubEvent', async () => {
    vi.resetModules();
    const init = vi.fn();
    vi.doMock('@sentry/nextjs', () => ({ init, setTag: vi.fn(), httpIntegration: vi.fn() }));
    vi.stubEnv('SENTRY_DSN', 'https://k@bugsink.test/1');
    await import('../../../sentry.server.config');
    const opts = init.mock.calls[0][0] as { beforeSend: (e: Event) => Event | null };
    const out = opts.beforeSend({ message: 'failed GET /x?token=abc123secret' } as Event);
    expect(JSON.stringify(out)).not.toContain('abc123secret');
  });
});
