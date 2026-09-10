/**
 * R-075 — the non-request transaction owners (withAlsTransaction, the public
 * route transaction, the bank-feed extension and invite-token wrappers) accept
 * runAfterCommit work and start it only after their own COMMIT. A ROLLBACK or a
 * failed COMMIT drops it. Without a drain, runAfterCommit inside them would
 * refuse — see afterCommit.test.ts — so each one's drain is pinned here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pgTypesMock } from '../helpers/pgTypesMock';

const h = vi.hoisted(() => ({ events: [] as string[], commitThrows: false }));
const client = {
  query: vi.fn(async (text: string) => {
    const verb = String(text).trim().split(/\s+/)[0]!.toUpperCase();
    if (/FROM bank_feed_connections/i.test(String(text))) {
      return { rows: [{ id: 'conn-1', company_id: 'company-1', bank_account_id: 'ba-1', provider: 'extension', is_active: true }] };
    }
    if (verb === 'COMMIT' && h.commitThrows) { h.events.push('COMMIT_THROW'); throw new Error('commit failed'); }
    if (verb === 'COMMIT' || verb === 'ROLLBACK') h.events.push(verb);
    return { rows: [] };
  }),
  release: vi.fn(),
};
vi.mock('pg', () => {
  class Pool { connect = async () => client; on = vi.fn(); end = vi.fn(); }
  return { default: { Pool, ...pgTypesMock() }, Pool, ...pgTypesMock() };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth/extensionJwt', () => ({
  verifyExtensionToken: vi.fn(async () => ({ userId: 'user-1', companyId: 'company-1', connectionId: 'conn-1', bankId: 'fnb' })),
}));

import { runAfterCommit } from '@/lib/afterCommit';
import { withAlsTransaction } from '@/lib/alsTransaction';
import { withPublicRouteTransaction } from '@/lib/publicRouteTx';
import { withExtensionToken } from '@/lib/auth/withExtensionToken';
import { withInviteToken } from '@/lib/auth/withInviteToken';

const res = () => ({ status() { return this; }, json() { return this; }, setHeader() { return this; } });
const queue = () => runAfterCommit('probe', async () => { h.events.push('CALLBACK'); });

/** Each owner, running a body that queues work and then succeeds or throws. */
const owners: Array<[string, (fail: boolean) => Promise<unknown>]> = [
  ['withAlsTransaction', (fail) => withAlsTransaction({ userId: 'u', companyId: 'c' }, async () => {
    queue(); if (fail) throw new Error('body failed');
  })],
  ['withPublicRouteTransaction', (fail) => withPublicRouteTransaction('probe', async () => {
    queue(); if (fail) throw new Error('body failed');
  })],
  ['withExtensionToken', (fail) => withExtensionToken(async () => {
    queue(); if (fail) throw new Error('body failed');
  })({ headers: { authorization: 'Bearer ext_x' }, query: {} } as never, res() as never)],
  ['withInviteToken', (fail) => withInviteToken(async () => {
    queue(); if (fail) throw new Error('body failed');
  })({ query: { token: 'invite-token-0123456789' }, headers: {} } as never, res() as never)],
];

const settle = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  h.events.length = 0; h.commitThrows = false;
  vi.stubEnv('DATABASE_URL', 'postgresql://dummy:dummy@dummy/test');
});

describe.each(owners)('%s', (_name, run) => {
  it('runs queued work once, after COMMIT', async () => {
    await run(false);
    await settle();
    expect(h.events).toEqual(['COMMIT', 'CALLBACK']);
  });

  it('drops it when the body fails and the owner rolls back', async () => {
    await expect(run(true)).rejects.toThrow('body failed');
    await settle();
    expect(h.events).toEqual(['ROLLBACK']);
  });

  it('drops it when the COMMIT itself fails', async () => {
    h.commitThrows = true;
    await expect(run(false)).rejects.toThrow('commit failed');
    await settle();
    expect(h.events).not.toContain('CALLBACK');
  });
});
