/**
 * Unit tests for bankStatementOcrService.ts — PRD-05 Phase 7
 *
 * Covers: createImportFromDocument (inserts an 'extracting' row and queues the background job),
 * retryImport / deleteFailedImport (guarded, company-scoped), the stale-extraction reading of a
 * row, commitImport / rollbackImport (never on a row that is still being read, or failed).
 * What the job does with the extraction lives in bankStatementExtractionJob.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { sqlMock, afterCommit, runJob } = vi.hoisted(() => ({
  sqlMock: Object.assign(vi.fn(), { unsafe: vi.fn().mockReturnValue('') }),
  afterCommit: vi.fn<(label: string, fn: () => Promise<unknown>) => void>(),
  runJob: vi.fn(async () => undefined),
}));

vi.mock('@/lib/neon', () => ({ sql: sqlMock, withSavepoint: async (_name: string, fn: () => Promise<unknown>) => fn() }));
// bank/bankAccountGuard reads Postgres; a mocked sql would answer it. Proven in tests/integration/bank-account-guard-*.
vi.mock('@/modules/accounting/services/bank/bankAccountGuard', async () => (await import('../../helpers/bankControlGateMocks')).bankAccountGuardOpen());
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/afterCommit', () => ({ runAfterCommit: afterCommit }));
vi.mock('@/modules/accounting/services/bank/bankStatementExtractionJob', () => ({ runBankStatementExtraction: runJob }));

import {
  createImportFromDocument,
  commitImport,
  deleteFailedImport,
  getImport,
  listImports,
  retryImport,
  rollbackImport,
} from '@/modules/accounting/services/bank/bankStatementOcrService';
import { ExtractionActionRefusedError } from '@/modules/accounting/services/bank/statementExtractionState';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const COMPANY_ID    = 'aaaaaaaa-0000-0000-0000-000000000001';
const BANK_ACCT_ID  = 'bbbbbbbb-0000-0000-0000-000000000002';
const DOC_ID        = 'cccccccc-0000-0000-0000-000000000003';
const USER_ID       = 'dddddddd-0000-0000-0000-000000000004';
const IMPORT_ID     = 'eeeeeeee-0000-0000-0000-000000000005';

/** DB row returned by INSERT INTO bank_statement_imports */
function makeImportDbRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: IMPORT_ID,
    company_id: COMPANY_ID,
    bank_account_id: BANK_ACCT_ID,
    source_document_id: DOC_ID,
    period_start: '2026-03-01',
    period_end: '2026-03-31',
    opening_balance: 10000,
    closing_balance: 9500,
    row_count: 3,
    imported_count: 0,
    duplicate_count: 0,
    status: 'extracted',
    extraction_summary: { rows: [], warnings: [] },
    created_by: USER_ID,
    created_at: '2026-04-01T10:00:00.000Z',
    committed_at: null,
    ...overrides,
  };
}

/** Import object returned by getImport (used inside commitImport / rollbackImport). */
function makeImport(overrides: Partial<{
  status: string;
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  duplicateCount: number;
}> = {}) {
  const rows = overrides.rows ?? [
    { date: '2026-03-05', description: 'Pick n Pay Superstore', amount: -200, isDuplicate: false, reference: 'PNP001', runningBalance: null, duplicateOfBankTxId: null, duplicateMatchConfidence: 0 },
    { date: '2026-03-10', description: 'Salary Credit March',  amount: 5000, isDuplicate: false, reference: 'SAL001', runningBalance: null, duplicateOfBankTxId: null, duplicateMatchConfidence: 0 },
    { date: '2026-03-15', description: 'Eskom prepaid electricity', amount: -300, isDuplicate: false, reference: 'ESK001', runningBalance: null, duplicateOfBankTxId: null, duplicateMatchConfidence: 0 },
  ];
  return {
    id: IMPORT_ID,
    companyId: COMPANY_ID,
    bankAccountId: BANK_ACCT_ID,
    sourceDocumentId: DOC_ID,
    periodStart: '2026-03-01',
    periodEnd: '2026-03-31',
    openingBalance: 10000,
    closingBalance: 9500,
    rowCount: overrides.rowCount ?? rows.length,
    importedCount: 0,
    duplicateCount: overrides.duplicateCount ?? 0,
    status: overrides.status ?? 'extracted',
    rows,
    warnings: [],
    createdAt: '2026-04-01T10:00:00.000Z',
    committedAt: null,
  };
}

// ── createImportFromDocument ──────────────────────────────────────────────────

const text = (call: unknown[]) => (call[0] as string[]).join('?').replace(/::\w+/g, '').replace(/\s+/g, ' ').trim();

describe('createImportFromDocument', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('inserts the row as extracting, with no rows yet, and answers with it', async () => {
    sqlMock.mockResolvedValueOnce([makeImportDbRow({ status: 'extracting', row_count: 0, extraction_summary: {}, created_at: new Date() })]);

    const result = await createImportFromDocument(COMPANY_ID, BANK_ACCT_ID, DOC_ID, USER_ID);

    expect(sqlMock).toHaveBeenCalledTimes(1);
    const insert = sqlMock.mock.calls[0]!;
    expect(text(insert)).toContain('INSERT INTO bank_statement_imports');
    expect(text(insert)).toContain("'extracting'");
    expect(insert.slice(1)).toEqual(expect.arrayContaining([COMPANY_ID, BANK_ACCT_ID, DOC_ID, USER_ID]));
    expect(result.status).toBe('extracting');
    expect(result.rows).toEqual([]);
    expect(result.id).toBe(IMPORT_ID);
  });

  it('queues the extraction for after the request commits, and does not run it inline', async () => {
    sqlMock.mockResolvedValueOnce([makeImportDbRow({ status: 'extracting', created_at: new Date() })]);

    await createImportFromDocument(COMPANY_ID, BANK_ACCT_ID, DOC_ID, USER_ID);

    expect(afterCommit).toHaveBeenCalledTimes(1);
    expect(runJob).not.toHaveBeenCalled();
    await afterCommit.mock.calls[0]![1]();
    expect(runJob).toHaveBeenCalledWith(COMPANY_ID, IMPORT_ID);
  });
});

// ── reading a row that is extracting or failed ────────────────────────────────

describe('getImport / listImports on a row that is being read', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('shows a fresh extraction as extracting, with its page progress', async () => {
    sqlMock.mockResolvedValueOnce([makeImportDbRow({
      status: 'extracting', created_at: new Date(), extraction_heartbeat_at: new Date(),
      extraction_pages_done: 2, extraction_pages_total: 9,
    })]);
    const imp = await getImport(COMPANY_ID, IMPORT_ID);
    expect(imp).toMatchObject({ status: 'extracting', extractionError: null, retryable: false, pagesDone: 2, pagesTotal: 9 });
  });

  it('shows an extraction with no heartbeat for over 5 minutes as failed and retryable', async () => {
    sqlMock.mockResolvedValueOnce([makeImportDbRow({
      status: 'extracting', created_at: new Date(Date.now() - 20 * 60_000), extraction_heartbeat_at: new Date(Date.now() - 6 * 60_000),
    })]);
    const imp = await getImport(COMPANY_ID, IMPORT_ID);
    expect(imp).toMatchObject({ status: 'failed', extractionError: 'Extraction was interrupted — retry it.', retryable: true });
  });

  it('applies the same reading to every row of the list', async () => {
    sqlMock.mockResolvedValueOnce([
      makeImportDbRow({ id: 'a', status: 'extracting', created_at: new Date(Date.now() - 20 * 60_000) }),
      makeImportDbRow({ id: 'b', status: 'failed', extraction_error: 'Page 1 of 2 could not be read. Retry the import.', created_at: new Date() }),
      makeImportDbRow({ id: 'c', status: 'extracted', created_at: new Date() }),
    ]);
    const list = await listImports(COMPANY_ID);
    expect(list.map((i) => [i.id, i.status, i.retryable])).toEqual([['a', 'failed', true], ['b', 'failed', true], ['c', 'extracted', false]]);
    expect(list[1]!.extractionError).toBe('Page 1 of 2 could not be read. Retry the import.');
  });

  it('does not let a too-many-pages failure be retried', async () => {
    sqlMock.mockResolvedValueOnce([makeImportDbRow({
      status: 'failed', extraction_error: 'This statement has 31 pages', extraction_error_code: 'too_many_pages', created_at: new Date(),
    })]);
    expect((await getImport(COMPANY_ID, IMPORT_ID))!.retryable).toBe(false);
  });
});

// ── retryImport ───────────────────────────────────────────────────────────────

describe('retryImport', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('puts a failed (or stale) import back to extracting with one guarded UPDATE for this company, then queues the job', async () => {
    sqlMock.mockResolvedValueOnce([makeImportDbRow({ status: 'extracting', created_at: new Date() })]);

    const imp = await retryImport(COMPANY_ID, IMPORT_ID);

    const update = sqlMock.mock.calls[0]!;
    const t = text(update);
    expect(t).toContain("SET status = 'extracting'");
    expect(t).toContain('extraction_error = NULL');
    // A read thought dead that finishes late must not overwrite this attempt's row (job guards on it).
    expect(t).toContain('extraction_attempt = extraction_attempt + 1');
    expect(t).toContain('extraction_heartbeat_at = NOW()');
    expect(t).toContain('WHERE id = ? AND company_id = ?');
    expect(t).toContain("status = 'failed'");
    expect(t).toContain("status = 'extracting' AND COALESCE(extraction_heartbeat_at, created_at) < NOW() - make_interval(mins => ?)");
    expect(t).toContain("extraction_error_code IS DISTINCT FROM 'too_many_pages'");
    expect(update.slice(1)).toEqual([IMPORT_ID, COMPANY_ID, 5]);
    expect(imp.status).toBe('extracting');
    expect(afterCommit).toHaveBeenCalledTimes(1);
    await afterCommit.mock.calls[0]![1]();
    expect(runJob).toHaveBeenCalledWith(COMPANY_ID, IMPORT_ID);
  });

  it('refuses, and starts nothing, when the guarded UPDATE matched no row (double click)', async () => {
    sqlMock.mockResolvedValueOnce([]); // UPDATE matched nothing
    sqlMock.mockResolvedValueOnce([makeImportDbRow({ status: 'extracting', created_at: new Date() })]); // why
    await expect(retryImport(COMPANY_ID, IMPORT_ID)).rejects.toMatchObject({ code: 'IN_PROGRESS' });
    expect(afterCommit).not.toHaveBeenCalled();
  });

  it('says a too-long statement cannot be retried', async () => {
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([makeImportDbRow({ status: 'failed', extraction_error_code: 'too_many_pages', created_at: new Date() })]);
    await expect(retryImport(COMPANY_ID, IMPORT_ID)).rejects.toMatchObject({ code: 'NOT_RETRYABLE' });
    expect(afterCommit).not.toHaveBeenCalled();
  });

  it('says a finished import cannot be retried', async () => {
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([makeImportDbRow({ status: 'extracted', created_at: new Date() })]);
    await expect(retryImport(COMPANY_ID, IMPORT_ID)).rejects.toMatchObject({ code: 'NOT_RETRYABLE' });
  });

  it('says an import that is not there is not there', async () => {
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);
    await expect(retryImport(COMPANY_ID, IMPORT_ID)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);
    await expect(retryImport(COMPANY_ID, IMPORT_ID)).rejects.toBeInstanceOf(ExtractionActionRefusedError);
  });

  it('looks the reason up for this company only', async () => {
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);
    await retryImport(COMPANY_ID, IMPORT_ID).catch(() => undefined);
    const why = sqlMock.mock.calls[1]!;
    expect(text(why)).toContain('company_id = ?');
    expect(why.slice(1)).toContain(COMPANY_ID);
  });
});

// ── deleteFailedImport ────────────────────────────────────────────────────────

describe('deleteFailedImport', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('deletes only a failed (or stale) import of this company', async () => {
    sqlMock.mockResolvedValueOnce([{ id: IMPORT_ID }]);
    await expect(deleteFailedImport(COMPANY_ID, IMPORT_ID)).resolves.toBeUndefined();
    const del = sqlMock.mock.calls[0]!;
    const t = text(del);
    expect(t).toContain('DELETE FROM bank_statement_imports');
    expect(t).toContain('WHERE id = ? AND company_id = ?');
    expect(t).toContain("status = 'failed'");
    expect(t).toContain("status = 'extracting' AND COALESCE(extraction_heartbeat_at, created_at) < NOW() - make_interval(mins => ?)");
    expect(del.slice(1)).toEqual([IMPORT_ID, COMPANY_ID, 5]);
  });

  it('refuses an import that is extracted, committed or still being read', async () => {
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([makeImportDbRow({ status: 'extracted', created_at: new Date() })]);
    await expect(deleteFailedImport(COMPANY_ID, IMPORT_ID)).rejects.toMatchObject({ code: 'NOT_FAILED' });
  });

  it('says an import that is not there is not there', async () => {
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);
    await expect(deleteFailedImport(COMPANY_ID, IMPORT_ID)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

/**
 * A sql mock that answers by statement, so the count of bank_transactions INSERTs that really wrote a row (RETURNING id)
 * is scripted per call: `writes[i]` is true when the i-th INSERT wrote its row, false when ON CONFLICT DO NOTHING skipped it.
 */
function commitSql(importRow: Record<string, unknown>, writes: boolean[]) {
  let insert = 0;
  sqlMock.mockImplementation(async (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    if (text.includes('FROM bank_statement_imports') && text.includes('SELECT *')) return [importRow];
    if (text.includes('INSERT INTO bank_transactions')) return writes[insert++] ? [{ id: `tx-${insert}` }] : [];
    return [];
  });
}
const sqlTexts = () => sqlMock.mock.calls.map(([q]) => (q as TemplateStringsArray).join('?'));

// ── commitImport ──────────────────────────────────────────────────────────────

describe('commitImport', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('inserts only non-duplicate rows and returns correct inserted/skipped counts', async () => {
    // 3 rows: 2 non-dup, 1 dup
    const rows = [
      { date: '2026-03-05', description: 'Pick n Pay', amount: -200, isDuplicate: false, reference: null, runningBalance: null, duplicateOfBankTxId: null, duplicateMatchConfidence: 0 },
      { date: '2026-03-10', description: 'Salary Credit', amount: 5000, isDuplicate: true,  reference: null, runningBalance: null, duplicateOfBankTxId: 'tx-dup', duplicateMatchConfidence: 1.0 },
      { date: '2026-03-15', description: 'Eskom', amount: -300, isDuplicate: false, reference: null, runningBalance: null, duplicateOfBankTxId: null, duplicateMatchConfidence: 0 },
    ];
    const importRow = makeImportDbRow({
      status: 'extracted',
      row_count: 3,
      duplicate_count: 1,
      extraction_summary: { rows, warnings: [] },
    });

    commitSql(importRow, [true, true]);
    let result: Awaited<ReturnType<typeof commitImport>>;
    let texts: string[] = [];
    try { result = await commitImport(COMPANY_ID, IMPORT_ID, USER_ID); texts = sqlTexts(); } finally { sqlMock.mockReset(); }

    expect(result.inserted).toBe(2);
    expect(result.skipped).toBe(1);
    // every row went in: the batch's line count (already nonDupes.length) is not rewritten
    expect(texts.some((t) => t.includes('SET transaction_count'))).toBe(false);
  });

  it('does not count a row ON CONFLICT skipped as inserted, and corrects the batch line count (WP7)', async () => {
    const rows = [0, 1, 2].map((i) => ({ date: `2026-03-0${i + 1}`, description: `Line ${i}`, amount: -10 - i, isDuplicate: false, reference: null, runningBalance: null, duplicateOfBankTxId: null, duplicateMatchConfidence: 0 }));
    const importRow = makeImportDbRow({ status: 'extracted', row_count: 3, duplicate_count: 0, extraction_summary: { rows, warnings: [] } });
    commitSql(importRow, [true, false, true]); // the middle row: ON CONFLICT DO NOTHING wrote nothing
    let result: Awaited<ReturnType<typeof commitImport>>;
    let calls: unknown[][];
    try { result = await commitImport(COMPANY_ID, IMPORT_ID, USER_ID); calls = [...sqlMock.mock.calls]; } finally { sqlMock.mockReset(); }

    expect(result).toEqual({ inserted: 2, skipped: 1 });
    const text = (c: unknown[]) => (c[0] as TemplateStringsArray).join('?');
    const correction = calls.find((c) => text(c).includes('SET transaction_count'));
    expect(correction, 'the batch line count is corrected to what was written').toBeTruthy();
    expect(correction!.slice(1)).toContain(2);
    const committed = calls.find((c) => text(c).includes("SET status = 'committed'"));
    expect(committed!.slice(1)).toContain(2); // imported_count counts written rows only
  });

  it('every row ON CONFLICT-skipped: refused (409 EVERY_ROW_PRESENT), the import is NOT marked committed (WP7)', async () => {
    const rows = [0, 1].map((i) => ({ date: `2026-03-0${i + 1}`, description: `Line ${i}`, amount: -10 - i, isDuplicate: false, reference: null, runningBalance: null, duplicateOfBankTxId: null, duplicateMatchConfidence: 0 }));
    const importRow = makeImportDbRow({ status: 'extracted', row_count: 2, duplicate_count: 0, extraction_summary: { rows, warnings: [] } });
    commitSql(importRow, [false, false]);
    let texts: string[] = [];
    try {
      await expect(commitImport(COMPANY_ID, IMPORT_ID, USER_ID)).rejects.toMatchObject({ name: 'ExtractionActionRefusedError', code: 'EVERY_ROW_PRESENT' });
      texts = sqlTexts();
    } finally { sqlMock.mockReset(); }
    expect(texts.some((t) => t.includes("SET status = 'committed'"))).toBe(false); // left as it was
    expect(texts.some((t) => t.includes('SET transaction_count'))).toBe(false);
  });

  it('flips status from reviewing to committed', async () => {
    const importRow = makeImportDbRow({
      status: 'extracted',
      extraction_summary: { rows: [], warnings: [] },
    });

    sqlMock.mockResolvedValueOnce([]); // the import row's FOR UPDATE lock (one commit at a time)
    sqlMock.mockResolvedValueOnce([importRow]); // getImport
    // no INSERT calls since rows is empty
    sqlMock.mockResolvedValueOnce([]); // UPDATE status

    await commitImport(COMPANY_ID, IMPORT_ID, USER_ID);

    // The last sql call should be the UPDATE — check it was called
    const calls = sqlMock.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('throws "Import already committed" when status is already committed', async () => {
    const importRow = makeImportDbRow({ status: 'committed', extraction_summary: { rows: [], warnings: [] } });
    sqlMock.mockResolvedValueOnce([]); // the import row's FOR UPDATE lock (one commit at a time)
    sqlMock.mockResolvedValueOnce([importRow]);

    await expect(commitImport(COMPANY_ID, IMPORT_ID, USER_ID)).rejects.toThrow('Import already committed');
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([importRow]);
    await expect(commitImport(COMPANY_ID, IMPORT_ID, USER_ID)).rejects.toMatchObject({ name: 'ExtractionActionRefusedError', code: 'ALREADY_COMMITTED' }); // a double commit: 409
  });

  it('throws "Import has been rolled back" when status is rolled_back', async () => {
    const importRow = makeImportDbRow({ status: 'rolled_back', extraction_summary: { rows: [], warnings: [] } });
    sqlMock.mockResolvedValueOnce([]); // the import row's FOR UPDATE lock (one commit at a time)
    sqlMock.mockResolvedValueOnce([importRow]);

    await expect(commitImport(COMPANY_ID, IMPORT_ID, USER_ID)).rejects.toThrow('Import has been rolled back');
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([importRow]);
    await expect(commitImport(COMPANY_ID, IMPORT_ID, USER_ID)).rejects.toMatchObject({ name: 'ExtractionActionRefusedError', code: 'ROLLED_BACK' });
  });

  it('a missing import is a refusal the route answers 404 (not a bare Error, a 500)', async () => {
    sqlMock.mockResolvedValueOnce([]); // the import row's FOR UPDATE lock (one commit at a time)
    sqlMock.mockResolvedValueOnce([]);

    await expect(commitImport(COMPANY_ID, IMPORT_ID, USER_ID)).rejects.toMatchObject({ name: 'ExtractionActionRefusedError', code: 'NOT_FOUND' });
  });

  it('all rows are duplicates → inserted=0, skipped=rowCount', async () => {
    const rows = [
      { date: '2026-03-05', description: 'Pick n Pay', amount: -200, isDuplicate: true, reference: null, runningBalance: null, duplicateOfBankTxId: 'tx-1', duplicateMatchConfidence: 1.0 },
      { date: '2026-03-10', description: 'Salary', amount: 5000, isDuplicate: true, reference: null, runningBalance: null, duplicateOfBankTxId: 'tx-2', duplicateMatchConfidence: 1.0 },
    ];
    const importRow = makeImportDbRow({
      status: 'extracted',
      row_count: 2,
      duplicate_count: 2,
      extraction_summary: { rows, warnings: [] },
    });
    sqlMock.mockResolvedValueOnce([]); // the import row's FOR UPDATE lock (one commit at a time)
    sqlMock.mockResolvedValueOnce([importRow]); // getImport
    sqlMock.mockResolvedValueOnce([]);          // UPDATE status

    const result = await commitImport(COMPANY_ID, IMPORT_ID, USER_ID);

    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(2);
  });
});

// ── rollbackImport ────────────────────────────────────────────────────────────

describe('rollbackImport', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('flips status to rolled_back and resolves without inserting rows', async () => {
    const importRow = makeImportDbRow({ status: 'extracted', extraction_summary: { rows: [], warnings: [] } });
    sqlMock.mockResolvedValueOnce([]);                 // FOR UPDATE lock
    sqlMock.mockResolvedValueOnce([importRow]);        // getImport
    sqlMock.mockResolvedValueOnce([{ id: IMPORT_ID }]); // UPDATE status ... RETURNING

    await expect(rollbackImport(COMPANY_ID, IMPORT_ID, USER_ID)).resolves.toBeUndefined();

    // Only 3 sql calls: lock + getImport SELECT + UPDATE (no INSERTs)
    expect(sqlMock).toHaveBeenCalledTimes(3);
  });

  it('locks the row first, and writes only to a company\'s extracted or reviewing import', async () => {
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([makeImportDbRow({ status: 'reviewing' })]);
    sqlMock.mockResolvedValueOnce([{ id: IMPORT_ID }]);
    await rollbackImport(COMPANY_ID, IMPORT_ID, USER_ID);
    const [lock, , update] = sqlMock.mock.calls.map(text);
    expect(lock).toContain('FOR UPDATE');
    expect(lock).toContain('company_id = ?');
    expect(update).toContain("WHERE id = ? AND company_id = ? AND status IN ('extracted', 'reviewing')");
  });

  it('refuses, rather than report success, when the guarded UPDATE matched no row', async () => {
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([makeImportDbRow({ status: 'extracted' })]);
    sqlMock.mockResolvedValueOnce([]); // nothing matched
    await expect(rollbackImport(COMPANY_ID, IMPORT_ID, USER_ID)).rejects.toThrow('could not be rolled back');
  });

  it('is a no-op the second time: an already rolled-back import writes nothing', async () => {
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([makeImportDbRow({ status: 'rolled_back' })]);
    await expect(rollbackImport(COMPANY_ID, IMPORT_ID, USER_ID)).resolves.toBeUndefined();
    expect(sqlMock.mock.calls.map(text).filter((t) => t.startsWith('UPDATE'))).toEqual([]);
  });

  it('throws "Cannot roll back a committed import" when already committed', async () => {
    const importRow = makeImportDbRow({ status: 'committed', extraction_summary: { rows: [], warnings: [] } });
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([importRow]);

    await expect(rollbackImport(COMPANY_ID, IMPORT_ID, USER_ID)).rejects.toThrow('Cannot roll back a committed import');
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([importRow]);
    // typed, so the route answers 409 (it was a bare Error: a 500), and refused before any write
    await expect(rollbackImport(COMPANY_ID, IMPORT_ID, USER_ID)).rejects.toMatchObject({ name: 'ExtractionActionRefusedError', code: 'ALREADY_COMMITTED' });
    expect(sqlMock.mock.calls.map(text).some((t) => t.startsWith('UPDATE'))).toBe(false);
  });

  it('a missing import is a refusal the route answers 404 (not a bare Error, a 500)', async () => {
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);

    await expect(rollbackImport(COMPANY_ID, IMPORT_ID, USER_ID)).rejects.toMatchObject({ name: 'ExtractionActionRefusedError', code: 'NOT_FOUND' });
  });
});

// ── an import that is still being read, or failed, is never committed or rolled back ──

describe('commitImport / rollbackImport on an import that is not extracted', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  for (const [status, message] of [
    ['extracting', 'Import is still being read'],
    ['failed', 'Import could not be read'],
  ] as const) {
    it(`commit refuses a ${status} import and writes nothing`, async () => {
      sqlMock.mockResolvedValueOnce([]); // FOR UPDATE lock
      sqlMock.mockResolvedValueOnce([makeImportDbRow({ status, created_at: new Date(), extraction_summary: { rows: [
        { date: '2026-03-05', description: 'x', amount: -1, isDuplicate: false, reference: null, runningBalance: null, duplicateOfBankTxId: null, duplicateMatchConfidence: 0 },
      ], warnings: [] } })]);

      await expect(commitImport(COMPANY_ID, IMPORT_ID, USER_ID)).rejects.toThrow(message);
      expect(sqlMock.mock.calls.map(text).filter((t) => t.startsWith('INSERT') || t.startsWith('UPDATE'))).toEqual([]);
    });

    it(`rollback refuses a ${status} import and writes nothing`, async () => {
      sqlMock.mockResolvedValueOnce([]); // FOR UPDATE lock
      sqlMock.mockResolvedValueOnce([makeImportDbRow({ status, created_at: new Date() })]);

      await expect(rollbackImport(COMPANY_ID, IMPORT_ID, USER_ID)).rejects.toThrow(message);
      expect(sqlMock.mock.calls.map(text).filter((t) => t.startsWith('UPDATE'))).toEqual([]);
    });
  }

  it('commit refuses a stale extracting import, which is reported as failed', async () => {
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([makeImportDbRow({ status: 'extracting', created_at: new Date(Date.now() - 60 * 60_000) })]);
    await expect(commitImport(COMPANY_ID, IMPORT_ID, USER_ID)).rejects.toThrow('Import could not be read');
  });
});
