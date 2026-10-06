/**
 * NUMRACE round 3 (sec-numrace S2): the ledger-date window, and the statement import dropping a line outside it.
 */
import { describe, expect, it } from 'vitest';
import { journalDateWindowError, ledgerDay } from '@/modules/accounting/utils/journalDateWindow';
import { parseStatement } from '@/modules/accounting/services/bank/bankStatementParseService';

describe('journalDateWindowError', () => {
  it('accepts an ISO day from 1900-01-01 to 2199-12-31', () => {
    for (const d of ['1900-01-01', '2026-02-28', '2024-02-29', '2199-12-31']) expect(journalDateWindowError(d)).toBeNull();
  });

  it('refuses 5-digit and BC years, other shapes, impossible days and the window edges', () => {
    for (const d of ['100000-01-01', '0044-03-15 BC', '2025-03-31 BC', '0001-06-01', '1899-12-31', '2200-01-01',
      '2026-02-30', '2025-03-31Tjunk', '31/03/2025', 'Foo 31, 2025', '2025', '1', '']) {
      expect(journalDateWindowError(d), d).not.toBeNull();
    }
  });
});

describe('ledgerDay: the forms the GL import and bank routes took before the window (blind review LOW 3)', () => {
  it('an ISO day with a time is its date part, as a ::DATE cast reads it', () => {
    for (const d of ['2025-03-31T00:00:00', '2025-03-31T23:59:59.123Z', '2025-03-31 10:15', '2025-03-31T10:15:00+02:00']) {
      expect(ledgerDay(d), d).toBe('2025-03-31');
      expect(journalDateWindowError(d), d).toBeNull();
    }
  });

  it('YYYY/M/D, M/D/YYYY and month names: the day Postgres (DateStyle ISO, MDY) stores', () => {
    for (const d of ['2025/3/31', '03/31/2025', 'March 31, 2025', 'Mar 31 2025', '31 March 2025', 'sept 30, 2025']) {
      expect(journalDateWindowError(d), d).toBeNull();
    }
    expect(ledgerDay('2025/3/31')).toBe('2025-03-31');
    expect(ledgerDay('03/31/2025')).toBe('2025-03-31');
    expect(ledgerDay('31 March 2025')).toBe('2025-03-31');
    expect(ledgerDay('sept 30, 2025')).toBe('2025-09-30');
  });

  it('a 5- or 6-digit year with a time is still refused', () => {
    for (const d of ['100000-01-01T00:00:00', '100000-01-01', '0001-06-01T00:00:00']) {
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
