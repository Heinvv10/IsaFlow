/**
 * take_audit_snapshot's dry run without a database (the integration suite pins it against a real ledger): a dry run
 * previews and never takes, frees the idempotency key (wroteNothing), and the registry refuses a dry_run that is not a
 * boolean before any handler — "true" as a string was read as false and took an append-only snapshot.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  take: vi.fn(async () => ({ status: 'sealed', id: 'snap-1', lines: 2 })),
  preview: vi.fn(async () => ({ cutoff: '2026-06-30', lines: 2, maxLines: 150_000 })),
}));

vi.mock('@/lib/neon', () => {
  const sqlFn = Object.assign(vi.fn().mockResolvedValue([]), { transaction: vi.fn() });
  return { sql: sqlFn, withSavepoint: vi.fn((_n: string, cb: () => unknown) => cb()) };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth/autoRateLimit', () => ({ chargeAuditJob: vi.fn(async () => true) }));
vi.mock('@/modules/accounting/services/audit/snapshotService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/audit/snapshotService')>()), takeSnapshot: h.take,
}));
vi.mock('@/modules/accounting/services/audit/snapshotPreview', () => ({ previewSnapshot: h.preview }));
vi.mock('@/modules/accounting/services/audit/auditTx', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/audit/auditTx')>()),
  principalFromRequest: () => ({ userId: 'u', companyId: 'c', claims: {} }),
}));

import { takeAuditSnapshotTool } from '@/lib/mcp/tools/auditSnapshots';
import { McpRegistry } from '@/lib/mcp/registry';
import type { McpToolContext } from '@/lib/mcp/types';

const ctx = { userId: 'u', companyId: '22222222-2222-2222-2222-222222222222', scopes: ['read:reports', 'write:journals'],
  tokenJti: 'pat', oauthAppId: null, companyRole: 'owner' } as McpToolContext;

beforeEach(() => { h.take.mockClear(); h.preview.mockClear(); });

describe('take_audit_snapshot dry_run', () => {
  it('previews, never takes, and marks the result wroteNothing', async () => {
    const r = await takeAuditSnapshotTool.handler({ cutoff: '2026-06-30', dry_run: true, idempotency_key: 'k' }, ctx);
    expect(h.take).not.toHaveBeenCalled();
    expect(h.preview).toHaveBeenCalledWith({ userId: 'u', companyId: 'c', claims: {} }, '2026-06-30');
    expect(r.wroteNothing).toBe(true);
    expect(JSON.parse(r.content[0]!.text)).toMatchObject({ dryRun: true, journals: [], snapshot: { lines: 2, maxLines: 150_000 } });
  });

  it('takes when dry_run is false or absent, and the result keeps its key', async () => {
    for (const args of [{ dry_run: false }, {}]) {
      const r = await takeAuditSnapshotTool.handler({ cutoff: '2026-06-30', idempotency_key: 'k', ...args }, ctx);
      expect(r.wroteNothing).toBeUndefined();
    }
    expect(h.take).toHaveBeenCalledTimes(2);
    expect(h.preview).not.toHaveBeenCalled();
  });

  it('the registry refuses dry_run: true on a tool that has no dry run, before the handler', async () => {
    // A write tool without dry_run ran the LIVE call when asked for a preview: the caller believed nothing was written.
    const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: '"posted"' }] }));
    const registry = new McpRegistry();
    registry.register({ name: 'no_preview', description: 'x', scope: 'read:reports', write: true, handler,
      inputSchema: { type: 'object', properties: { idempotency_key: { type: 'string' } }, additionalProperties: false } });
    const r = await registry.call('no_preview', { dry_run: true, idempotency_key: 'k' }, ctx);
    expect([r.isError, r.content[0]!.text]).toEqual([true,
      'invalid arguments: no_preview has no dry run — this call would write. Call it without dry_run to run it for real.']);
    expect(handler).not.toHaveBeenCalled();
    // dry_run: false on such a tool is the live call it always was.
    expect((await registry.call('no_preview', { dry_run: false, idempotency_key: 'k2' }, ctx)).isError).toBeFalsy();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('the registry refuses a dry_run that is not a boolean, before the handler', async () => {
    const registry = new McpRegistry();
    registry.register(takeAuditSnapshotTool);
    for (const dry of ['true', 1, null]) {
      const r = await registry.call('take_audit_snapshot', { cutoff: '2026-06-30', dry_run: dry, idempotency_key: 'k' }, ctx);
      expect([r.isError, r.content[0]!.text], String(dry)).toEqual([true, 'invalid arguments: dry_run must be true or false']);
    }
    expect(h.take).not.toHaveBeenCalled();
    expect(h.preview).not.toHaveBeenCalled();
  });
});
