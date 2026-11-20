/**
 * The draft edit's per-line VAT (customerInvoiceDraftVat): a line sent without a type keeps the identical stored line's
 * (a stored legacy line reads as standard / zero_rated by its rate), else the default chain with the invoice's customer;
 * a date-only edit of a typed invoice re-taxes its stored lines; the per-line legacy taxRate is held to the type. Every
 * `tx` and `sql` is answered by its statement text, not call order.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  company: { vat_period: 'bi-monthly', vat_system_type: 'invoice', customer_vat: null } as Record<string, unknown>,
  stored: [] as Record<string, unknown>[],
  updates: [] as unknown[][],
}));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    if (text.includes('FROM companies co')) return [db.company];
    return [];
  }),
}));

import { applyRetaxedLines, draftEditVat } from '@/modules/accounting/services/ar/customerInvoiceDraftVat';

const tx = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.join('?');
  if (text.includes('FROM customer_invoice_items cii')) return db.stored;
  if (text.includes('UPDATE customer_invoice_items')) { db.updates.push(values); return []; }
  return [];
});
const CO = '11111111-1111-4111-8111-111111111111';
const INV = '22222222-2222-4222-8222-222222222222';
const CUST = '33333333-3333-4333-8333-333333333333';
const stored = (description: string, qty: number, price: number, vatType: string | null, taxRate: number, amount = qty * price, tax: number | null = null, id = description) =>
  ({ id, description, quantity: String(qty), unit_price: String(price), amount: String(amount), tax_amount: tax == null ? null : String(tax), tax_rate: String(taxRate), vat_type: vatType });
const edit = (over: Partial<Parameters<typeof draftEditVat>[3]> = {}) => draftEditVat(tx, CO, INV, {
  items: undefined, invoiceDate: undefined, headerTaxRate: undefined, amountsAre: undefined, customerId: CUST, stored: { invoice_date: '2026-11-20' }, ...over,
});
const sent = (description: string, quantity: number, unitPrice: number, extra: Record<string, unknown> = {}) => ({ description, quantity, unitPrice, ...extra });

beforeEach(() => {
  tx.mockClear();
  db.company = { vat_period: 'bi-monthly', vat_system_type: 'invoice', customer_vat: null };
  db.stored = []; db.updates = [];
});

describe('lines sent', () => {
  it('a line without a type keeps the identical stored line\'s, even when the customer now defaults otherwise', async () => {
    db.stored = [stored('Rent', 1, 1000, 'exempt', 0, 1000, 0)];
    db.company = { ...db.company, customer_vat: 'zero' };
    const v = await edit({ items: [sent('Rent', 1, 1000), sent('New', 1, 100)] });
    expect(v.kind).toBe('priced');
    if (v.kind !== 'priced') return;
    expect(v.lines.map((l) => [l.vatType, l.taxAmount])).toEqual([['exempt', 0], ['zero_rated', 0]]);
  });

  it('a changed line (another price) is not identical: it takes the default chain', async () => {
    db.stored = [stored('Rent', 1, 1000, 'exempt', 0, 1000, 0)];
    const v = await edit({ items: [sent('Rent', 1, 1100)] });
    expect(v.kind === 'priced' && v.lines[0]!.vatType).toBe('standard');
  });

  it('each stored line is used once, in order', async () => {
    db.stored = [stored('Same', 1, 10, 'exempt', 0, 10, 0, 'a'), stored('Same', 1, 10, 'standard', 15, 10, 1.5, 'b')];
    const v = await edit({ items: [sent('Same', 1, 10), sent('Same', 1, 10), sent('Same', 1, 10)] });
    expect(v.kind === 'priced' && v.lines.map((l) => l.vatType)).toEqual(['exempt', 'standard', 'standard']);
  });

  it('a stored legacy line reads as standard at a rate above zero, zero_rated at 0: a legacy draft becomes typed', async () => {
    db.stored = [stored('A', 1, 100, null, 15), stored('B', 1, 50, null, 0)];
    const v = await edit({ items: [sent('A', 1, 100), sent('B', 1, 50)] });
    expect(v).toMatchObject({ kind: 'priced', header: { subtotal: 150, tax: 15, total: 165, taxRate: 15 } });
    expect(v.kind === 'priced' && v.lines.map((l) => [l.vatType, l.taxAmount, l.taxRate])).toEqual([['standard', 15, 15], ['zero_rated', 0, 0]]);
  });

  it('the legacy header taxRate keeps a stored type of its rate (0 keeps exempt), re-types the others', async () => {
    db.stored = [stored('Rent', 1, 1000, 'exempt', 0, 1000, 0), stored('Fee', 1, 100, 'standard', 15, 100, 15)];
    const v = await edit({ headerTaxRate: 0, items: [sent('Rent', 1, 1000, { taxRate: 0 }), sent('Fee', 1, 100, { taxRate: 0 })] });
    expect(v.kind === 'priced' && v.lines.map((l) => l.vatType)).toEqual(['exempt', 'zero_rated']);
  });

  it('a per-line taxRate that is not its type\'s rate is refused', async () => {
    db.stored = [stored('Rent', 1, 1000, 'exempt', 0, 1000, 0)];
    expect(await edit({ items: [sent('Rent', 1, 1000, { taxRate: 15 })] })).toEqual({
      kind: 'refused', code: 'INVOICE_LINE_VAT_REFUSED',
      message: 'items[0]: taxRate 15 is not the rate of its VAT type exempt (0% on 2026-11-20). Leave taxRate out: the rate comes from the type.',
    });
  });

  it('a line naming a type beats the kept one; a header rate with it is refused', async () => {
    db.stored = [stored('Rent', 1, 1000, 'exempt', 0, 1000, 0)];
    expect(await edit({ items: [sent('Rent', 1, 1000, { vatType: 'standard' })] })).toMatchObject({ kind: 'priced', header: { tax: 150 } });
    expect(await edit({ headerTaxRate: 15, items: [sent('Rent', 1, 1000, { vatType: 'standard' })] })).toMatchObject({ kind: 'refused' });
  });

  it('a company not registered for VAT: untyped, and a standard line refused', async () => {
    db.company = { vat_period: 'none', vat_system_type: 'none', customer_vat: null };
    db.stored = [stored('A', 1, 100, null, 15)];
    expect(await edit({ items: [sent('A', 1, 100)] })).toMatchObject({ kind: 'priced', header: { tax: 0, taxRate: 0 } });
    expect(await edit({ items: [sent('A', 1, 100, { vatType: 'standard' })] })).toMatchObject({ kind: 'refused', code: 'INVOICE_VAT_NOT_REGISTERED' });
  });
});

describe('amountsAre', () => {
  it('the edit\'s mode, else the stored one: an inclusive line stores its net, its price as entered', async () => {
    db.stored = [stored('Ten', 100, 9.99, 'standard', 15, 868.7, 130.3)];
    const kept = await edit({ items: [sent('Ten', 100, 9.99)], stored: { invoice_date: '2026-11-20', amounts_are: 'inclusive' } });
    expect(kept).toMatchObject({ kind: 'priced', header: { subtotal: 868.7, tax: 130.3, total: 999, amountsAre: 'inclusive' } });
    expect(kept.kind === 'priced' && kept.lines[0]).toMatchObject({ price: 9.99, amount: 868.7, taxAmount: 130.3, vatType: 'standard' });
    const ex = await edit({ amountsAre: 'exclusive', items: [sent('Ten', 100, 9.99)], stored: { invoice_date: '2026-11-20', amounts_are: 'inclusive' } });
    expect(ex).toMatchObject({ kind: 'priced', header: { subtotal: 999, tax: 149.85, total: 1148.85, amountsAre: 'exclusive' } });
  });

  it('an inclusive invoice re-taxed at a new date keeps each line\'s gross', async () => {
    db.stored = [stored('A', 1, 114, 'standard', 14, 100, 14, 'l1')];
    expect(await edit({ invoiceDate: '2018-04-01', stored: { invoice_date: '2018-03-31', amounts_are: 'inclusive' } })).toEqual({
      kind: 'retaxed', header: { subtotal: 99.13, tax: 14.87, total: 114, taxRate: 15, amountsAre: 'inclusive' },
      lines: [{ id: 'l1', amount: 99.13, taxAmount: 14.87, taxRate: 15 }],
    });
  });
});

describe('no lines sent', () => {
  it('the date moved across 1 April 2018 on a typed invoice: its stored lines are re-taxed at the new rate', async () => {
    db.stored = [stored('A', 1, 100, 'standard', 14, 100, 14, 'l1'), stored('B', 1, 50, 'exempt', 0, 50, 0, 'l2')];
    const v = await edit({ invoiceDate: '2018-04-01', stored: { invoice_date: '2018-03-31' } });
    expect(v).toEqual({ kind: 'retaxed', header: { subtotal: 150, tax: 15, total: 165, taxRate: 15, amountsAre: 'exclusive' }, lines: [
      { id: 'l1', amount: 100, taxAmount: 15, taxRate: 15 }, { id: 'l2', amount: 50, taxAmount: 0, taxRate: 0 },
    ] });
    await applyRetaxedLines(tx, INV, v);
    expect(db.updates).toEqual([[100, 15, 15, 'l1', INV], [50, 0, 0, 'l2', INV]]);
  });

  it('a legacy invoice whose date moved stays as it is', async () => {
    db.stored = [stored('A', 1, 100, null, 15)];
    expect(await edit({ invoiceDate: '2026-12-01' })).toEqual({ kind: 'unchanged' });
  });

  it('nothing re-priced when the date did not move (a Date from pg reads by its calendar day)', async () => {
    expect(await edit({ invoiceDate: '2026-11-20', stored: { invoice_date: new Date(2026, 10, 20) } })).toEqual({ kind: 'unchanged' });
    expect(await edit({})).toEqual({ kind: 'unchanged' });
    expect(tx).not.toHaveBeenCalled();
  });

  it('a date no rate is known for is refused', async () => {
    db.stored = [stored('A', 1, 100, 'standard', 15, 100, 15)];
    expect(await edit({ invoiceDate: '1990-01-01' })).toMatchObject({ kind: 'refused', code: 'INVOICE_LINE_VAT_REFUSED' });
  });
});
