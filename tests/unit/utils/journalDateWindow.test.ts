/**
 * The ledger-date window's pure half (utils/journalDateWindow): the check on the text of a `::date` (the day Postgres
 * stores — DB-backed paths read it with gl/journalDateGuard, see numrace-date-parse.int.test.ts), and the statement
 * parsers' own YYYY-MM-DD output.
 */
import { describe, expect, it } from 'vitest';
import { journalDayWindowError, parsedDayWindowError } from '@/modules/accounting/utils/journalDateWindow';
import { parseStatement } from '@/modules/accounting/services/bank/bankStatementParseService';

describe('journalDayWindowError: the text of a ::date', () => {
  it('accepts a day from 1900-01-01 to 2199-12-31', () => {
    for (const d of ['1900-01-01', '2026-02-28', '2024-02-29', '2199-12-31']) expect(journalDayWindowError(d)).toBeNull();
  });

  it("refuses what ::date returns outside it: a 5+ digit year, ' BC', infinity, the edges", () => {
    for (const d of ['100000-01-01', '10000-01-01', '0044-03-15 BC', '2025-03-31 BC', 'infinity', '-infinity',
      '0001-06-01', '1899-12-31', '2200-01-01']) {
      expect(journalDayWindowError(d), d).toMatch(/outside 1900-01-01 to 2199-12-31/);
    }
  });
});

describe('parsedDayWindowError: a statement parser output', () => {
  it('checks a canonical YYYY-MM-DD; leaves any other shape to the import step, where Postgres reads it', () => {
    expect(parsedDayWindowError('2026-01-05')).toBeNull();
    expect(parsedDayWindowError('0001-06-01')).toMatch(/outside/);
    for (const d of ['0001-06-01T00:00:00', '10000-01-01', '05/01/2026', '']) expect(parsedDayWindowError(d), d).toBeNull();
  });
});

describe('parseStatement keeps only ledger dates', () => {
  it('a QIF line dated 0001-06-01 is a row error; the 2026 line imports', async () => {
    const qif = '!Type:Bank\nD01/06/0001\nT-10.00\nPancient\n^\nD05/01/2026\nT-11.00\nPmodern\n^\n';
    const out = await parseStatement({ fileType: 'qif', csvContent: qif } as never);
    expect(out.transactions.map((t) => t.transactionDate)).toEqual(['2026-01-05']);
    expect(out.errors.map((e) => e.error).join(' ')).toMatch(/0001-06-01 is outside 1900-01-01 to 2199-12-31/);
  });
});
