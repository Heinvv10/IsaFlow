/**
 * A GL import refusal names the row the PREVIEW shows. The page sends only the rows that validated, so a row's
 * position in the sent array is not its place in the file: every row after a dropped one would be off. Each row
 * carries its own `sheetRow` (set where the file is read); a caller without one (API, MCP) gets its array position + 2.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn(), unsafe: vi.fn((s: string) => s) });
  return { sql: sqlMock, withTransaction: vi.fn(), withSavepoint: vi.fn((_n: string, fn: () => unknown) => fn()), fmtDate: (d: unknown) => String(d) };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: vi.fn(async () => ({ id: 'je' })), postJournalEntry: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { importJournalEntries, ImportValidationError } from '@/modules/accounting/services/gl/glImportExecuteService';
import type { ImportRow } from '@/modules/accounting/services/gl/glImportService';
import { buildImportRows } from '@/components/accounting/gl-import/buildImportRows';

const sqlMock = sql as unknown as ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockImplementation(((strings: TemplateStringsArray) => {
    const text = Array.isArray(strings) ? strings.join('') : String(strings);
    return Promise.resolve(text.includes('FROM gl_accounts') ? [{ account_code: '4000', id: 'a-4000' }] : []);
  }) as never);
});

const MAPPING: Record<number, string> = { 0: 'date', 1: 'accountCode', 2: 'description', 3: 'debit', 4: 'credit', 5: 'reference' };
// sheet rows 2..7; row 3 is the one the preview rejected, row 6 names an account that does not exist
const RAW = [
  ['2026-08-13', '4000', 'a', '10', '', 'R1'],
  ['2026-08-13', '4000', 'rejected by the preview', '', '', 'R1'],
  ['2026-08-13', '4000', 'c', '', '10', 'R1'],
  ['2026-08-13', '4000', 'd', '5', '', 'R1'],
  ['2026-08-13', '9999', 'Cash to J SMITH 0123456789', '', '5', 'R1'],
  ['2026-08-13', '4000', 'f', '1', '', 'R1'],
];
const refusal = (rows: ImportRow[]) => importJournalEntries('co', rows, 'u', false).then(() => null, (e: unknown) => e as Error);

describe('buildImportRows', () => {
  it('stamps each row with its row in the preview (header = row 1)', () => {
    expect(buildImportRows(RAW, MAPPING).map((r) => r.sheetRow)).toEqual([2, 3, 4, 5, 6, 7]);
  });
});

describe('importJournalEntries: the row a refusal names', () => {
  it('after the page drops an invalid row, the refusal still says the preview\'s row 6', async () => {
    const sent = buildImportRows(RAW, MAPPING).filter((_, i) => i !== 1); // what handleValidate keeps
    const err = await refusal(sent);
    expect(err).toBeInstanceOf(ImportValidationError);
    expect(err!.message).toBe('Import row 6 (2026-08-13) references account code 9999, which does not exist or is inactive for this company');
    expect(err!.message).not.toMatch(/SMITH|0123456789/);
  });

  it('a caller that sends no sheetRow gets its array position + 2', async () => {
    const sent = buildImportRows(RAW, MAPPING).map(({ sheetRow: _s, ...r }) => r).filter((_, i) => i !== 1);
    expect((await refusal(sent))!.message).toMatch(/^Import row 5 \(/);
  });

  it.each([[0], [-3], [2.5], ['6'], [null], [Number.MAX_SAFE_INTEGER + 2]])('an unusable sheetRow %j falls back to the array position + 2', async (bad) => {
    const sent = buildImportRows(RAW, MAPPING).map((r) => ({ ...r, sheetRow: bad as never }));
    expect((await refusal(sent))!.message).toMatch(/^Import row 6 \(/);
  });
});
