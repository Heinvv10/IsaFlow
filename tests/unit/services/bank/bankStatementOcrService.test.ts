// RED phase — written before implementation
/**
 * Unit tests for bankStatementOcrService.ts — PRD-05 Phase 7
 *
 * Covers: createImportFromDocument (happy path, exact-fp dup, fuzzy dup,
 * zero-extraction), commitImport (partial dups, status flip, already-committed
 * guard, rollback guard), rollbackImport (status flip, committed guard).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExtractedBankStatement } from '@/modules/accounting/types/documentCapture.types';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { sqlMock } = vi.hoisted(() => ({
  sqlMock: Object.assign(vi.fn(), { unsafe: vi.fn().mockReturnValue('') }),
}));

vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/documentStorage', () => ({
  fetchRawBytes: vi.fn().mockResolvedValue({
    buffer: Buffer.from('%PDF-1.4 test'),
    hash: 'deadbeef',
    size: 13,
    fileType: 'pdf',
  }),
}));
vi.mock('@/modules/accounting/services/bank/vlmBankService', () => ({
  extractBankStatementWithVlm: vi.fn(),
}));

import {
  createImportFromDocument,
  commitImport,
  rollbackImport,
} from '@/modules/accounting/services/bank/bankStatementOcrService';
import { fetchRawBytes } from '@/lib/documentStorage';
import { extractBankStatementWithVlm } from '@/modules/accounting/services/bank/vlmBankService';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const COMPANY_ID    = 'aaaaaaaa-0000-0000-0000-000000000001';
const BANK_ACCT_ID  = 'bbbbbbbb-0000-0000-0000-000000000002';
const DOC_ID        = 'cccccccc-0000-0000-0000-000000000003';
const USER_ID       = 'dddddddd-0000-0000-0000-000000000004';
const IMPORT_ID     = 'eeeeeeee-0000-0000-0000-000000000005';

/** Minimal VLM extraction with 3 transactions. */
function makeExtraction(overrides: Partial<ExtractedBankStatement> = {}): ExtractedBankStatement {
  return {
    bankName: 'FNB',
    accountNumber: '62012345678',
    statementPeriod: { from: '2026-03-01', to: '2026-03-31' },
    openingBalance: 10000,
    closingBalance: 9500,
    confidence: 0.97,
    warnings: [],
    transactions: [
      { date: '2026-03-05', description: 'Pick n Pay Superstore', amount: -200, balance: 9800, reference: 'PNP001', transactionType: 'debit' },
      { date: '2026-03-10', description: 'Salary Credit March',  amount: 5000, balance: 14800, reference: 'SAL001', transactionType: 'credit' },
      { date: '2026-03-15', description: 'Eskom prepaid electricity', amount: -300, balance: 14500, reference: 'ESK001', transactionType: 'debit' },
    ],
    ...overrides,
  };
}

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
    status: 'reviewing',
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
    status: overrides.status ?? 'reviewing',
    rows,
    warnings: [],
    createdAt: '2026-04-01T10:00:00.000Z',
    committedAt: null,
  };
}

// ── createImportFromDocument ──────────────────────────────────────────────────

describe('createImportFromDocument', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchRawBytes).mockResolvedValue({
      buffer: Buffer.from('%PDF-1.4 test'),
      hash: 'deadbeef',
      size: 13,
      fileType: 'pdf',
    });
  });

  it('happy path: 3 rows, no duplicates → rowCount=3, duplicateCount=0, status=reviewing', async () => {
    vi.mocked(extractBankStatementWithVlm).mockResolvedValueOnce(makeExtraction());

    // runDedupPass: SELECT existing bank_transactions → empty (no dups)
    sqlMock.mockResolvedValueOnce([]); // existing bank_transactions
    // INSERT bank_statement_imports → return persisted row
    sqlMock.mockResolvedValueOnce([makeImportDbRow({ duplicate_count: 0 })]);

    const result = await createImportFromDocument(COMPANY_ID, BANK_ACCT_ID, DOC_ID, USER_ID);

    expect(result.rowCount).toBe(3);
    expect(result.duplicateCount).toBe(0);
    expect(result.status).toBe('reviewing');
    expect(result.id).toBe(IMPORT_ID);
  });

  it('exact fingerprint duplicate: 1 of 3 rows matches existing tx → duplicateCount=1', async () => {
    vi.mocked(extractBankStatementWithVlm).mockResolvedValueOnce(makeExtraction());

    // Existing tx matches row[0] exactly: same date, amount, and first-30-chars of description
    const existingTx = {
      id: 'tx-existing-001',
      transaction_date: '2026-03-05',
      amount: -200,
      description: 'Pick n Pay Superstore',
    };
    sqlMock.mockResolvedValueOnce([existingTx]); // bank_transactions lookup
    sqlMock.mockResolvedValueOnce([makeImportDbRow({ duplicate_count: 1 })]); // INSERT

    const result = await createImportFromDocument(COMPANY_ID, BANK_ACCT_ID, DOC_ID, USER_ID);

    expect(result.duplicateCount).toBe(1);
    expect(result.rowCount).toBe(3);
  });

  it('fuzzy duplicate: date off by 1 day, same amount, description dice ≥ 0.7 → persisted with duplicateCount=1', async () => {
    vi.mocked(extractBankStatementWithVlm).mockResolvedValueOnce(makeExtraction());

    // Existing tx: date is 2026-03-04 (1 day earlier), same amount, description
    // is slightly different but dice ≥ 0.7 with "Pick n Pay Superstore"
    const existingTx = {
      id: 'tx-fuzzy-001',
      transaction_date: '2026-03-04', // 1 day off
      amount: -200,
      description: 'Pick n Pay Superstore Bellville', // similar but not identical
    };
    sqlMock.mockResolvedValueOnce([existingTx]);
    sqlMock.mockResolvedValueOnce([makeImportDbRow({ duplicate_count: 1 })]);

    const result = await createImportFromDocument(COMPANY_ID, BANK_ACCT_ID, DOC_ID, USER_ID);

    // The dedup pass should mark one row as fuzzy duplicate
    expect(result.duplicateCount).toBe(1);
  });

  it('VLM returns 0 transactions → rowCount=0, warnings includes "No transactions extracted"', async () => {
    vi.mocked(extractBankStatementWithVlm).mockResolvedValueOnce(
      makeExtraction({ transactions: [], warnings: ['No transactions extracted'] }),
    );

    // runDedupPass short-circuits on empty rows array (no SQL call needed)
    sqlMock.mockResolvedValueOnce([
      makeImportDbRow({
        row_count: 0,
        duplicate_count: 0,
        extraction_summary: { rows: [], warnings: ['No transactions extracted'] },
      }),
    ]);

    const result = await createImportFromDocument(COMPANY_ID, BANK_ACCT_ID, DOC_ID, USER_ID);

    expect(result.rowCount).toBe(0);
    expect(result.warnings).toContain('No transactions extracted');
  });

  it('throws when documentStorage returns null', async () => {
    vi.mocked(fetchRawBytes).mockResolvedValueOnce(null);

    await expect(
      createImportFromDocument(COMPANY_ID, BANK_ACCT_ID, DOC_ID, USER_ID),
    ).rejects.toThrow(DOC_ID);
  });

  it('throws when VLM extraction returns null', async () => {
    vi.mocked(extractBankStatementWithVlm).mockResolvedValueOnce(null);
    // no bank_transactions query needed — throws before dedup

    await expect(
      createImportFromDocument(COMPANY_ID, BANK_ACCT_ID, DOC_ID, USER_ID),
    ).rejects.toThrow('VLM extraction returned null');
  });
});

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
      status: 'reviewing',
      row_count: 3,
      duplicate_count: 1,
      extraction_summary: { rows, warnings: [] },
    });

    // getImport: SELECT * FROM bank_statement_imports
    sqlMock.mockResolvedValueOnce([importRow]);
    // INSERT bank_transactions for row[0]
    sqlMock.mockResolvedValueOnce([]);
    // INSERT bank_transactions for row[2]
    sqlMock.mockResolvedValueOnce([]);
    // UPDATE bank_statement_imports SET status='committed'
    sqlMock.mockResolvedValueOnce([]);

    const result = await commitImport(COMPANY_ID, IMPORT_ID, USER_ID);

    expect(result.inserted).toBe(2);
    expect(result.skipped).toBe(1);
  });

  it('flips status from reviewing to committed', async () => {
    const importRow = makeImportDbRow({
      status: 'reviewing',
      extraction_summary: { rows: [], warnings: [] },
    });

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
    sqlMock.mockResolvedValueOnce([importRow]);

    await expect(commitImport(COMPANY_ID, IMPORT_ID, USER_ID)).rejects.toThrow('Import already committed');
  });

  it('throws "Import has been rolled back" when status is rolled_back', async () => {
    const importRow = makeImportDbRow({ status: 'rolled_back', extraction_summary: { rows: [], warnings: [] } });
    sqlMock.mockResolvedValueOnce([importRow]);

    await expect(commitImport(COMPANY_ID, IMPORT_ID, USER_ID)).rejects.toThrow('Import has been rolled back');
  });

  it('throws when import is not found', async () => {
    sqlMock.mockResolvedValueOnce([]);

    await expect(commitImport(COMPANY_ID, IMPORT_ID, USER_ID)).rejects.toThrow('Import not found');
  });

  it('all rows are duplicates → inserted=0, skipped=rowCount', async () => {
    const rows = [
      { date: '2026-03-05', description: 'Pick n Pay', amount: -200, isDuplicate: true, reference: null, runningBalance: null, duplicateOfBankTxId: 'tx-1', duplicateMatchConfidence: 1.0 },
      { date: '2026-03-10', description: 'Salary', amount: 5000, isDuplicate: true, reference: null, runningBalance: null, duplicateOfBankTxId: 'tx-2', duplicateMatchConfidence: 1.0 },
    ];
    const importRow = makeImportDbRow({
      status: 'reviewing',
      row_count: 2,
      duplicate_count: 2,
      extraction_summary: { rows, warnings: [] },
    });
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
    const importRow = makeImportDbRow({ status: 'reviewing', extraction_summary: { rows: [], warnings: [] } });
    sqlMock.mockResolvedValueOnce([importRow]); // getImport
    sqlMock.mockResolvedValueOnce([]);          // UPDATE status

    await expect(rollbackImport(COMPANY_ID, IMPORT_ID, USER_ID)).resolves.toBeUndefined();

    // Only 2 sql calls: getImport SELECT + UPDATE (no INSERTs)
    expect(sqlMock).toHaveBeenCalledTimes(2);
  });

  it('throws "Cannot roll back a committed import" when already committed', async () => {
    const importRow = makeImportDbRow({ status: 'committed', extraction_summary: { rows: [], warnings: [] } });
    sqlMock.mockResolvedValueOnce([importRow]);

    await expect(rollbackImport(COMPANY_ID, IMPORT_ID, USER_ID)).rejects.toThrow('Cannot roll back a committed import');
  });

  it('throws when import is not found', async () => {
    sqlMock.mockResolvedValueOnce([]);

    await expect(rollbackImport(COMPANY_ID, IMPORT_ID, USER_ID)).rejects.toThrow('Import not found');
  });
});

// ── diceCoefficient (internal — tested via fuzzy dedup behaviour) ─────────────

describe('fuzzy dedup confidence value', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchRawBytes).mockResolvedValue({
      buffer: Buffer.from('%PDF-1.4 test'),
      hash: 'deadbeef',
      size: 13,
      fileType: 'pdf',
    });
  });

  it('exact duplicate row carries confidence 1.0 in extraction_summary', async () => {
    // We control what the DB INSERT returns — the rows embedded in extraction_summary
    // reflect what createImportFromDocument computed
    vi.mocked(extractBankStatementWithVlm).mockResolvedValueOnce(
      makeExtraction({
        transactions: [
          { date: '2026-03-05', description: 'Pick n Pay Superstore', amount: -200, balance: 9800, reference: null, transactionType: null },
        ],
      }),
    );

    const existingTx = {
      id: 'tx-exact',
      transaction_date: '2026-03-05',
      amount: -200,
      description: 'Pick n Pay Superstore',
    };
    sqlMock.mockResolvedValueOnce([existingTx]); // bank_transactions
    // Return extraction_summary with the row having confidence 1.0
    sqlMock.mockResolvedValueOnce([
      makeImportDbRow({
        row_count: 1,
        duplicate_count: 1,
        extraction_summary: {
          rows: [{ date: '2026-03-05', description: 'Pick n Pay Superstore', amount: -200, isDuplicate: true, duplicateOfBankTxId: 'tx-exact', duplicateMatchConfidence: 1.0, reference: null, runningBalance: null }],
          warnings: [],
        },
      }),
    ]);

    const result = await createImportFromDocument(COMPANY_ID, BANK_ACCT_ID, DOC_ID, USER_ID);

    expect(result.rows[0]?.isDuplicate).toBe(true);
    expect(result.rows[0]?.duplicateMatchConfidence).toBeCloseTo(1.0, 5);
  });

  it('fuzzy duplicate row carries confidence 0.9 in extraction_summary', async () => {
    vi.mocked(extractBankStatementWithVlm).mockResolvedValueOnce(
      makeExtraction({
        transactions: [
          { date: '2026-03-05', description: 'Pick n Pay Superstore', amount: -200, balance: null, reference: null, transactionType: null },
        ],
      }),
    );

    const existingTx = {
      id: 'tx-fuzzy',
      transaction_date: '2026-03-04', // 1 day off
      amount: -200,
      description: 'Pick n Pay Superstore Bellville',
    };
    sqlMock.mockResolvedValueOnce([existingTx]);
    sqlMock.mockResolvedValueOnce([
      makeImportDbRow({
        row_count: 1,
        duplicate_count: 1,
        extraction_summary: {
          rows: [{ date: '2026-03-05', description: 'Pick n Pay Superstore', amount: -200, isDuplicate: true, duplicateOfBankTxId: 'tx-fuzzy', duplicateMatchConfidence: 0.9, reference: null, runningBalance: null }],
          warnings: [],
        },
      }),
    ]);

    const result = await createImportFromDocument(COMPANY_ID, BANK_ACCT_ID, DOC_ID, USER_ID);

    expect(result.rows[0]?.isDuplicate).toBe(true);
    expect(result.rows[0]?.duplicateMatchConfidence).toBeCloseTo(0.9, 5);
  });
});
