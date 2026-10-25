/**
 * S-07e part B, review round 7: the route write pool (routeAdminPool, max 3, shared by every tenant's route
 * writes) fails a queued write after 2 s, not 15 s, and a timeout waiting for a connection is treated exactly
 * like a lock timeout wherever routeAdminQuery is used: a request answers 503 (the same path as 55P03), the
 * cron skips the connection (or the whole tick, for the due selection), and it is never read as the scan or a
 * delivery failing (a connection is not flipped to 'error', no failure is counted). The real pool wrapper runs
 * over a faked pg whose connect() times out the way pg-pool's does; the mailbox is a fake.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiResponse } from 'next';

const h = vi.hoisted(() => ({
  poolOpts: [] as Array<{ max?: number; connectionTimeoutMillis?: number }>,
  connects: 0,
  connectError: null as Error | null,
  queries: [] as string[],
}));

vi.mock('pg', () => {
  class Pool {
    constructor(opts: { max?: number; connectionTimeoutMillis?: number }) { h.poolOpts.push(opts); }
    on() { return this; }
    async connect() {
      h.connects += 1;
      if (h.connectError) throw h.connectError;
      return {
        query: async (text: string) => { h.queries.push(text); return { rows: [] }; },
        release: () => undefined,
      };
    }
  }
  return { default: { Pool } };
});
vi.mock('@/lib/pgTypes', () => ({}));
vi.mock('imapflow', () => ({
  ImapFlow: class {
    mailbox = { uidNext: 0 };
    streamer = { write: () => true, push: () => true };
    on() { /* the mirror registers an 'error' listener */ }
    async connect() { /* fake mailbox */ }
    async logout() { /* fake mailbox */ }
    async getMailboxLock() { return { release: () => undefined }; }
    async *fetch() {
      yield { uid: 11, size: 100, envelope: { from: [{ address: 'ap@supplier.test' }], to: [{ address: 'c@cust.test' }], subject: 'newsletter' } };
    }
    async fetchOne(uid: string) { return { uid: Number(uid), source: Buffer.from('msg') }; }
  },
}));
vi.mock('mailparser', () => ({ simpleParser: async () => ({ subject: 's', from: { text: 'a' }, attachments: [] }) }));
vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: '93.184.216.34', family: 4 }] }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/encryption', () => ({ decrypt: () => 'password' }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withTransaction: vi.fn() }));

import { ROUTE_CONNECT_TIMEOUT_MS, RouteAdminPoolTimeoutError, routeAdminQuery } from '@/lib/auth/routeAdminPool';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { ScanStampLockSkip, isScanLockSkip, stampConnection } from '@/modules/accounting/services/capture/mirrorScanWrite';
import { scanAllDueConnections, scanConnection, type MirrorConnection } from '@/modules/accounting/services/capture/imapMirrorService';
import { scanAllDueSentConnections } from '@/modules/accounting/services/ar/sentMirrorService';
import { stampDelivery } from '@/modules/accounting/services/core/webhookEndpointWrites';

const COMPANY = '11111111-1111-4111-8111-111111111111';
/** pg-pool's own message when no connection came free in connectionTimeoutMillis. */
const poolTimeout = () => new Error('timeout exceeded when trying to connect');
const imapConn = (): MirrorConnection => ({
  id: 'c1', companyId: COMPANY, provider: 'imap', accountEmail: 'ap@co.test', folder: 'INBOX', scanCursor: { INBOX: 10 },
  allowedSenders: [], deniedSenders: [], imapHost: 'imap.test', imapPort: 993, imapUseTls: true, imapUsername: 'u',
  imapPasswordEnc: 'enc', oauthRefreshTokenEnc: null,
});

beforeEach(() => {
  h.connects = 0;
  h.connectError = null;
  h.queries.length = 0;
  vi.stubEnv('MIGRATION_ADMIN_DATABASE_URL', 'postgresql://migration_admin@127.0.0.1:1/none');
});

describe('routeAdminPool connect timeout', () => {
  it('the pool gives up on a connection after 2 s (a request holding an auth-pool connection must not wait 15 s)', async () => {
    await routeAdminQuery('probe', 'SELECT 1', []);
    expect(ROUTE_CONNECT_TIMEOUT_MS).toBe(2_000);
    expect(h.poolOpts[0]).toMatchObject({ max: 3, connectionTimeoutMillis: 2_000 });
  });

  it('a connect timeout is rethrown as a 55P03 error that keeps its cause, and sends no statement', async () => {
    h.connectError = poolTimeout();
    const err = await routeAdminQuery('webhook delivery stamp', 'UPDATE x SET y = 1', []).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RouteAdminPoolTimeoutError);
    expect(err).toMatchObject({ code: '55P03' });
    expect((err as Error).cause).toBe(h.connectError);
    expect(h.queries).toEqual([]);
  });

  it('any other connect failure is rethrown untouched (a refused connection is a fault, not contention)', async () => {
    h.connectError = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });
    await expect(routeAdminQuery('stamp', 'UPDATE x SET y = 1', [])).rejects.toBe(h.connectError);
  });
});

describe('what a connect timeout means to each caller', () => {
  it('a request answers 503 with Retry-After, through the same path as a 55P03 lock timeout', async () => {
    h.connectError = poolTimeout();
    const err = await routeAdminQuery('delete imap mirror connection', 'DELETE FROM x', []).catch((e: unknown) => e);
    const out = { status: 0, headers: {} as Record<string, string>, body: null as unknown };
    const res = {
      setHeader(k: string, v: string) { out.headers[k] = v; },
      status(code: number) { out.status = code; return this; },
      json(b: unknown) { out.body = b; return this; },
    };
    expect(respondIfLockTimeout(res as unknown as NextApiResponse, err)).toBe(true);
    expect(out.status).toBe(503);
    expect(out.headers['Retry-After']).toBe('2');
  });

  it('a scan stamp skips the connection (ScanStampLockSkip), it is not a failure', async () => {
    h.connectError = poolTimeout();
    const err = await stampConnection('scan cursor', 'UPDATE x SET y = 1', []).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScanStampLockSkip);
    expect(isScanLockSkip(err)).toBe(true);
  });

  it('the cron skips the connection for the tick: one attempt (the cursor stamp), and no attempt to flip it to error', async () => {
    h.connectError = poolTimeout();
    const result = await scanConnection(imapConn());
    expect(h.connects).toBe(1); // a markMirrorScanError would be a second
    expect(result.errors).toBe(0);
    expect(h.queries).toEqual([]);
  });

  it('the cron skips the whole tick when the due selection cannot get a connection', async () => {
    h.connectError = poolTimeout();
    await expect(scanAllDueConnections()).resolves.toEqual([]);
    await expect(scanAllDueSentConnections()).resolves.toEqual([]);
    expect(h.connects).toBe(2);
  });

  it('a delivery stamp throws with the lock code (the caller logs it and counts no failure: the count is in the statement)', async () => {
    h.connectError = poolTimeout();
    await expect(stampDelivery(COMPANY, 'e1', false, 5)).rejects.toMatchObject({ code: '55P03' });
    expect(h.queries).toEqual([]);
  });
});
