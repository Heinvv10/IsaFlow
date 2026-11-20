/**
 * What a typed customer invoice may post (PR #1648 review): only the types a document line is offered today
 * (DOCUMENT_LINE_VAT_TYPES); a rated line's VAT is its own (within a cent of its net at its type's rate on the invoice
 * date); a rated type whose lines carry net but whose VAT rounds to nothing (or VAT on no net) is refused, since a
 * coded base with no VAT leg reaches no VAT201 field; the header total is subtotal + VAT. And the VAT Output legs carry
 * the type of the lines that produced them, proven over every rated type the poster allows and, below the refusal,
 * over two rated types.
 */
import { describe, it, expect } from 'vitest';
import {
  POSTABLE_LINE_VAT_TYPES, typedInvoiceCreditLegs, typedLegs, typedLinesProblem, type StoredVatLine,
} from '@/modules/accounting/services/ar/invoiceVatLegs';
import { RATED_VAT_TYPES, VAT_TYPES } from '@/modules/accounting/services/shared/vatTypes';
import { validateJournalEntry } from '@/modules/accounting/utils/doubleEntry';
import type { JournalLineInput } from '@/modules/accounting/types/gl.types';

const DEFAULT = 'acct-default-revenue';
const VAT = 'acct-vat-output';
const typed = (amount: number, vatType: string, taxAmount: number): StoredVatLine =>
  ({ amount, glAccountId: null, projectId: null, vatType, taxAmount });
const header = (subtotal: number, taxAmount: number, totalAmount = Math.round((subtotal + taxAmount) * 100) / 100,
  invoiceDate: string | Date = '2026-07-01', amountsAre: string | null = null) =>
  ({ subtotal, taxAmount, totalAmount, invoiceDate, amountsAre });
const sum = (lines: StoredVatLine[], k: 'amount' | 'taxAmount') =>
  Math.round(lines.reduce((s, l) => s + Number(l[k]), 0) * 100) / 100;
/** The problem with lines footing to their own header (so only the rule under test can fire). */
const problem = (lines: StoredVatLine[], amountsAre: string | null = null) => typedLinesProblem(lines,
  header(sum(lines, 'amount'), sum(lines, 'taxAmount'), undefined, undefined, amountsAre));
const post = (lines: StoredVatLine[]) => typedInvoiceCreditLegs({
  invoiceNumber: 'INV-5', header: header(sum(lines, 'amount'), sum(lines, 'taxAmount')), lines,
  defaultRevenueAccountId: DEFAULT, vatOutputAccountId: VAT,
});
const vatLegs = (legs: JournalLineInput[]) => legs.filter((l) => l.glAccountId === VAT).map((l) => [l.debit, l.credit, l.vatType]);

describe('the types a customer invoice line may post', () => {
  it('is exactly the document-line list: standard, zero_rated, exempt', () => {
    expect([...POSTABLE_LINE_VAT_TYPES].sort()).toEqual(['exempt', 'standard', 'zero_rated']);
  });

  it.each(VAT_TYPES.filter((t) => !(POSTABLE_LINE_VAT_TYPES as readonly string[]).includes(t)))(
    'refuses a line typed %s, naming the line and the type', (type) => {
      const lines = [typed(100, 'standard', 15), typed(50, type, 0)];
      expect(problem(lines)).toBe(`line 2 is typed ${type}, which a customer invoice line cannot post yet `
        + '(standard, zero_rated or exempt). Re-save the draft with one of those.');
    });
});

describe('a rated line\'s VAT is its own', () => {
  it('refuses a standard line carrying no VAT, and one carrying VAT at another rate', () => {
    expect(problem([typed(1000, 'standard', 0)])).toMatch(/^line 1 is standard: its VAT on 1000\.00 at 15% is 150\.00, but it carries 0\.00\./);
    expect(problem([typed(100, 'standard', 50)])).toMatch(/^line 1 is standard: its VAT on 100\.00 at 15% is 15\.00, but it carries 50\.00\./);
  });

  it('exclusive (or unset): the VAT is exactly vatLineAmounts\', not a cent off', () => {
    expect(problem([typed(100, 'standard', 15)])).toBeNull();
    expect(problem([typed(100, 'standard', 15.01)])).toMatch(/carries 15\.01/);
    expect(problem([typed(100, 'standard', 14.99)], 'exclusive')).toMatch(/carries 14\.99/);
  });

  it('inclusive: one cent either way (the VAT was backed out of a gross), not two', () => {
    expect(problem([typed(100, 'standard', 15.01)], 'inclusive')).toBeNull();
    expect(problem([typed(100, 'standard', 14.99)], 'inclusive')).toBeNull();
    expect(problem([typed(100, 'standard', 15.02)], 'inclusive')).toMatch(/carries 15\.02/);
  });

  it('reads the rate on the invoice date, a Date or a string', () => {
    expect(typedLinesProblem([typed(100, 'standard', 14)], header(100, 14, 114, '2017-06-30'))).toBeNull();
    expect(typedLinesProblem([typed(100, 'standard', 14)], header(100, 14, 114, new Date(2026, 6, 1)))).toMatch(/at 15% is 15\.00/);
  });

  it('refuses a rated type whose net is real but whose VAT rounds to nothing', () => {
    expect(problem([typed(0.03, 'standard', 0), typed(500, 'exempt', 0)]))
      .toMatch(/^its standard lines come to 0\.03 but the VAT on them rounds to nothing/);
  });

  it('refuses the breaker\'s +100 / VAT 15 and -100 / VAT 0 (net 0, VAT 15), at the line', () => {
    expect(problem([typed(100, 'standard', 15), typed(-100, 'standard', 0)]))
      .toMatch(/^line 2 is standard: its VAT on -100\.00 at 15% is -15\.00, but it carries 0\.00\./);
  });

  it('refuses VAT on no net, though every line is within its cent (inclusive)', () => {
    expect(problem([typed(100, 'standard', 15), typed(-100, 'standard', -14.99)], 'inclusive'))
      .toMatch(/^its standard lines carry 0\.01 of VAT on no net/);
  });

  it('per-line rounding may differ from VAT on the subtotal by more than a cent: thirteen lines of 0.10', () => {
    const lines = Array.from({ length: 13 }, () => typed(0.1, 'standard', 0.02));
    expect(problem(lines)).toBeNull();
    expect(vatLegs(post(lines))).toEqual([[0, 0.26, 'standard']]);
  });
});

describe('the header total', () => {
  it('refuses a total that is not subtotal + VAT, to the cent', () => {
    expect(typedLinesProblem([typed(100, 'standard', 15)], header(100, 15, 115.01)))
      .toMatch(/^its total is 115\.01 but its subtotal plus VAT is 115\.00/);
    expect(() => typedInvoiceCreditLegs({ invoiceNumber: 'INV-5', header: header(100, 15, 114), lines: [typed(100, 'standard', 15)],
      defaultRevenueAccountId: DEFAULT, vatOutputAccountId: VAT })).toThrow(/Invoice INV-5: its total is 114\.00/);
  });
});

describe('VAT Output legs carry the type of their lines', () => {
  const allowedRated = RATED_VAT_TYPES.filter((t) => (POSTABLE_LINE_VAT_TYPES as readonly string[]).includes(t));

  it('the poster allows at least one rated type', () => expect(allowedRated.length).toBeGreaterThan(0));

  it.each(allowedRated)('a %s line posts a VAT leg coded %s', (type) => {
    const legs = post([typed(1000, type, 150), typed(300, 'zero_rated', 0)]);
    expect(vatLegs(legs)).toEqual([[0, 150, type]]);
  });

  it('below the refusal: two rated types post two VAT legs, each on its own type', () => {
    const legs = typedLegs([typed(1000, 'standard', 150), typed(400, 'capital_goods', 60), typed(200, 'standard', 30)],
      'INV-5', DEFAULT, VAT);
    expect(vatLegs(legs)).toEqual([[0, 180, 'standard'], [0, 60, 'capital_goods']]);
    expect(validateJournalEntry([{ glAccountId: 'acct-ar', debit: 1840, credit: 0 }, ...legs]).valid).toBe(true);
  });

  it('a credit line\'s negative VAT posts as a debit VAT leg; mixed signs within one type net', () => {
    expect(vatLegs(post([typed(-100, 'standard', -15), typed(200, 'exempt', 0)]))).toEqual([[15, 0, 'standard']]);
    expect(vatLegs(post([typed(100, 'standard', 15), typed(-40, 'standard', -6)]))).toEqual([[0, 9, 'standard']]);
  });
});
