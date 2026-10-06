/**
 * NUMRACE round 3 (sec-numrace S2): the ledger-date window, and the statement import dropping a line outside it.
 */
import { describe, expect, it } from 'vitest';
import { journalDateWindowError } from '@/modules/accounting/utils/journalDateWindow';
import { parseStatement } from '@/modules/accounting/services/bank/bankStatementParseService';

describe('journalDateWindowError', () => {
  it('accepts an ISO day from 1900-01-01 to 2199-12-31', () => {
    for (const d of ['1900-01-01', '2026-02-28', '2024-02-29', '2199-12-31']) expect(journalDateWindowError(d)).toBeNull();
  });

  it('refuses 5-digit and BC years, other shapes, impossible days and the window edges', () => {
    for (const d of ['100000-01-01', '0044-03-15 BC', '0001-06-01', '1899-12-31', '2200-01-01', '2026-02-30',
      '2026/01/05', '']) {
      expect(journalDateWindowError(d), d).not.toBeNull();
    }
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
