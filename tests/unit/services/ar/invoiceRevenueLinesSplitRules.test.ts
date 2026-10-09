/**
 * When the revenue split depends on the lines, and what posts past draft
 * (review #685):
 *
 * - a single (CC1, CC2, BU) group — every line on the customer's FNO, say —
 *   takes the whole credit as master posted it, whatever the line amounts say;
 *   only a split that depends on the lines (an account or a job, or more than
 *   one group) holds them to the subtotal;
 * - past draft (`strict: false`) the invoice posts as stored, refusing
 *   nothing: lines that do not foot split by weight, and weights that sum to
 *   nothing post one default leg keeping the CC1 every line shares;
 * - the rounding residual is placed a cent at a time, so no share moves more
 *   than a cent (100 lines of 1c against a 50c subtotal posted a 49c DEBIT).
 */
import { describe, expect, it } from 'vitest';
import {
  allocateByWeight, buildInvoiceRevenueLines, revenueSplitDependsOnLines, type StoredRevenueLine,
} from '@/modules/accounting/services/ar/invoiceRevenueLines';
import { InvoiceLineCodingRefusal } from '@/modules/accounting/services/ar/invoiceLineCoding';
import { validateJournalEntry } from '@/modules/accounting/utils/doubleEntry';

const DEFAULT = 'acct-default-revenue';
const line = (amount: number, extra: Partial<StoredRevenueLine> = {}): StoredRevenueLine =>
  ({ amount, glAccountId: null, projectId: null, ...extra });
const build = (lines: StoredRevenueLine[], documentSubtotal: number, strict?: boolean) => buildInvoiceRevenueLines({
  invoiceNumber: 'INV-1', documentSubtotal, credit: documentSubtotal, lines, defaultRevenueAccountId: DEFAULT,
  ...(strict === undefined ? {} : { strict }),
});

describe('revenueSplitDependsOnLines', () => {
  it('is false for one dimension group, true for an account, a job or a second group', () => {
    expect(revenueSplitDependsOnLines([line(60, { cc1Id: 'fno' }), line(40, { cc1Id: 'fno' })])).toBe(false);
    expect(revenueSplitDependsOnLines([line(60, { cc1Id: 'fno', glAccountId: 'acct-x' })])).toBe(true);
    expect(revenueSplitDependsOnLines([line(60, { cc1Id: 'fno', projectId: 'job-1' })])).toBe(true);
    expect(revenueSplitDependsOnLines([line(60, { cc1Id: 'fno', buId: 'a' }), line(40, { cc1Id: 'fno', buId: 'b' })])).toBe(true);
  });
});

describe('one dimension group takes the whole credit, as master posted it', () => {
  it('lines that do not add up to the subtotal post the subtotal, tagged, without a refusal', () => {
    expect(build([line(60, { cc1Id: 'fno' }), line(47, { cc1Id: 'fno' })], 100)).toEqual([
      { glAccountId: DEFAULT, debit: 0, credit: 100, description: 'Revenue: INV-1', cc1Id: 'fno' },
    ]);
  });
});

describe('past draft (strict: false) posts as stored, refusing nothing', () => {
  it('approving refuses lines that do not foot; past draft splits them by weight', () => {
    const lines = [line(500, { buId: 'a' }), line(500, { buId: 'b' })];
    expect(() => build(lines, 1050)).toThrow(InvoiceLineCodingRefusal);
    const posted = build(lines, 1050, false);
    expect(posted.map((l) => [l.buId, l.credit])).toEqual([['a', 525], ['b', 525]]);
  });

  it('weights that sum to nothing post one default leg keeping the CC1 every line shares', () => {
    const lines = [line(50, { cc1Id: 'fno', buId: 'a' }), line(-50, { cc1Id: 'fno', buId: 'b' })];
    expect(() => build(lines, 10)).toThrow(InvoiceLineCodingRefusal);
    expect(build(lines, 10, false)).toEqual([
      { glAccountId: DEFAULT, debit: 0, credit: 10, description: 'Revenue: INV-1', cc1Id: 'fno' },
    ]);
  });
});

describe('the rounding residual is placed a cent at a time', () => {
  it('100 lines of 1c against a 50c subtotal: no debit leg, and the credits sum to 50c', () => {
    const lines = Array.from({ length: 100 }, (_, i) => line(0.01, { glAccountId: `acc-${i}` }));
    const posted = build(lines, 0.5);
    expect(posted.every((l) => l.debit === 0)).toBe(true);
    expect(Math.round(posted.reduce((s, l) => s + l.credit, 0) * 100)).toBe(50);
    expect(validateJournalEntry([{ glAccountId: 'ar', debit: 0.5, credit: 0 }, ...posted]).valid).toBe(true);
  });

  it('allocateByWeight moves no share more than a cent from its rounded value, and sums exactly', () => {
    const shares = allocateByWeight(50, Array.from({ length: 100 }, () => 1));
    expect(Math.min(...shares)).toBeGreaterThanOrEqual(0);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(50);
    const mixed = allocateByWeight(37, [40, 30, -3, 2]);
    expect(mixed[2]).toBeLessThanOrEqual(0);
    expect(mixed.reduce((a, b) => a + b, 0)).toBe(37);
  });
});
