/**
 * undoTransferLinks (migration 978): puts statement lines back as they were before an automatic transfer link.
 * The SQL guards (updated_at unchanged, tenant scope, the veto) are proven against PostgreSQL in
 * tests/integration/bank-transfer-link-log-undo.int.test.ts; this file pins the control flow around them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as string[],
  active: [] as Array<Record<string, unknown>>,
  restored: [] as Array<Record<string, unknown>> | Error,
  audit: vi.fn(),
  lock: vi.fn(),
}));

vi.mock('@/lib/neon', () => ({
  sql: Object.assign(vi.fn((strings: TemplateStringsArray) => {
    const text = strings.join('?');
    if (/WITH restored AS/.test(text)) {
      h.calls.push('restore');
      if (h.restored instanceof Error) return Promise.reject(h.restored);
      return Promise.resolve(h.restored);
    }
    if (/FROM bank_transfer_link_log/.test(text)) { h.calls.push('select'); return Promise.resolve(h.active); }
    return Promise.resolve([]);
  }), { unsafe: vi.fn() }),
  withTransaction: vi.fn(),
  withSavepoint: (_name: string, fn: () => Promise<unknown>) => { h.calls.push('savepoint'); return fn(); },
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/bank/bankTxLock', () => ({
  lockBankTransactionsInIdOrder: (...a: unknown[]) => { h.calls.push('lock'); return h.lock(...a); },
}));
vi.mock('@/modules/accounting/services/core/auditTrailService', () => ({
  logAuditOrThrow: (...a: unknown[]) => h.audit(...a),
}));

import {
  TransferLinkUndoError, UNDO_CHANGED_BATCH_MESSAGE, UNDO_CHANGED_LINE_MESSAGE, UNDO_NOT_FOUND_MESSAGE, undoTransferLinks,
} from '@/modules/accounting/services/bank/bankTransferLinkUndo';

const CO = '11111111-1111-4111-8111-111111111111';
const USER = { id: 'user-1', email: 'u@example.test' };
const row = (id: string, tx: string) => ({ id, bank_transaction_id: tx });
const done = (id: string, tx: string) => ({
  id, bank_transaction_id: tx, prev_status: 'imported', prev_allocation_type: null, link_batch_id: 'batch-1',
});

async function codeOf(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; } catch (err) {
    expect(err).toBeInstanceOf(TransferLinkUndoError);
    return { code: (err as TransferLinkUndoError).code, message: (err as Error).message };
  }
  throw new Error('expected a TransferLinkUndoError');
}

beforeEach(() => {
  h.calls = [];
  h.active = [row('l1', 't1'), row('l2', 't2')];
  h.restored = [done('l1', 't1'), done('l2', 't2')];
  h.audit.mockReset().mockResolvedValue(undefined);
  h.lock.mockReset().mockResolvedValue([]);
});

describe('undoTransferLinks', () => {
  it('is NOT_FOUND when no live log row matches, and locks nothing', async () => {
    h.active = [];
    expect(await codeOf(undoTransferLinks(CO, { linkId: 'l9' }, USER))).toEqual({ code: 'NOT_FOUND', message: UNDO_NOT_FOUND_MESSAGE });
    expect(h.calls).toEqual(['select']);
  });

  it('locks the lines (company, line ids) before the guarded restore, inside a savepoint', async () => {
    await undoTransferLinks(CO, { batchId: 'batch-1' }, USER);
    expect(h.calls).toEqual(['select', 'lock', 'savepoint', 'restore']);
    expect(h.lock).toHaveBeenCalledWith(CO, ['t1', 't2']);
  });

  it('is CHANGED when the restore matches nothing, with the per-line or per-batch sentence', async () => {
    h.restored = [];
    expect(await codeOf(undoTransferLinks(CO, { linkId: 'l1' }, USER))).toEqual({ code: 'CHANGED', message: UNDO_CHANGED_LINE_MESSAGE });
    expect(await codeOf(undoTransferLinks(CO, { batchId: 'b' }, USER))).toEqual({ code: 'CHANGED', message: UNDO_CHANGED_BATCH_MESSAGE });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('counts undone and refused lines', async () => {
    h.restored = [done('l2', 't2')];
    expect(await undoTransferLinks(CO, { batchId: 'batch-1' }, USER)).toEqual({ undone: 1, refused: 1 });
  });

  it('writes one audit row per restored line, naming the line and the link', async () => {
    await undoTransferLinks(CO, { batchId: 'batch-1' }, USER);
    expect(h.audit).toHaveBeenCalledTimes(2);
    const first = h.audit.mock.calls[0][0];
    expect(first).toMatchObject({
      companyId: CO, userId: 'user-1', userEmail: 'u@example.test', action: 'update',
      entityType: 'bank_transaction', entityId: 't1',
      changes: { metadata: { source: 'transfer_link_undo', linkBatchId: 'batch-1', linkId: 'l1' } },
    });
    expect(first.changes.fields[0]).toEqual({ field: 'status', old: 'allocated', new: 'imported', label: 'Status' });
  });

  it('lets an audit failure propagate (an unrecorded undo does not commit)', async () => {
    h.audit.mockRejectedValueOnce(new Error('audit down'));
    await expect(undoTransferLinks(CO, { linkId: 'l1' }, USER)).rejects.toThrow('audit down');
  });

  it('turns a unique violation in the restore (previous journal line since claimed) into CHANGED', async () => {
    h.restored = Object.assign(new Error('duplicate key value'), { code: '23505' });
    expect((await codeOf(undoTransferLinks(CO, { linkId: 'l1' }, USER))).code).toBe('CHANGED');
  });

  it('rethrows any other database error', async () => {
    h.restored = Object.assign(new Error('boom'), { code: 'XX000' });
    await expect(undoTransferLinks(CO, { linkId: 'l1' }, USER)).rejects.toThrow('boom');
  });
});
