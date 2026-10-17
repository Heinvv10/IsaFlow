/**
 * The background job that reads an uploaded supplier statement. It runs after the request
 * committed, outside any transaction and as the pool role with no row-level security, so EVERY
 * statement it issues must name the company (the lines table has no company column: its writes
 * come only after the company-scoped reconciliation row is locked). Every move out of
 * 'extracting' is guarded, so a row that was retried or deleted meanwhile is never overwritten by
 * a late result, and its lines are not rewritten either.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  sql: vi.fn(),
  extract: vi.fn(),
  measure: vi.fn(),
  loadInvoices: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('@/lib/neon', () => ({
  sql: m.sql,
  withTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(m.sql),
}));
vi.mock('@/lib/logger', () => ({ log: { info: m.info, warn: m.warn, error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/capture/supplierStatementExtraction', () => ({ extractSupplierStatementFromDocument: m.extract }));
vi.mock('@/modules/accounting/services/capture/supplierStatementMeasure', () => ({ measureOurSide: m.measure }));
vi.mock('@/modules/accounting/services/shared/softDeleteLedgerPresence', () => ({ asAtTodayStr: () => '2026-10-17' }));
vi.mock('@/modules/accounting/services/capture/supplierStatementReconDb', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/capture/supplierStatementReconDb')>()),
  loadSupplierInvoices: m.loadInvoices,
}));

import { StatementReadError } from '@/modules/accounting/services/bank/vlmStatementPages';
import { runSupplierStatementExtraction } from '@/modules/accounting/services/capture/supplierStatementExtractionJob';

const CO = 'aaaaaaaa-0000-0000-0000-000000000001';
const SUP = 'bbbbbbbb-0000-0000-0000-000000000002';
const DOC = 'cccccccc-0000-0000-0000-000000000003';
const RECON = 'eeeeeeee-0000-0000-0000-000000000005';

interface Call { text: string; values: unknown[] }
const calls: Call[] = [];
const squash = (t: string) => t.replace(/::\w+/g, '').replace(/\s+/g, ' ').trim();
const text = (c: Call) => squash(c.text);
const callsOn = (needle: string) => calls.filter((c) => text(c).includes(needle));
const orderOf = (needle: string) => calls.findIndex((c) => text(c).includes(needle));

let db: { claim: unknown[]; lock: unknown[]; failed: unknown[] };

const extraction = (over: Record<string, unknown> = {}) => ({
  supplierName: 'Acme', statementDate: '2026-03-31', periodStart: '2026-03-01', periodEnd: '2026-03-31',
  openingBalance: 0, closingBalance: 115, warnings: ['w1'],
  lines: [{ date: '2026-03-02', reference: 'INV-1', description: 'Widgets', debit: 115 }], ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  calls.length = 0;
  db = { claim: [{ supplier_id: SUP, source_document_id: DOC }], lock: [{ id: RECON }], failed: [{ id: RECON }] };
  m.sql.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const c = { text: strings.join('?'), values };
    calls.push(c);
    const t = text(c);
    if (t.startsWith('SELECT supplier_id')) return db.claim;
    if (t.includes('FOR UPDATE')) return db.lock;
    if (t.includes("SET status = 'failed'")) return db.failed;
    return [{ id: RECON }];
  });
  m.extract.mockResolvedValue(extraction());
  m.measure.mockResolvedValue({ isaflowBalance: 100, variance: 15 });
  m.loadInvoices.mockResolvedValue([{ id: 'inv-a', invoiceNumber: 'INV-1', invoiceDate: '2026-03-02', totalAmount: 115 }]);
});

describe('runSupplierStatementExtraction — success', () => {
  it('measures our side at the statement date and moves the row to unreconciled, guarded to extracting', async () => {
    await runSupplierStatementExtraction(CO, RECON);
    expect(m.measure).toHaveBeenCalledWith(CO, SUP, '2026-03-31', 115);
    expect(m.loadInvoices).toHaveBeenCalledWith(CO, SUP, '2026-03-01', '2026-03-31');
    const [done] = callsOn("status = 'unreconciled'");
    expect(text(done)).toContain("WHERE id = ? AND company_id = ? AND status = 'extracting'");
    expect(done.values).toEqual(['2026-03-31', '2026-03-01', '2026-03-31', 115, 100, 15, 0, 0, 0, RECON, CO]);
    expect(text(done)).toContain('extraction_error = NULL, extraction_error_code = NULL');
  });

  it('writes the matched lines and the counts from them', async () => {
    await runSupplierStatementExtraction(CO, RECON);
    expect(callsOn('INSERT INTO supplier_statement_lines')).toHaveLength(1);
    const [done] = callsOn("status = 'unreconciled'");
    // one matched line, no missing ones: missing_in_isaflow, missing_in_statement, amount_diff
    expect(text(done)).toContain('missing_in_isaflow_count = ?, missing_in_statement_count = ?, amount_diff_count = ?');
    expect(done.values.slice(6, 9)).toEqual([0, 0, 0]);
  });

  it('counts a statement line the bills do not have as missing in IsaFlow', async () => {
    m.loadInvoices.mockResolvedValue([]);
    await runSupplierStatementExtraction(CO, RECON);
    const [done] = callsOn("status = 'unreconciled'");
    expect(done.values.slice(6, 9)).toEqual([1, 0, 0]);
  });

  it('counts a bill in the period the statement does not list as missing from the statement', async () => {
    m.extract.mockResolvedValue(extraction({ lines: [] }));
    await runSupplierStatementExtraction(CO, RECON);
    const [done] = callsOn("status = 'unreconciled'");
    expect(done.values.slice(6, 9)).toEqual([0, 1, 0]);
  });

  it('counts a statement line whose amount differs from its bill', async () => {
    m.extract.mockResolvedValue(extraction({ lines: [{ date: '2026-03-02', reference: 'INV-1', debit: 120 }] }));
    await runSupplierStatementExtraction(CO, RECON);
    const [done] = callsOn("status = 'unreconciled'");
    expect(done.values.slice(6, 9)).toEqual([0, 0, 1]);
  });

  it('writes the lines only after the company-scoped row has been locked, in the same transaction', async () => {
    await runSupplierStatementExtraction(CO, RECON);
    const lock = orderOf('FOR UPDATE');
    expect(lock).toBeGreaterThan(-1);
    expect(text(calls[lock])).toContain("WHERE id = ? AND company_id = ? AND status = 'extracting' FOR UPDATE");
    expect(calls[lock].values).toEqual([RECON, CO]);
    expect(orderOf('DELETE FROM supplier_statement_lines')).toBeGreaterThan(lock);
    expect(orderOf('INSERT INTO supplier_statement_lines')).toBeGreaterThan(lock);
    expect(orderOf("status = 'unreconciled'")).toBeGreaterThan(orderOf('INSERT INTO supplier_statement_lines'));
  });

  it('dates a statement that printed no date today, and gives it a zero balance when it printed none', async () => {
    m.extract.mockResolvedValue(extraction({ statementDate: undefined, closingBalance: undefined, periodStart: undefined, periodEnd: undefined }));
    await runSupplierStatementExtraction(CO, RECON);
    expect(m.measure).toHaveBeenCalledWith(CO, SUP, '2026-10-17', 0);
    expect(m.loadInvoices).toHaveBeenCalledWith(CO, SUP, null, null);
  });

  it('reads the document by company', async () => {
    await runSupplierStatementExtraction(CO, RECON);
    expect(m.extract.mock.calls[0][0]).toBe(CO);
    expect(m.extract.mock.calls[0][1]).toBe(DOC);
  });

  it('logs the warnings of the read', async () => {
    await runSupplierStatementExtraction(CO, RECON);
    expect(m.warn).toHaveBeenCalledWith(expect.stringContaining('warnings'), expect.objectContaining({ warnings: ['w1'] }), expect.anything());
  });
});

describe('runSupplierStatementExtraction — superseded', () => {
  it('does nothing for a row that is not extracting', async () => {
    db.claim = [];
    await runSupplierStatementExtraction(CO, RECON);
    expect(m.extract).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(text(calls[0])).toContain("company_id = ? AND status = 'extracting'");
    expect(m.warn).toHaveBeenCalledWith(expect.stringContaining('no longer extracting'), expect.anything(), expect.anything());
  });

  it('writes no lines when the row stopped extracting while it was being read, and does not call that complete', async () => {
    db.lock = [];
    await runSupplierStatementExtraction(CO, RECON);
    expect(callsOn('supplier_statement_lines')).toEqual([]);
    expect(callsOn("status = 'unreconciled'")).toEqual([]);
    expect(m.warn).toHaveBeenCalledWith(expect.stringContaining('no longer extracting'), expect.anything(), expect.anything());
    expect(m.info.mock.calls.map((c) => String(c[0])).join('|')).not.toContain('extraction complete');
  });
});

describe('runSupplierStatementExtraction — failure', () => {
  const failedWith = () => callsOn("SET status = 'failed'")[0];

  it('stores the user-safe message and code of a read error, guarded to extracting', async () => {
    m.extract.mockRejectedValue(new StatementReadError('too_many_pages', 'This statement has 31 pages; the most IsaFlow reads is 20.'));
    await expect(runSupplierStatementExtraction(CO, RECON)).resolves.toBeUndefined();
    const f = failedWith();
    expect(f.values).toEqual(expect.arrayContaining(['This statement has 31 pages; the most IsaFlow reads is 20.', 'too_many_pages', RECON, CO]));
    expect(text(f)).toContain("WHERE id = ? AND company_id = ? AND status = 'extracting'");
    expect(callsOn('supplier_statement_lines')).toEqual([]);
  });

  it('hides an unexpected error behind a generic message', async () => {
    m.extract.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.9:5432'));
    await runSupplierStatementExtraction(CO, RECON);
    expect(failedWith().values).toContain('The statement could not be read. Retry the import.');
    expect(JSON.stringify(failedWith().values)).not.toContain('ECONNREFUSED');
  });

  it('fails the row when measuring our side throws', async () => {
    m.measure.mockRejectedValue(new Error('ageing exploded'));
    await runSupplierStatementExtraction(CO, RECON);
    expect(failedWith()).toBeDefined();
    expect(callsOn('INSERT INTO supplier_statement_lines')).toEqual([]);
  });

  it('does not throw even when recording the failure fails', async () => {
    m.extract.mockRejectedValue(new Error('boom'));
    m.sql.mockImplementation(async (strings: TemplateStringsArray) => {
      if (squash(strings.join('?')).startsWith('SELECT supplier_id')) return db.claim;
      throw new Error('db down');
    });
    await expect(runSupplierStatementExtraction(CO, RECON)).resolves.toBeUndefined();
  });
});

describe('runSupplierStatementExtraction — heartbeat', () => {
  it('records each page read on the row, guarded to this company and to extracting', async () => {
    m.extract.mockImplementation(async (_co: string, _doc: string, onProgress: (d: number, t: number) => Promise<void>) => {
      await onProgress(3, 12);
      return extraction();
    });
    await runSupplierStatementExtraction(CO, RECON);
    const [beat] = callsOn('extraction_heartbeat_at = NOW()');
    expect(text(beat)).toContain('extraction_pages_done = ?, extraction_pages_total = ?');
    expect(text(beat)).toContain("WHERE id = ? AND company_id = ? AND status = 'extracting'");
    expect(beat.values).toEqual([3, 12, RECON, CO]);
  });
});

describe('every statement the job issues', () => {
  it('names the company, except the line writes that follow the company-scoped lock', async () => {
    m.extract.mockImplementation(async (_co: string, _doc: string, onProgress: (d: number, t: number) => Promise<void>) => {
      await onProgress(1, 2);
      return extraction();
    });
    await runSupplierStatementExtraction(CO, RECON);
    m.extract.mockRejectedValue(new Error('x'));
    await runSupplierStatementExtraction(CO, RECON);
    expect(calls.length).toBeGreaterThanOrEqual(7);
    for (const c of calls.filter((x) => !text(x).includes('supplier_statement_lines'))) {
      expect(text(c), text(c)).toContain('company_id = ?');
      expect(c.values, text(c)).toContain(CO);
    }
  });
});
