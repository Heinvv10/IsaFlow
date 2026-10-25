/**
 * S-07e part B (migration 946): mirrorScanError.ts records a scan's failure on
 * the connection row. The flip of `status` runs on migration_admin, keyed on id
 * AND company_id; inside a request (scan-now) it is deferred until the request
 * has committed, so it never waits on the row lock its own request holds; a
 * refused flip falls back to a status-free stamp on the app pool; nothing here
 * ever throws, because the cron scans many connections.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@/lib/als';

const h = vi.hoisted(() => ({
  admin: [] as Array<{ label: string; text: string; values: unknown[]; inRequest: boolean }>,
  app: [] as Array<{ text: string; values: unknown[] }>,
  adminError: null as unknown,
  appError: null as unknown,
}));

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    h.app.push({ text: strings.join('?').replace(/\s+/g, ' ').trim(), values });
    if (h.appError) throw h.appError;
    return [];
  }),
}));
vi.mock('@/lib/auth/migrationAdminPool', () => ({
  migrationAdminTx: async (label: string, fn: (c: unknown) => Promise<unknown>) => {
    if (h.adminError) throw h.adminError;
    return fn({
      query: async (text: string, values: unknown[]) => {
        h.admin.push({ label, text: text.replace(/\s+/g, ' ').trim(), values, inRequest: Boolean(als.getStore()) });
        return { rows: [] };
      },
    });
  },
}));

import { als } from '@/lib/als';
import { drainAfterCommit } from '@/lib/afterCommit';
import { log } from '@/lib/logger';
import { markMirrorScanError } from '@/modules/accounting/services/capture/mirrorScanError';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const conn = { id: '22222222-2222-4222-8222-222222222222', companyId: COMPANY };
const KINDS = [['imap', 'imap_mirror_connections'], ['sent', 'sent_mirror_connections']] as const;
const lockTimeout = () => Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
const requestCtx = (extra: Partial<RequestContext> = {}): RequestContext =>
  ({ client: {} as RequestContext['client'], userId: 'u1', claims: {}, afterCommit: [], ...extra });

beforeEach(() => {
  h.admin.length = 0;
  h.app.length = 0;
  h.adminError = null;
  h.appError = null;
  vi.mocked(log.warn).mockClear();
  vi.mocked(log.error).mockClear();
});

describe.each(KINDS)('%s mirror, outside a request (the cron)', (kind, table) => {
  it('flips status on migration_admin now, keyed on id AND company_id; the app pool is untouched', async () => {
    await markMirrorScanError(kind, conn, 'boom');
    expect(h.admin).toHaveLength(1);
    const w = h.admin[0]!;
    expect(w.text).toContain(`UPDATE ${table}`);
    expect(w.text).toContain("status = CASE WHEN status = 'active' THEN 'error' ELSE status END");
    expect(w.text).toContain('WHERE id = $1::uuid AND company_id = $2::uuid');
    expect(w.values).toEqual([conn.id, COMPANY, 'boom']);
    expect(h.app).toHaveLength(0);
  });

  it('lock_not_available (55P03) is a warning, then a status-free stamp keyed on id AND company_id', async () => {
    h.adminError = lockTimeout();
    await markMirrorScanError(kind, conn, 'boom');
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.warn).mock.calls[0]![1]).toMatchObject({ connectionId: conn.id, code: '55P03' });
    expect(log.error).not.toHaveBeenCalled();
    expect(h.app).toHaveLength(1);
    const stamp = h.app[0]!;
    expect(stamp.text).toContain(`UPDATE ${table} SET last_scan_at = NOW(), last_error = ?`);
    expect(stamp.text).toContain('WHERE id = ?::uuid AND company_id = ?::uuid');
    expect(stamp.text).not.toContain('status');
    expect(stamp.values).toEqual(['boom', conn.id, COMPANY]);
  });

  it('any other failure is logged as an error with its code, then the same stamp', async () => {
    h.adminError = Object.assign(new Error('permission denied for table'), { code: '42501' });
    await markMirrorScanError(kind, conn, 'boom');
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.error).mock.calls[0]![1]).toMatchObject({ connectionId: conn.id, code: '42501' });
    expect(log.warn).not.toHaveBeenCalled();
    expect(h.app).toHaveLength(1);
    expect(h.app[0]!.values).toEqual(['boom', conn.id, COMPANY]);
  });

  it('a failure without a SQLSTATE (a dead pool) is an error too', async () => {
    h.adminError = new Error('connection terminated');
    await markMirrorScanError(kind, conn, 'boom');
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(h.app).toHaveLength(1);
  });

  it('never throws, even when the fallback stamp is refused too', async () => {
    h.adminError = lockTimeout();
    h.appError = new Error('connection terminated');
    await expect(markMirrorScanError(kind, conn, 'boom')).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});

describe.each(KINDS)('%s mirror, inside a request (scan-now)', (kind, table) => {
  it('stamps the error on the request now and defers the status flip until the request commits', async () => {
    const ctx = requestCtx();
    await als.run(ctx, () => markMirrorScanError(kind, conn, 'boom'));
    // Immediately: the stamp only, on the app pool (the request's own connection), keyed on id AND company_id.
    expect(h.app).toHaveLength(1);
    expect(h.app[0]!.text).toContain(`UPDATE ${table} SET last_scan_at = NOW(), last_error = ?`);
    expect(h.app[0]!.values).toEqual(['boom', conn.id, COMPANY]);
    expect(h.app[0]!.text).not.toContain('status');
    // The flip waits in the request's after-commit queue: no migration_admin write yet.
    expect(h.admin).toHaveLength(0);
    expect(ctx.afterCommit).toHaveLength(1);

    drainAfterCommit(ctx);
    await vi.waitFor(() => expect(h.admin).toHaveLength(1));
    expect(h.admin[0]!.text).toContain('WHERE id = $1::uuid AND company_id = $2::uuid');
    expect(h.admin[0]!.values).toEqual([conn.id, COMPANY, 'boom']);
    expect(h.admin[0]!.inRequest).toBe(false); // outside the request's context, on a connection of its own
  });

  it('a request that rolls back (queue never drained) flips nothing', async () => {
    await als.run(requestCtx(), () => markMirrorScanError(kind, conn, 'boom'));
    expect(h.admin).toHaveLength(0);
  });

  it('a flip that times out after the commit warns and stamps; it does not throw', async () => {
    const ctx = requestCtx();
    await als.run(ctx, () => markMirrorScanError(kind, conn, 'boom'));
    h.app.length = 0;
    h.adminError = lockTimeout();
    drainAfterCommit(ctx);
    await vi.waitFor(() => expect(h.app).toHaveLength(1));
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(h.app[0]!.text).toContain('AND company_id = ?::uuid');
    expect(h.app[0]!.values).toEqual(['boom', conn.id, COMPANY]);
  });

  it('a request that cannot run after-commit work (no queue) flips now rather than dropping the status', async () => {
    await als.run(requestCtx({ afterCommit: undefined }), () => markMirrorScanError(kind, conn, 'boom'));
    expect(h.admin).toHaveLength(1);
    expect(h.app).toHaveLength(0);
  });

  it('a finished request flips now rather than queueing on a dead context', async () => {
    await als.run(requestCtx({ finished: true }), () => markMirrorScanError(kind, conn, 'boom'));
    expect(h.admin).toHaveLength(1);
  });

  it('never throws when the stamp on the request is refused', async () => {
    h.appError = new Error('current transaction is aborted');
    await expect(als.run(requestCtx(), () => markMirrorScanError(kind, conn, 'boom'))).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});
