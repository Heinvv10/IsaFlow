/**
 * A supplier-statement reconciliation that is still being read, or failed to be, has no lines: it
 * is listed with its state (an interrupted read reported as failed, retryable), and it can be
 * neither rematched nor marked reconciled.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: Object.assign(m.sql, { unsafe: vi.fn().mockReturnValue('') }) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/ap/apAgingService', () => ({ getAPAgingDetail: vi.fn() }));

import {
  listReconciliations, markReconciled, rematchLines, ReconciliationNotReadyError,
} from '@/modules/accounting/services/capture/supplierStatementReconService';

const CO = 'aaaaaaaa-0000-0000-0000-000000000001';
const SUP = 'bbbbbbbb-0000-0000-0000-000000000002';
const RECON = 'eeeeeeee-0000-0000-0000-000000000005';

const squash = (t: string) => t.replace(/::\w+/g, '').replace(/\s+/g, ' ').trim();
const written = () => m.sql.mock.calls
  .map((c) => squash((c[0] as string[]).join('?')))
  .filter((t) => /^(INSERT|UPDATE|DELETE)/.test(t));

const header = (over: Record<string, unknown> = {}) => ({
  id: RECON, company_id: CO, supplier_id: SUP, supplier_name: 'Acme', source_document_id: 'doc',
  statement_date: '2026-10-17', period_start: null, period_end: null, supplier_balance: 0, isaflow_balance: 0, variance: 0,
  status: 'unreconciled', missing_in_isaflow_count: 0, missing_in_statement_count: 0, amount_diff_count: 0,
  created_at: new Date(), reconciled_at: null, extraction_heartbeat_at: null, extraction_error: null,
  extraction_error_code: null, extraction_pages_done: null, extraction_pages_total: null, ...over,
});
const longAgo = new Date(Date.now() - 60 * 60_000);

beforeEach(() => { m.sql.mockReset(); });

describe('listReconciliations', () => {
  it('shows each row\'s state, an interrupted read as failed and retryable', async () => {
    m.sql.mockResolvedValueOnce([
      header({ id: 'a', status: 'extracting', extraction_heartbeat_at: new Date(), extraction_pages_done: 1, extraction_pages_total: 4 }),
      header({ id: 'b', status: 'extracting', created_at: longAgo }),
      header({ id: 'c', status: 'failed', extraction_error: 'Page 1 of 2 could not be read. Retry the import.' }),
      header({ id: 'd', status: 'failed', extraction_error: 'This statement has 31 pages', extraction_error_code: 'too_many_pages' }),
      header({ id: 'e' }),
    ]);
    const list = await listReconciliations(CO);
    expect(list.map((r) => [r.id, r.status, r.retryable])).toEqual([
      ['a', 'extracting', false], ['b', 'failed', true], ['c', 'failed', true], ['d', 'failed', false], ['e', 'unreconciled', false],
    ]);
    expect(list[0]).toMatchObject({ pagesDone: 1, pagesTotal: 4 });
    expect(list[1].extractionError).toBe('Extraction was interrupted — retry it.');
    expect(list[2].extractionError).toBe('Page 1 of 2 could not be read. Retry the import.');
  });
});

describe('rematchLines', () => {
  for (const status of ['extracting', 'failed'] as const) {
    it(`refuses a ${status} reconciliation before writing anything`, async () => {
      m.sql.mockResolvedValueOnce([header({ status })]);
      await expect(rematchLines(CO, RECON)).rejects.toBeInstanceOf(ReconciliationNotReadyError);
      expect(written()).toEqual([]);
    });
  }

  it('refuses a stale extracting reconciliation too', async () => {
    m.sql.mockResolvedValueOnce([header({ status: 'extracting', created_at: longAgo })]);
    await expect(rematchLines(CO, RECON)).rejects.toBeInstanceOf(ReconciliationNotReadyError);
    expect(written()).toEqual([]);
  });
});

describe('ReconciliationNotReadyError', () => {
  it('says why, by state', () => {
    expect(new ReconciliationNotReadyError(RECON, 'extracting').message).toBe('This statement is still being read.');
    expect(new ReconciliationNotReadyError(RECON, 'failed').message).toBe('This statement could not be read; retry it or delete it.');
  });
});

describe('markReconciled', () => {
  it('only reconciles a reconciliation that has been read, in this company', async () => {
    m.sql.mockResolvedValueOnce([{ id: RECON }]);
    await markReconciled(CO, RECON, 'user');
    const call = m.sql.mock.calls[0]!;
    const t = squash((call[0] as string[]).join('?'));
    expect(t).toContain("WHERE id = ? AND company_id = ? AND status NOT IN ('extracting', 'failed')");
    expect(call.slice(1)).toContain(CO);
  });

  for (const status of ['extracting', 'failed'] as const) {
    it(`refuses a ${status} reconciliation`, async () => {
      m.sql.mockResolvedValueOnce([]); // guarded UPDATE matched nothing
      m.sql.mockResolvedValueOnce([header({ status })]); // why
      await expect(markReconciled(CO, RECON, 'user')).rejects.toBeInstanceOf(ReconciliationNotReadyError);
    });
  }

  it('still says not found for a reconciliation that is not there', async () => {
    m.sql.mockResolvedValueOnce([]);
    m.sql.mockResolvedValueOnce([]);
    await expect(markReconciled(CO, RECON, 'user')).rejects.toThrow(`Reconciliation ${RECON} not found`);
  });

  it('looks the reason up in this company only', async () => {
    m.sql.mockResolvedValueOnce([]);
    m.sql.mockResolvedValueOnce([]);
    await markReconciled(CO, RECON, 'user').catch(() => undefined);
    const why = m.sql.mock.calls[1]!;
    expect(squash((why[0] as string[]).join('?'))).toContain('company_id = ?');
    expect(why.slice(1)).toContain(CO);
  });
});
