/**
 * The credit half of a customer invoice whose lines carry a VAT type (migration 1008): one revenue leg per account,
 * job, CC1, CC2, BU and VAT type, each the sum of its lines' net and coded with the type; one VAT Output leg per rated
 * type for the sum of its lines' tax_amount. Pure, so every rule is proven against the REAL journal validator.
 */
import { describe, it, expect } from 'vitest';
import {
  lineVatShape, typedInvoiceCreditLegs, typedLinesProblem, type StoredVatLine,
} from '@/modules/accounting/services/ar/invoiceVatLegs';
import { InvoiceLineCodingRefusal } from '@/modules/accounting/services/ar/invoiceLineCoding';
import { validateJournalEntry } from '@/modules/accounting/utils/doubleEntry';
import type { JournalLineInput } from '@/modules/accounting/types/gl.types';

const DEFAULT = 'acct-default-revenue';
const VAT = 'acct-vat-output';
const COMMERCIALS = 'acct-commercials';

const typed = (amount: number, vatType: string, taxAmount: number, extra: Partial<StoredVatLine> = {}): StoredVatLine =>
  ({ amount, glAccountId: null, projectId: null, vatType, taxAmount, ...extra });
const legacy = (amount: number): StoredVatLine => ({ amount, glAccountId: null, projectId: null });

const header = (subtotal: number, taxAmount: number) =>
  ({ subtotal, taxAmount, totalAmount: Math.round((subtotal + taxAmount) * 100) / 100, invoiceDate: '2026-07-01', amountsAre: null });

const post = (lines: StoredVatLine[], subtotal: number, taxAmount: number) =>
  typedInvoiceCreditLegs({
    invoiceNumber: 'INV-9', header: header(subtotal, taxAmount), lines,
    defaultRevenueAccountId: DEFAULT, vatOutputAccountId: VAT,
  });

const shape = (legs: JournalLineInput[]) => legs.map((l) => [l.glAccountId, l.debit, l.credit, l.vatType ?? null]);
const balances = (legs: JournalLineInput[], total: number) =>
  validateJournalEntry([{ glAccountId: 'acct-ar', debit: total, credit: 0 }, ...legs]).valid;

describe('lineVatShape', () => {
  it('legacy when no line is typed (and for no lines at all)', () => {
    expect(lineVatShape([legacy(100), legacy(50)])).toBe('legacy');
    expect(lineVatShape([])).toBe('legacy');
  });
  it('typed when every line is', () => {
    expect(lineVatShape([typed(100, 'standard', 15), typed(50, 'exempt', 0)])).toBe('typed');
  });
  it('partial when some are and some are not', () => {
    expect(lineVatShape([typed(100, 'standard', 15), legacy(50)])).toBe('partial');
  });
});

describe('typedInvoiceCreditLegs', () => {
  it('a mixed invoice: one revenue leg per type, one VAT leg for the rated one, balancing DR AR 1650', () => {
    const legs = post([typed(1000, 'standard', 150), typed(300, 'zero_rated', 0), typed(200, 'exempt', 0)], 1500, 150);
    expect(shape(legs)).toEqual([
      [DEFAULT, 0, 1000, 'standard'],
      [DEFAULT, 0, 300, 'zero_rated'],
      [DEFAULT, 0, 200, 'exempt'],
      [VAT, 0, 150, 'standard'],
    ]);
    expect(legs.map((l) => l.description)).toEqual(['Revenue: INV-9', 'Revenue: INV-9', 'Revenue: INV-9', 'VAT Output: INV-9']);
    expect(balances(legs, 1650)).toBe(true);
  });

  it('VAT rounded on the line: seven lines of 14.29 standard carry 14.98 of VAT and balance', () => {
    const lines = Array.from({ length: 7 }, () => typed(14.29, 'standard', 2.14));
    const legs = post(lines, 100.03, 14.98);
    expect(shape(legs)).toEqual([[DEFAULT, 0, 100.03, 'standard'], [VAT, 0, 14.98, 'standard']]);
    expect(balances(legs, 115.01)).toBe(true);
  });

  it('lines sharing an account and tags but differing in type stay separate legs; same type merges', () => {
    const legs = post([
      typed(600, 'standard', 90, { glAccountId: COMMERCIALS, projectId: 'p1' }),
      typed(400, 'exempt', 0, { glAccountId: COMMERCIALS, projectId: 'p1' }),
      typed(100, 'standard', 15, { glAccountId: COMMERCIALS, projectId: 'p1' }),
    ], 1100, 105);
    expect(legs.map((l) => [l.glAccountId, l.projectId, l.credit, l.vatType])).toEqual([
      [COMMERCIALS, 'p1', 700, 'standard'],
      [COMMERCIALS, 'p1', 400, 'exempt'],
      [VAT, undefined, 105, 'standard'],
    ]);
    expect(balances(legs, 1205)).toBe(true);
  });

  it('a zero-amount leg is dropped, and a zero-rated invoice posts no VAT leg', () => {
    const legs = post([typed(500, 'zero_rated', 0), typed(0, 'exempt', 0)], 500, 0);
    expect(shape(legs)).toEqual([[DEFAULT, 0, 500, 'zero_rated']]);
    expect(balances(legs, 500)).toBe(true);
  });

  it('a group netting negative posts as a debit on its own leg', () => {
    const legs = post([typed(1000, 'standard', 150), typed(-100, 'exempt', 0)], 900, 150);
    expect(shape(legs)).toEqual([[DEFAULT, 0, 1000, 'standard'], [DEFAULT, 100, 0, 'exempt'], [VAT, 0, 150, 'standard']]);
    expect(balances(legs, 1050)).toBe(true);
  });

  it('a line\'s amount is its net whatever the invoice\'s amounts_are: it posts as stored, never less its VAT', () => {
    // An inclusive invoice's line priced at 115 incl. stores amount 100 (net) and tax_amount 15.
    const legs = post([typed(100, 'standard', 15)], 100, 15);
    expect(shape(legs)).toEqual([[DEFAULT, 0, 100, 'standard'], [VAT, 0, 15, 'standard']]);
    expect(balances(legs, 115)).toBe(true);
    // The same line storing its gross (115) as the amount does not foot.
    expect(() => post([typed(115, 'standard', 15)], 100, 15)).toThrow(/line 1 is standard: its VAT on 115\.00 at 15% is 17\.25, but it carries 15\.00/);
  });

  it('the line dimensions ride on the revenue leg, never on the VAT leg', () => {
    const legs = post([typed(100, 'standard', 15, { cc1Id: 'fno', cc2Id: 'cc2', buId: 'bu' })], 100, 15);
    expect(legs[0]).toMatchObject({ cc1Id: 'fno', cc2Id: 'cc2', buId: 'bu', vatType: 'standard' });
    expect(legs[1]).toEqual({ glAccountId: VAT, debit: 0, credit: 15, description: 'VAT Output: INV-9', vatType: 'standard' });
  });

  it('refuses a partly typed invoice', () => {
    expect(() => post([typed(100, 'standard', 15), legacy(50)], 150, 15)).toThrow(InvoiceLineCodingRefusal);
    expect(() => post([typed(100, 'standard', 15), legacy(50)], 150, 15)).toThrow(/Re-save the draft/);
  });

  it('refuses lines whose net does not foot to the subtotal, by a single cent', () => {
    expect(() => post([typed(1000, 'standard', 150), typed(300, 'zero_rated', 0)], 1300.01, 150))
      .toThrow(/Invoice INV-9: its lines' net adds up to 1300.00 but its subtotal is 1300.01/);
  });

  it('refuses lines whose VAT does not foot to the VAT total, by a single cent', () => {
    expect(() => post([typed(1000, 'standard', 150)], 1000, 150.01))
      .toThrow(/its lines' VAT adds up to 150.00 but its VAT total is 150.01/);
  });

  it('refuses an unrated line that carries VAT, and a type no code knows', () => {
    expect(() => post([typed(100, 'exempt', 15)], 100, 15)).toThrow(/line 1 is exempt, which charges no VAT/);
    expect(() => post([typed(100, 'zero', 0)], 100, 0)).toThrow(/line 1 has the unknown VAT type "zero"/);
  });

  it('refuses untyped lines: the caller posts those the legacy way', () => {
    expect(() => post([legacy(100)], 100, 15)).toThrow(/not typed/);
  });
});

describe('typedLinesProblem', () => {
  it('is null for a legacy invoice whatever its header says', () => {
    expect(typedLinesProblem([legacy(100)], header(999, 1))).toBeNull();
  });
  it('is null for a typed invoice that foots to the cent', () => {
    expect(typedLinesProblem([typed(1000, 'standard', 150), typed(500, 'exempt', 0)], header(1500, 150))).toBeNull();
  });
});
