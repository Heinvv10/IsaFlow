/**
 * Starting, retrying and deleting a supplier-statement reconciliation. The upload answers at once
 * with an 'extracting' row; the statement is read after the request commits. Retry and delete are
 * one guarded, company-scoped statement each.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  sql: vi.fn(),
  afterCommit: vi.fn<(label: string, fn: () => Promise<unknown>) => void>(),
  runJob: vi.fn(async () => undefined),
  fetchFull: vi.fn(),
}));
vi.mock('@/lib/neon', () => ({ sql: m.sql }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/afterCommit', () => ({ runAfterCommit: m.afterCommit }));
vi.mock('@/modules/accounting/services/shared/softDeleteLedgerPresence', () => ({ asAtTodayStr: () => '2026-10-17' }));
vi.mock('@/modules/accounting/services/capture/supplierStatementExtractionJob', () => ({ runSupplierStatementExtraction: m.runJob }));
vi.mock('@/modules/accounting/services/capture/supplierStatementReconDb', () => ({ fetchFullReconciliation: m.fetchFull }));

import {
  createReconciliation, deleteFailedReconciliation, retryReconciliation,
} from '@/modules/accounting/services/capture/supplierStatementLifecycle';

const CO = 'aaaaaaaa-0000-0000-0000-000000000001';
const SUP = 'bbbbbbbb-0000-0000-0000-000000000002';
const DOC = 'cccccccc-0000-0000-0000-000000000003';
const USER = 'dddddddd-0000-0000-0000-000000000004';
const RECON = 'eeeeeeee-0000-0000-0000-000000000005';

const text = (call: unknown[]) => (call[0] as string[]).join('?').replace(/::\w+/g, '').replace(/\s+/g, ' ').trim();
const headerRow = (over: Record<string, unknown> = {}) => ({ id: RECON, status: 'extracting', created_at: new Date(), ...over });
const full = { id: RECON, status: 'extracting' };

beforeEach(() => {
  vi.resetAllMocks();
  m.runJob.mockResolvedValue(undefined);
  m.fetchFull.mockResolvedValue(full);
});

describe('createReconciliation', () => {
  it('inserts the row as extracting with placeholder figures and answers with it', async () => {
    m.sql.mockResolvedValueOnce([{ id: RECON }]);
    const out = await createReconciliation(CO, SUP, DOC, USER);
    const insert = m.sql.mock.calls[0]!;
    expect(text(insert)).toContain('INSERT INTO supplier_statement_reconciliations');
    expect(text(insert)).toContain("0, 0, 0, 'extracting'");
    expect(insert.slice(1)).toEqual([CO, SUP, DOC, '2026-10-17', USER]);
    expect(m.fetchFull).toHaveBeenCalledWith(CO, RECON);
    expect(out).toBe(full);
  });

  it('queues the extraction for after the request commits, and does not run it inline', async () => {
    m.sql.mockResolvedValueOnce([{ id: RECON }]);
    await createReconciliation(CO, SUP, DOC, USER);
    expect(m.afterCommit).toHaveBeenCalledTimes(1);
    expect(m.runJob).not.toHaveBeenCalled();
    await m.afterCommit.mock.calls[0]![1]();
    expect(m.runJob).toHaveBeenCalledWith(CO, RECON);
  });

  it('throws, and queues nothing, when the insert returns no row', async () => {
    m.sql.mockResolvedValueOnce([]);
    await expect(createReconciliation(CO, SUP, DOC, USER)).rejects.toThrow('Failed to insert reconciliation header');
    expect(m.afterCommit).not.toHaveBeenCalled();
  });

  it('throws when the new row cannot be read back', async () => {
    m.sql.mockResolvedValueOnce([{ id: RECON }]);
    m.fetchFull.mockResolvedValue(null);
    await expect(createReconciliation(CO, SUP, DOC, USER)).rejects.toThrow('Failed to retrieve created reconciliation');
  });
});

describe('retryReconciliation', () => {
  it('puts a failed (or stale) reconciliation back to extracting with one guarded UPDATE for this company, then queues the job', async () => {
    m.sql.mockResolvedValueOnce([{ id: RECON }]);
    const out = await retryReconciliation(CO, RECON);
    const update = m.sql.mock.calls[0]!;
    const t = text(update);
    expect(t).toContain("SET status = 'extracting'");
    expect(t).toContain('extraction_error = NULL');
    expect(t).toContain('extraction_heartbeat_at = NOW()');
    expect(t).toContain('WHERE id = ? AND company_id = ?');
    expect(t).toContain("status = 'failed'");
    expect(t).toContain("status = 'extracting' AND COALESCE(extraction_heartbeat_at, created_at) < NOW() - make_interval(mins => ?)");
    expect(t).toContain("extraction_error_code IS DISTINCT FROM 'too_many_pages'");
    expect(update.slice(1)).toEqual([RECON, CO, 5]);
    expect(out).toBe(full);
    await m.afterCommit.mock.calls[0]![1]();
    expect(m.runJob).toHaveBeenCalledWith(CO, RECON);
  });

  it('refuses, and starts nothing, when the guarded UPDATE matched no row (double click)', async () => {
    m.sql.mockResolvedValueOnce([]);
    m.sql.mockResolvedValueOnce([headerRow()]);
    await expect(retryReconciliation(CO, RECON)).rejects.toMatchObject({ code: 'IN_PROGRESS' });
    expect(m.afterCommit).not.toHaveBeenCalled();
  });

  it('says a too-long statement cannot be retried', async () => {
    m.sql.mockResolvedValueOnce([]);
    m.sql.mockResolvedValueOnce([headerRow({ status: 'failed', extraction_error_code: 'too_many_pages' })]);
    await expect(retryReconciliation(CO, RECON)).rejects.toMatchObject({ code: 'NOT_RETRYABLE' });
  });

  it('says a finished reconciliation cannot be retried', async () => {
    m.sql.mockResolvedValueOnce([]);
    m.sql.mockResolvedValueOnce([headerRow({ status: 'unreconciled' })]);
    await expect(retryReconciliation(CO, RECON)).rejects.toMatchObject({ code: 'NOT_RETRYABLE' });
  });

  it('says a reconciliation that is not there is not there, looking in this company only', async () => {
    m.sql.mockResolvedValueOnce([]);
    m.sql.mockResolvedValueOnce([]);
    await expect(retryReconciliation(CO, RECON)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const why = m.sql.mock.calls[1]!;
    expect(text(why)).toContain('company_id = ?');
    expect(why.slice(1)).toContain(CO);
  });
});

describe('deleteFailedReconciliation', () => {
  it('deletes only a failed (or stale) reconciliation of this company', async () => {
    m.sql.mockResolvedValueOnce([{ id: RECON }]);
    await expect(deleteFailedReconciliation(CO, RECON)).resolves.toBeUndefined();
    const del = m.sql.mock.calls[0]!;
    const t = text(del);
    expect(t).toContain('DELETE FROM supplier_statement_reconciliations');
    expect(t).toContain('WHERE id = ? AND company_id = ?');
    expect(t).toContain("status = 'failed'");
    expect(t).toContain("status = 'extracting' AND COALESCE(extraction_heartbeat_at, created_at) < NOW() - make_interval(mins => ?)");
    expect(del.slice(1)).toEqual([RECON, CO, 5]);
  });

  it('refuses a reconciliation that has been read', async () => {
    m.sql.mockResolvedValueOnce([]);
    m.sql.mockResolvedValueOnce([headerRow({ status: 'unreconciled' })]);
    await expect(deleteFailedReconciliation(CO, RECON)).rejects.toMatchObject({ code: 'NOT_FAILED' });
  });

  it('refuses one that is still being read', async () => {
    m.sql.mockResolvedValueOnce([]);
    m.sql.mockResolvedValueOnce([headerRow()]);
    await expect(deleteFailedReconciliation(CO, RECON)).rejects.toMatchObject({ code: 'IN_PROGRESS' });
  });

  it('says a reconciliation that is not there is not there', async () => {
    m.sql.mockResolvedValueOnce([]);
    m.sql.mockResolvedValueOnce([]);
    await expect(deleteFailedReconciliation(CO, RECON)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
