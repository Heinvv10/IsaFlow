/**
 * The New Quote modal's three modes, as specified in PR #1921 (the invoice form's rules, per line):
 *   Excluding VAT  prices as typed, `amountsAre` exclusive; each line's VAT on top, rounded on the line.
 *   Including VAT  prices as typed (VAT-inclusive), `amountsAre` inclusive; the server backs each line's VAT out of its
 *                  gross, so the stored total is exactly the gross typed.
 *   No VAT         untyped lines, `amountsAre` exclusive, an explicit taxRate 0 (the invoice sends header rate 0); no VAT.
 * What the modal shows (formTotals) must equal what the server stores for the body it sends (previewInvoiceVat reads
 * the sent vatType / taxRate / amountsAre, as quoteLineTax does), in each mode.
 */
import { describe, expect, it } from 'vitest';
import { quoteBody, type QuoteFormLine } from '@/components/accounting/customer-quotes/quoteFormVat';
import { formTotals, type LineVatTypeOrNone } from '@/components/accounting/customer-invoices/formVat';
import type { TaxMode } from '@/components/accounting/customer-invoices/taxMode';
import { previewInvoiceVat } from '@/modules/accounting/services/ar/invoiceLineVatPricing';

const DATE = '2026-11-11';
const form = { clientId: 'c1', customerName: 'Acme', quoteDate: DATE, expiryDate: '', notes: '' };
const mk = (quantity: number, unitPrice: number, i = 0): QuoteFormLine => ({ key: `k${i}`, description: `L${i}`, quantity, unitPrice });

const sentBody = (lines: QuoteFormLine[], types: LineVatTypeOrNone[], mode: TaxMode) => {
  const built = quoteBody(form, lines, mode, types);
  if ('problem' in built) throw new Error(built.problem);
  return built.body;
};
/** The server's pricing of the sent body: a typed line's vatType, or a legacy rate 0 (stored zero-rated, or untyped for a non-vendor). */
const serverTotals = (lines: QuoteFormLine[], types: LineVatTypeOrNone[], mode: TaxMode) => {
  const b = sentBody(lines, types, mode);
  return previewInvoiceVat(b.lines.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice, discount: 0 })),
    b.lines.map((l) => l.vatType ?? (l.taxRate === 0 ? ('zero_rated' as const) : (() => { throw new Error('line names no VAT'); })())), DATE, b.amountsAre);
};

const sets: { name: string; lines: QuoteFormLine[]; types: ('standard' | 'zero_rated' | 'exempt')[] }[] = [
  { name: '1 x R10', lines: [mk(1, 10)], types: ['standard'] },
  { name: '3 x R10', lines: [mk(3, 10)], types: ['standard'] },
  { name: '7 x R16.43 + exempt + zero-rated', lines: [mk(7, 16.43, 0), mk(2, 57.5, 1), mk(1, 9.99, 2)], types: ['standard', 'exempt', 'zero_rated'] },
];

describe('the figures the modal shows are the figures the body stores, in each mode', () => {
  for (const { name, lines, types } of sets) {
    for (const mode of ['exclusive', 'inclusive'] as const) {
      it(`${name}, ${mode}`, () => expect(serverTotals(lines, types, mode)).toEqual(formTotals(lines, types, mode, DATE)));
    }
    it(`${name}, No VAT: no VAT, total = the net typed`, () => {
      const none = types.map(() => null);
      const stored = serverTotals(lines, none, 'none');
      expect(stored).toEqual(formTotals(lines, none, 'none', DATE));
      expect(stored.tax).toBe(0);
      expect(stored.total).toBe(Math.round(lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0) * 100) / 100);
    });
  }
});

describe('what each mode sends', () => {
  it('Excluding: the typed price, exclusive, a vatType per line, no taxRate', () => {
    const b = sentBody([mk(3, 10)], ['standard'], 'exclusive');
    expect(b.amountsAre).toBe('exclusive');
    expect(b.lines).toEqual([{ description: 'L0', quantity: 3, unitPrice: 10, lineNo: 1, vatType: 'standard' }]);
  });
  it('Including: the typed (gross) price UNCHANGED, inclusive; the stored total is the gross typed (3 x R10 = R30.00, 1 x R10 = R10.00)', () => {
    const b = sentBody([mk(3, 10)], ['standard'], 'inclusive');
    expect([b.amountsAre, b.lines[0]!.unitPrice, b.lines[0]!.vatType, 'taxRate' in b.lines[0]!]).toEqual(['inclusive', 10, 'standard', false]);
    expect(serverTotals([mk(3, 10)], ['standard'], 'inclusive').total).toBe(30);
    expect(serverTotals([mk(1, 10)], ['standard'], 'inclusive').total).toBe(10);
  });
  it('Including: an exempt / zero-rated line is priced at its own rate (0), the typed price stays the net', () => {
    const t = serverTotals([mk(2, 50), mk(1, 20, 1)], ['exempt', 'zero_rated'], 'inclusive');
    expect([t.tax, t.total]).toEqual([0, 120]);
  });
  it('No VAT: untyped, exclusive, an explicit taxRate 0 on every line, never a vatType, even if a line carries a type', () => {
    const b = sentBody([mk(1, 100), mk(2, 5, 1)], ['standard', 'exempt'], 'none');
    expect(b.amountsAre).toBe('exclusive');
    expect(b.lines.map((l) => [l.unitPrice, l.taxRate, 'vatType' in l])).toEqual([[100, 0, false], [5, 0, false]]);
  });
  it('a VAT mode never sends a taxRate (the server must not read a type off a rate)', () => {
    for (const mode of ['exclusive', 'inclusive'] as const) {
      expect(sentBody([mk(1, 100)], ['standard'], mode).lines.some((l) => 'taxRate' in l)).toBe(false);
    }
  });
});
