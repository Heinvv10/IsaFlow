/**
 * K-013 review L1/M3 — the stored template is unvalidated JSONB.
 *
 * `line_items` is written by createRecurringInvoice, the PUT route and the Sage
 * import, and templates predating the current input guards are still in the
 * table. A missing unitPrice used to reach Postgres as NaN, and a quantity of 0
 * or null was coerced to 1 — putting the invoice detail out of agreement with
 * the receivable the GL was debited with.
 */
import { describe, expect, it } from 'vitest';
import {
  assertAggregateAgrees,
  deriveTotals,
  parseLineItems,
  RecurringInvoiceTemplateError,
} from '@/modules/accounting/services/ar/recurringInvoiceTemplate';

const ID = 'ri-1';
const good = [{ description: 'Retainer', quantity: 2, unitPrice: 500 }];

describe('parseLineItems', () => {
  it('parses an array and rounds each line to cents', () => {
    expect(parseLineItems(ID, [{ description: 'Hours', quantity: 3, unitPrice: 33.333 }]))
      .toEqual([{ description: 'Hours', quantity: 3, unitPrice: 33.333, amount: 100 }]);
  });

  it('parses the JSON string shape pg can return for jsonb', () => {
    expect(parseLineItems(ID, JSON.stringify(good))).toHaveLength(1);
  });

  it('refuses unreadable JSON with a named error, not a raw SyntaxError', () => {
    expect(() => parseLineItems(ID, '{not json')).toThrow(RecurringInvoiceTemplateError);
    expect(() => parseLineItems(ID, '{not json')).toThrow(/unreadable line_items/);
  });

  it('refuses an empty template', () => {
    expect(() => parseLineItems(ID, [])).toThrow(/no line items/);
    expect(() => parseLineItems(ID, null)).toThrow(/no line items/);
  });

  it('refuses a line with no description', () => {
    expect(() => parseLineItems(ID, [{ description: '  ', quantity: 1, unitPrice: 10 }]))
      .toThrow(/description is required/);
  });

  it('refuses a non-positive or non-numeric quantity instead of coercing it to 1', () => {
    for (const quantity of [0, -1, null, undefined, 'two']) {
      expect(() => parseLineItems(ID, [{ description: 'X', quantity, unitPrice: 10 }]))
        .toThrow(/quantity must be a positive number/);
    }
  });

  it('refuses a missing or negative unit price instead of writing NaN', () => {
    for (const unitPrice of [undefined, null, 'free', -1]) {
      expect(() => parseLineItems(ID, [{ description: 'X', quantity: 1, unitPrice }]))
        .toThrow(/unit price must be zero or more/);
    }
  });

  it('names the offending line number and description', () => {
    expect(() => parseLineItems(ID, [good[0], { description: 'Bad line', quantity: 0, unitPrice: 1 }]))
      .toThrow(/line 2 \("Bad line"\)/);
  });
});

describe('deriveTotals', () => {
  it('sums the lines and applies the tax rate to cents', () => {
    expect(deriveTotals(parseLineItems(ID, good), 15))
      .toEqual({ subtotal: 1000, taxAmount: 150, totalAmount: 1150 });
  });

  it('handles a zero tax rate', () => {
    expect(deriveTotals(parseLineItems(ID, good), 0))
      .toEqual({ subtotal: 1000, taxAmount: 0, totalAmount: 1000 });
  });
});

describe('assertAggregateAgrees', () => {
  const totals = { subtotal: 1000, taxAmount: 150, totalAmount: 1150 };
  const agg = (over: Record<string, number>) =>
    ({ subtotal: 1000, tax_amount: 150, total_amount: 1150, ...over });

  it('accepts a stored aggregate that matches', () => {
    expect(() => assertAggregateAgrees(ID, totals, agg({}), 1)).not.toThrow();
  });

  it('accepts accumulated per-line cent rounding within one cent per line', () => {
    expect(() => assertAggregateAgrees(ID, totals, agg({ total_amount: 1150.02, subtotal: 1000.02 }), 3))
      .not.toThrow();
  });

  it('refuses a stored total that disagrees with the lines', () => {
    expect(() => assertAggregateAgrees(ID, totals, agg({ total_amount: 9999 }), 1))
      .toThrow(RecurringInvoiceTemplateError);
    expect(() => assertAggregateAgrees(ID, totals, agg({ total_amount: 9999 }), 1))
      .toThrow(/template total is 9999.00, its 1 line\(s\) come to 1150.00/);
  });

  it('refuses a drift of more than the tolerance, not merely a different number', () => {
    expect(() => assertAggregateAgrees(ID, totals, agg({ total_amount: 1150.03 }), 1)).toThrow();
    expect(() => assertAggregateAgrees(ID, totals, agg({ total_amount: 1150.01 }), 1)).not.toThrow();
  });

  it('checks subtotal and tax separately, so a compensating pair cannot pass', () => {
    // Review L5: subtotal understated by 100 and tax overstated by 100 leaves
    // the total correct while the invoice's VAT is wrong.
    expect(() => assertAggregateAgrees(ID, totals, agg({ subtotal: 900, tax_amount: 250 }), 1))
      .toThrow(/template subtotal is 900.00/);
    expect(() => assertAggregateAgrees(ID, totals, agg({ tax_amount: 250, total_amount: 1250 }), 1))
      .toThrow(/template tax is 250.00/);
  });

  it('caps the tolerance at one rand however many lines the template has', () => {
    // Review L5: 0.01 * 500 would have tolerated five rand of drift.
    expect(() => assertAggregateAgrees(ID, totals, agg({ total_amount: 1152 }), 500)).toThrow();
    expect(() => assertAggregateAgrees(ID, totals, agg({ total_amount: 1150.90, subtotal: 1000.90 }), 500))
      .not.toThrow();
  });

  it('ignores a non-numeric stored aggregate rather than throwing on it', () => {
    expect(() => assertAggregateAgrees(ID, totals, { subtotal: null, tax_amount: null, total_amount: null }, 1))
      .not.toThrow();
  });
});
