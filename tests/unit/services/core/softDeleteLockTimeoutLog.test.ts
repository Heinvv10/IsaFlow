/**
 * D8 round 13 (review rev-d8-00043b42d F2): since round 11 an invoice's soft delete and its undo run under the flow
 * lock budget, so a lock wait that runs out is an expected outcome the route answers 503 + Retry-After. The service's
 * catch logged every failure at ERROR (a Bugsink event per contention). A lock timeout — the raw 55P03 the budget
 * converts, or a nested helper's typed timeout — is logged at info; anything else stays an error. Both rethrow.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: (_n: string, fn: () => Promise<unknown>) => fn() }));
const prepareInvoiceDelete = vi.fn();
const reinstateInvoiceJournal = vi.fn();
vi.mock('@/modules/accounting/services/core/softDeleteJournalService', () => ({
  prepareInvoiceDelete: (...a: unknown[]) => prepareInvoiceDelete(...a),
  reinstateInvoiceJournal: (...a: unknown[]) => reinstateInvoiceJournal(...a),
}));
vi.mock('@/modules/accounting/services/core/softDeleteRowOps', () => ({
  softDeleteRow: vi.fn(async () => true), restoreRow: vi.fn(async () => true),
}));
vi.mock('@/modules/accounting/services/core/masterDeleteGuards', () => ({ assertNoOpenDocuments: vi.fn() }));

import { log } from '@/lib/logger';
import { softDelete, undoDelete } from '@/modules/accounting/services/core/softDeleteService';
import { JournalReversalLockTimeoutError } from '@/modules/accounting/services/gl/journalEntryReversalClaim';

const ID = '66666666-6666-4666-8666-666666666666';
const pgLockTimeout = () => Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });

beforeEach(() => { vi.clearAllMocks(); });

describe.each([
  ['softDelete', 'Soft delete failed', () => prepareInvoiceDelete, () => softDelete('co', 'customer_invoice', ID, 'u')],
  ['undoDelete', 'Undo delete failed', () => reinstateInvoiceJournal, () => undoDelete('co', 'customer_invoice', ID, 'u')],
] as const)('%s', (_name, message, step, run) => {
  it.each([
    ['the raw 55P03 inside the flow budget', pgLockTimeout],
    ['a nested helper\'s typed timeout', () => new JournalReversalLockTimeoutError(ID)],
  ])('logs %s at info, not error, and rethrows it', async (_what, make) => {
    const err = make();
    step().mockRejectedValueOnce(err);
    await expect(run()).rejects.toBe(err);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(message, expect.objectContaining({ entityId: ID }), 'accounting');
  });

  it('still logs any other failure at error', async () => {
    const err = new Error('boom');
    step().mockRejectedValueOnce(err);
    await expect(run()).rejects.toBe(err);
    expect(log.error).toHaveBeenCalledWith(message, expect.objectContaining({ error: err }), 'accounting');
  });
});
