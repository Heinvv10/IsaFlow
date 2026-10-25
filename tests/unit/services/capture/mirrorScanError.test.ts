/**
 * S-07e part B (migration 946): mirrorScanError.ts records a scan's failure on
 * the connection row. No app role may write that row, so both writes (the error
 * with the status flip, and a stopped scan's stamp) are one statement each on
 * migration_admin (routeAdminQuery: its own pool and transaction, a 2 s lock
 * wait), keyed on id AND company_id. There is no app-pool fallback stamp. Outside a
 * request the write happens before the call returns; inside one (scan-now) it is queued
 * with the scan's other stamps and runs after the request COMMITs, in order, so a cursor
 * stamp made earlier cannot land after, and clear, the error (mirrorScanRequestStamps.test.ts
 * proves the rollback side). Nothing here ever throws, because the cron scans many connections.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@/lib/als';

const h = vi.hoisted(() => ({
  route: [] as Array<{ label: string; text: string; values: unknown[] }>,
  app: 0,
  routeError: null as unknown,
}));

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async () => { h.app += 1; return []; }),
  withTransaction: vi.fn(async () => { h.app += 1; }),
}));
vi.mock('@/lib/auth/migrationAdminPool', () => ({ migrationAdminTx: vi.fn(async () => { h.app += 1; }) }));
vi.mock('@/lib/auth/routeAdminPool', () => ({
  routeAdminQuery: vi.fn(async (label: string, text: string, values: unknown[]) => {
    h.route.push({ label, text: text.replace(/\s+/g, ' ').trim(), values });
    if (h.routeError) throw h.routeError;
    return [];
  }),
}));

import { als } from '@/lib/als';
import { drainAfterCommit } from '@/lib/afterCommit';
import { log } from '@/lib/logger';
import { MESSAGE_TOO_LARGE, SCAN_TIMED_OUT, markMirrorScanError, stampScanStopped } from '@/modules/accounting/services/capture/mirrorScanError';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const conn = { id: '22222222-2222-4222-8222-222222222222', companyId: COMPANY };
const KINDS = [['imap', 'imap_mirror_connections'], ['sent', 'sent_mirror_connections']] as const;
const lockTimeout = () => Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
const requestCtx = (): RequestContext => ({ client: {} as RequestContext['client'], userId: 'u1', claims: {}, afterCommit: [] });
const KEYED = /WHERE id = \$2::uuid AND company_id = \$3::uuid$/;

beforeEach(() => {
  h.route.length = 0;
  h.app = 0;
  h.routeError = null;
  vi.mocked(log.warn).mockClear();
  vi.mocked(log.error).mockClear();
});

describe.each(KINDS)('%s mirror: markMirrorScanError', (kind, table) => {
  it('writes the error and the status flip in one statement on migration_admin, keyed on id AND company_id; nothing on the app pool', async () => {
    await markMirrorScanError(kind, conn, 'boom');
    expect(h.route).toHaveLength(1);
    const w = h.route[0]!;
    expect(w.text).toMatch(new RegExp(`^UPDATE ${table} SET last_scan_at = NOW\\(\\), last_error = \\$1, status = CASE WHEN status = 'active' THEN 'error' ELSE status END`));
    expect(w.text).toMatch(KEYED);
    expect(w.values).toEqual(['boom', conn.id, COMPANY]);
    expect(h.app).toBe(0);
  });

  it('inside a request (scan-now) it is not written until the request commits, and then once, on migration_admin', async () => {
    const ctx = requestCtx();
    await als.run(ctx, () => markMirrorScanError(kind, conn, 'boom'));
    expect(h.route).toHaveLength(0);
    expect(ctx.afterCommit).toHaveLength(1);
    drainAfterCommit(ctx);
    await vi.waitFor(() => expect(h.route).toHaveLength(1));
    expect(h.route[0]!.values).toEqual(['boom', conn.id, COMPANY]);
    expect(h.app).toBe(0);
  });

  it('inside a request that rolls back (the queue is dropped) nothing is written', async () => {
    const ctx = requestCtx();
    await als.run(ctx, () => markMirrorScanError(kind, conn, 'boom'));
    ctx.afterCommit = undefined; // withAuth drops the queue on ROLLBACK and never drains it
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.route).toHaveLength(0);
  });

  it('a write that waits out its 2 s (55P03) warns and moves on: no throw, no second try, no app-pool fallback', async () => {
    h.routeError = lockTimeout();
    await expect(markMirrorScanError(kind, conn, 'boom')).resolves.toBeUndefined();
    expect(h.route).toHaveLength(1);
    expect(h.app).toBe(0);
    expect(vi.mocked(log.warn).mock.calls.some((c) => /timed out on a row lock/.test(String(c[0])))).toBe(true);
    expect(log.error).not.toHaveBeenCalled();
  });

  it.each([
    ['a refusal with a SQLSTATE', Object.assign(new Error('permission denied'), { code: '42501' })],
    ['a failure without one (a dead pool)', new Error('Connection terminated')],
  ])('%s is logged as an error, and never thrown', async (_, err) => {
    h.routeError = err;
    await expect(markMirrorScanError(kind, conn, 'boom')).resolves.toBeUndefined();
    expect(vi.mocked(log.error).mock.calls.some((c) => /scan error write failed/.test(String(c[0])))).toBe(true);
  });
});

describe.each(KINDS)('%s mirror: stampScanStopped', (kind, table) => {
  it.each([SCAN_TIMED_OUT, MESSAGE_TOO_LARGE])('stamps "%s" on migration_admin, keyed on id AND company_id; status untouched', async (reason) => {
    await stampScanStopped(kind, conn, reason);
    expect(h.route).toHaveLength(1);
    const w = h.route[0]!;
    expect(w.text).toMatch(new RegExp(`^UPDATE ${table} SET last_scan_at = NOW\\(\\), last_error = \\$1 WHERE`));
    expect(w.text).not.toContain('status');
    expect(w.text).toMatch(KEYED);
    expect(w.values).toEqual([reason, conn.id, COMPANY]);
    expect(h.app).toBe(0);
  });

  it('never throws', async () => {
    h.routeError = lockTimeout();
    await expect(stampScanStopped(kind, conn, SCAN_TIMED_OUT)).resolves.toBeUndefined();
  });
});
