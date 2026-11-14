/**
 * #1371 review LOW (WP9): the caps of the Login-as look-up shared by Sign Out and the refused Return
 * (src/lib/auth/loginAsLookup.ts), pinned without a database so they run on every CI: at most one look-up per
 * session id, at most LOGIN_AS_LOOKUP_SLOTS at once, and a slot is given back however the look-up ends.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const pending = vi.hoisted(() => [] as { sessionId: string; resolve: (v: unknown) => void; reject: (e: unknown) => void }[]);
vi.mock('@/lib/auth/impersonationSessions', () => ({
  impersonationPartiesOfBounded: (sessionId: string) => new Promise((resolve, reject) => {
    pending.push({ sessionId, resolve, reject });
  }),
}));

import { cappedLoginAsLookup, LOGIN_AS_LOOKUP_SLOTS } from '@/lib/auth/loginAsLookup';

const flush = () => new Promise((r) => setTimeout(r, 0));
const settleAll = async () => { for (const p of pending.splice(0)) p.resolve(null); await flush(); };

describe('cappedLoginAsLookup', () => {
  beforeEach(async () => { await settleAll(); });

  it('one session id holds at most one slot: a second look-up for it is skipped while the first runs', async () => {
    const first = cappedLoginAsLookup('s-1', 'test');
    expect(await cappedLoginAsLookup('s-1', 'test')).toBe('skipped');
    expect(pending.map((p) => p.sessionId)).toEqual(['s-1']);
    pending[0]!.resolve({ actorUserId: 'a', targetUserId: 't' });
    expect(await first).toEqual({ actorUserId: 'a', targetUserId: 't' });
    // The slot came back: the same session may look up again.
    const again = cappedLoginAsLookup('s-1', 'test');
    expect(pending).toHaveLength(2);
    await settleAll();
    expect(await again).toBeNull();
  });

  it(`at most ${LOGIN_AS_LOOKUP_SLOTS} at once across sessions: the next one is skipped`, async () => {
    const running = Array.from({ length: LOGIN_AS_LOOKUP_SLOTS }, (_, i) => cappedLoginAsLookup(`s-${i}`, 'test'));
    expect(await cappedLoginAsLookup('s-other', 'test')).toBe('skipped');
    expect(pending).toHaveLength(LOGIN_AS_LOOKUP_SLOTS);
    await settleAll();
    await Promise.all(running);
  });

  it('a failed look-up gives its slot back and answers gave_up', async () => {
    const failing = cappedLoginAsLookup('s-f', 'test');
    pending.shift()!.reject(new Error('bound'));
    expect(await failing).toBe('gave_up');
    const next = cappedLoginAsLookup('s-f', 'test');
    expect(pending).toHaveLength(1);
    await settleAll();
    expect(await next).toBeNull();
  });
});
