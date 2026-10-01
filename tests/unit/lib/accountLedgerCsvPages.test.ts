import { describe, it, expect } from 'vitest';
import { buildAccountLedgerCsv } from '@/lib/csv/accountLedgerCsv';
import type { AccountLedgerMeta, AccountLedgerRow } from '@/modules/accounting/services/reports/accountLedgerTypes';

const meta: AccountLedgerMeta = {
  accountId: 'a', accountCode: '4000', accountName: 'Sales', accountType: 'revenue', normalBalance: 'credit',
};

const row = (date: string, credit: number, runningBalance: number): AccountLedgerRow => ({
  journalEntryId: 'j', entryDate: date, entryNumber: 'JE', description: 'sale', reference: '', source: 'manual',
  debit: 0, credit, runningBalance,
});
const closeRow = (date: string, debit: number): AccountLedgerRow => ({
  journalEntryId: '', entryDate: date, entryNumber: '', description: `Closed to retained earnings — FY ending ${date} (derived — not posted)`,
  reference: '', source: 'year_end_close', debit, credit: 0, runningBalance: 0, derived: true,
});

// Opening 100, then: +10 (110), +20 (130), CLOSE 130 (0), +5 (5), +7 (12). Five rows over pages of 2.
const all: AccountLedgerRow[] = [
  row('2025-01-10', 10, 110), row('2025-02-10', 20, 130), closeRow('2025-02-28', 130),
  row('2025-03-05', 5, 5), row('2025-04-05', 7, 12),
];
const pages = [all.slice(0, 2), all.slice(2, 4), all.slice(4, 6)];

/** First field after the (empty) date/entry columns: label, and last field: balance. */
function sentinel(csv: string, which: 'first' | 'last') {
  const lines = csv.split('\n');
  const l = which === 'first' ? lines[1]! : lines[lines.length - 1]!;
  const parts = l.split(',');
  return { label: parts[2]!.replace(/"/g, ''), balance: Number(parts[parts.length - 1]) };
}

describe('buildAccountLedgerCsv across pages', () => {
  const csv = pages.map((p, i) =>
    buildAccountLedgerCsv(meta, p, 100, 12, { page: i + 1, totalPages: pages.length }));

  it('page 1 opens at the ledger opening and ends carried forward at its last row', () => {
    expect(sentinel(csv[0]!, 'first')).toEqual({ label: 'Opening Balance', balance: 100 });
    expect(sentinel(csv[0]!, 'last')).toEqual({ label: 'Balance Carried Forward', balance: 130 });
  });

  it('page 2 opens at page 1 close and carries the derived close row like any other', () => {
    expect(sentinel(csv[1]!, 'first')).toEqual({ label: 'Balance Brought Forward', balance: 130 });
    expect(csv[1]).toContain('"year_end_close"');
    expect(csv[1]).toContain('(derived — not posted)');
    expect(sentinel(csv[1]!, 'last')).toEqual({ label: 'Balance Carried Forward', balance: 5 });
  });

  it('a page opening after a derived close row would be zero-based: page 3 opens at 5', () => {
    expect(sentinel(csv[2]!, 'first')).toEqual({ label: 'Balance Brought Forward', balance: 5 });
  });

  it('the last page closes at the true period closing balance', () => {
    expect(sentinel(csv[2]!, 'last')).toEqual({ label: 'Closing Balance', balance: 12 });
  });

  it('every page opening is the previous page closing', () => {
    for (let i = 1; i < csv.length; i += 1) {
      expect(sentinel(csv[i]!, 'first').balance).toBe(sentinel(csv[i - 1]!, 'last').balance);
    }
  });

  it('a single page keeps the plain Opening / Closing labels', () => {
    const one = buildAccountLedgerCsv(meta, all, 100, 12, { page: 1, totalPages: 1 });
    expect(sentinel(one, 'first').label).toBe('Opening Balance');
    expect(sentinel(one, 'last')).toEqual({ label: 'Closing Balance', balance: 12 });
  });

  it('defaults to a single page when no page info is given', () => {
    expect(buildAccountLedgerCsv(meta, all, 100, 12)).toBe(buildAccountLedgerCsv(meta, all, 100, 12, { page: 1, totalPages: 1 }));
  });

  it('a page past the end (no rows) falls back to the ledger figures', () => {
    const empty = buildAccountLedgerCsv(meta, [], 100, 12, { page: 4, totalPages: 3 });
    expect(sentinel(empty, 'first').balance).toBe(100);
    expect(sentinel(empty, 'last').balance).toBe(12);
  });
});
