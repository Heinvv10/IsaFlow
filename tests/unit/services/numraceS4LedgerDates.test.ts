/**
 * NUMRACE round 3 (sec-numrace S4): the ledger-date window (utils/journalDateWindow) on the paths that do not reach
 * createJournalEntry's own guard —
 *   - the OCR statement import: an extracted line dated outside 1900..2199 keeps no date (commit skips it) and is
 *     reported among the warnings, as the CSV import's row error; commit skips a stored row dated outside it;
 *   - the depreciation run's period_date (it INSERTs its journal itself): refused as invalid before the run writes;
 *   - the year-end closing journal (INSERTs itself, dated a tenant-created fiscal year's end): refused before its
 *     transaction opens.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtractedBankStatement } from '@/modules/accounting/types/documentCapture.types';

const { sqlMock, withTransactionMock } = vi.hoisted(() => ({
  sqlMock: Object.assign(vi.fn(), { unsafe: vi.fn().mockReturnValue('') }),
  withTransactionMock: vi.fn(),
}));
vi.mock('@/lib/neon', () => ({
  sql: sqlMock, withTransaction: withTransactionMock, withSavepoint: (_n: string, fn: () => unknown) => fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/documentStorage', () => ({
  fetchRawBytes: vi.fn(async () => ({ buffer: Buffer.from('%PDF-1.4'), hash: 'x', size: 8, fileType: 'pdf' })),
}));
vi.mock('@/modules/accounting/services/bank/vlmBankService', () => ({ extractBankStatementWithVlm: vi.fn() }));

import { commitImport, createImportFromDocument } from '@/modules/accounting/services/bank/bankStatementOcrService';
import { extractBankStatementWithVlm } from '@/modules/accounting/services/bank/vlmBankService';
import { invalidPeriodDate } from '@/modules/accounting/services/items/depreciationRunPlan';
import { postClosingJournal } from '@/modules/accounting/services/gl/yearEndJournalPoster';
import { isJournalDateRefused } from '@/modules/accounting/utils/journalDateWindow';

const CO = 'aaaaaaaa-0000-0000-0000-000000000001';
const BANK = 'bbbbbbbb-0000-0000-0000-000000000002';
const DOC = 'cccccccc-0000-0000-0000-000000000003';
const USER = 'dddddddd-0000-0000-0000-000000000004';
const IMPORT = 'eeeeeeee-0000-0000-0000-000000000005';

const row = (date: string, description: string) => ({
  date, description, amount: -10, isDuplicate: false, reference: null, runningBalance: null,
  duplicateOfBankTxId: null, duplicateMatchConfidence: 0,
});
const importRow = (rows: unknown[]) => ({
  id: IMPORT, company_id: CO, bank_account_id: BANK, source_document_id: DOC, period_start: null, period_end: null,
  opening_balance: null, closing_balance: null, row_count: rows.length, imported_count: 0, duplicate_count: 0,
  status: 'extracted', extraction_summary: { rows, warnings: [] }, created_by: USER,
  created_at: '2026-04-01T10:00:00.000Z', committed_at: null,
});

beforeEach(() => { vi.resetAllMocks(); });

describe('OCR statement import', () => {
  it('an extracted line dated 0001-06-01 keeps no date and is a warning; the 2026 line is kept', async () => {
    const extraction: ExtractedBankStatement = {
      bankName: 'FNB', accountNumber: '1', statementPeriod: null, openingBalance: null, closingBalance: null,
      confidence: 0.9, warnings: [],
      transactions: [
        { date: '0001-06-01', description: 'ancient', amount: -10, balance: null, reference: null, transactionType: null },
        { date: '2026-03-05', description: 'modern', amount: -11, balance: null, reference: null, transactionType: null },
      ],
    };
    vi.mocked(extractBankStatementWithVlm).mockResolvedValueOnce(extraction);
    sqlMock.mockResolvedValueOnce([]); // dedup: existing lines
    sqlMock.mockResolvedValueOnce([importRow([])]); // INSERT bank_statement_imports
    await createImportFromDocument(CO, BANK, DOC, USER);
    const insert = sqlMock.mock.calls.find((c) => String((c[0] as string[]).join('')).includes('INSERT INTO bank_statement_imports'));
    const json = insert!.slice(1).find((v) => typeof v === 'string' && v.startsWith('{"rows"')) as string;
    const stored = JSON.parse(json) as { rows: { date: string }[]; warnings: string[] };
    expect(stored.rows.map((r) => r.date)).toEqual(['', '2026-03-05']);
    expect(stored.warnings.join(' ')).toMatch(/0001-06-01 is outside 1900-01-01 to 2199-12-31 \(ancient\)/);
  });

  it('commit skips a stored row dated outside the window', async () => {
    sqlMock.mockResolvedValueOnce([importRow([row('0001-06-01', 'ancient'), row('2026-03-05', 'modern')])]);
    sqlMock.mockResolvedValue([]);
    const out = await commitImport(CO, IMPORT, USER);
    const inserts = sqlMock.mock.calls.filter((c) => String((c[0] as string[]).join('')).includes('INSERT INTO bank_transactions'));
    expect(out).toEqual({ inserted: 1, skipped: 1 });
    expect(inserts.map((c) => c.find((v) => v === '0001-06-01' || v === '2026-03-05'))).toEqual(['2026-03-05']);
  });
});

describe('depreciation period_date', () => {
  it('a real day outside 1900..2199 is invalid_period_date; one inside is not', () => {
    expect(invalidPeriodDate('0001-06-30')).toMatchObject({ reason: 'invalid_period_date', detail: expect.stringMatching(/outside 1900-01-01/) });
    expect(invalidPeriodDate('2200-01-31')).toMatchObject({ reason: 'invalid_period_date' });
    expect(invalidPeriodDate('2026-06-30')).toBeNull();
  });
});

describe('year-end closing journal', () => {
  it('dated 2200-12-31: refused before its transaction opens', async () => {
    sqlMock.mockResolvedValueOnce([{ d: '2200-12-31' }]); // Postgres's ::date of the entry date
    const preview = {
      entryDate: '2200-12-31', entryNumber: 'YE-2200', description: 'Year-End Closing: 2200',
      lines: [
        { accountId: '00000000-0000-0000-0000-000000000001', accountCode: '4000', accountName: 'Sales', debit: 100, credit: 0 },
        { accountId: '00000000-0000-0000-0000-000000000002', accountCode: '3200', accountName: 'RE', debit: 0, credit: 100 },
      ],
      totalDebit: 100, totalCredit: 100,
    };
    let err: unknown = null;
    try { await postClosingJournal(CO, USER, '2200', preview, null); } catch (e) { err = e; }
    expect(isJournalDateRefused(err), String(err)).toBe(true);
    expect(withTransactionMock).not.toHaveBeenCalled();
  });
});
