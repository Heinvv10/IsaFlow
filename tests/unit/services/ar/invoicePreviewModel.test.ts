/**
 * Master plan wave 4, PR PV: the unsaved invoice's PDF model. Built from the body the new page's Create sends
 * (createBody), its totals are the page's own (formVat.formTotals, per-line VAT) for amounts excluding VAT,
 * including VAT and with no VAT, and in a foreign currency; the body's caps; no number, status preview; the one read is
 * scoped to the company, and a customer or job it does not find is a 404 or an unrecognised job, never a lookup
 * elsewhere.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: m.sql }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { createBody } from '@/components/accounting/customer-invoices/newInvoiceBody';
import type { InvoiceLine } from '@/components/accounting/customer-invoices/InvoiceLineItemsTable';
import type { InvoiceHeaderForm } from '@/components/accounting/customer-invoices/invoiceHeaderForm';
import { effectiveTaxRate, type TaxMode } from '@/components/accounting/customer-invoices/taxMode';
import { formTotals } from '@/components/accounting/customer-invoices/formVat';
import { parsePreviewBody, PREVIEW_MAX_BYTES, PREVIEW_MAX_LINES, PreviewBodyError } from '@/modules/accounting/services/ar/invoicePreviewBody';
import { buildInvoicePreviewModel, JOB_NOT_RECOGNISED } from '@/modules/accounting/services/ar/invoicePreviewModel';
import { priceInvoiceVat } from '@/modules/accounting/services/ar/invoiceLineVatPricing';

const CO = '00000000-0000-4000-8000-0000000000c0';
const CLIENT = '00000000-0000-4000-8000-0000000000c1';
const JOB = '00000000-0000-4000-8000-0000000000c2';
const ROW = {
  client_name: 'Acme', client_address: null, client_contact: null, client_email: null, client_phone: null, client_vat: null,
  contact_terms_days: 30, contact_terms_type: 'invoice_days', company_default_terms: null, project_name: null,
  company_found: true, functional_currency: 'ZAR', fx_documents_enabled: true, company_name: 'Issuer', address_line1: null,
  address_line2: null, city: null, province: null, postal_code: null, company_phone: null, company_email: null, company_vat: null,
  bank_name: null, bank_account_number: null, bank_branch_code: null, primary_color: null, company_logo: null,
};
const FORM: InvoiceHeaderForm = { clientId: CLIENT, invoiceDate: '2026-11-06', dueDate: '', billingPeriodStart: '2026-11-06',
  billingPeriodEnd: '2026-11-06', taxRate: 15, notes: '', currencyCode: 'ZAR', exchangeRate: 1, projectId: '' };
const line = (key: string, quantity: number, unitPrice: number, discount = 0): InvoiceLine => ({ key, description: `Line ${key}`,
  quantity, unitPrice, discount, glAccountId: '', projectId: '', cc2Id: '', buId: '', incomeType: 'other' });

/** What the page shows and what the preview prints, for one form. */
async function both(mode: TaxMode, lines: InvoiceLine[], form: InvoiceHeaderForm = FORM) {
  const rate = effectiveTaxRate(mode, form.taxRate);
  const page = formTotals(lines, rate, mode, form.invoiceDate);
  const built = createBody(form, lines, mode, rate, {});
  if (!('body' in built)) throw new Error(built.problem);
  const preview = await buildInvoicePreviewModel(CO, parsePreviewBody(JSON.parse(JSON.stringify(built.body))));
  const inv = preview!.model.invoice;
  return { page, printed: { subtotal: inv.subtotal, tax: inv.tax_amount, total: inv.total_amount }, preview: preview! };
}

beforeEach(() => { m.sql.mockReset(); m.sql.mockResolvedValue([ROW]); });

describe('the preview prints the totals the page shows (create\'s pricing)', () => {
  it.each<[TaxMode, InvoiceLine[]]>([
    ['exclusive', [line('1', 3, 10), line('2', 1.5, 99.99, 12.5)]],
    ['inclusive', [line('1', 3, 10)]], // 3 × R10 incl.: stored as entered, R26.09 + R3.91 = R30.00 (it was R30.02)
    ['inclusive', [line('1', 7, 33.33, 5), line('2', 2, 0.07)]],
    ['none', [line('1', 3, 10), line('2', 2, 49.995)]],
  ])('%s', async (mode, lines) => {
    const { page, printed } = await both(mode, lines);
    expect(printed).toEqual(page);
  });

  it('pins the inclusive 3 × R10 case to the cent: the price prints as entered, the amount its net', async () => {
    const { printed, preview } = await both('inclusive', [line('1', 3, 10)]);
    expect(printed).toEqual({ subtotal: 26.09, tax: 3.91, total: 30 });
    expect(preview.model.invoice.amounts_are).toBe('inclusive');
    expect(preview.model.items).toEqual([{ description: 'Line 1', quantity: 3, unit_price: 10, amount: 26.09, tax_rate: 15,
      tax_amount: 3.91, vat_type: 'standard' }]);
  });

  it('in a foreign currency: the document figures, and its currency and rate', async () => {
    const fx = { ...FORM, currencyCode: 'USD', exchangeRate: 18.25 };
    const { page, printed, preview } = await both('exclusive', [line('1', 2, 120.5)], fx);
    expect(printed).toEqual(page);
    expect(preview.model.invoice).toMatchObject({ currency_code: 'USD', exchange_rate: 18.25 });
  });

  it('refuses a foreign currency the company has not enabled, as create does', async () => {
    m.sql.mockResolvedValue([{ ...ROW, fx_documents_enabled: false }]);
    await expect(both('exclusive', [line('1', 1, 10)], { ...FORM, currencyCode: 'USD', exchangeRate: 18 })).rejects.toThrow(/not enabled/);
  });
});

describe('what the preview is', () => {
  it('has no number, status preview, and the due date from the customer\'s terms', async () => {
    const { preview } = await both('exclusive', [line('1', 1, 10)]);
    expect(preview.model.invoice).toMatchObject({ invoice_number: null, status: 'preview', amount_paid: 0, due_date: '2026-12-06',
      client_name: 'Acme', client_terms: '30 days from invoice date' });
    expect(preview.notes).toEqual([]);
  });

  it('reads once, with the company and the customer as parameters', async () => {
    await both('exclusive', [line('1', 1, 10)], { ...FORM, projectId: JOB });
    expect(m.sql).toHaveBeenCalledTimes(1);
    const [strings, ...values] = m.sql.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(strings.join('?')).toMatch(/WHERE c\.id = \?::UUID AND c\.company_id = \?::UUID/);
    expect(strings.join('?')).toMatch(/p\.id = \?::UUID AND p\.company_id = c\.company_id/);
    expect(values).toEqual(expect.arrayContaining([CLIENT, CO, JOB]));
  });

  it('a customer the company does not have is null (the route\'s 404)', async () => {
    m.sql.mockResolvedValue([]);
    expect(await buildInvoicePreviewModel(CO, parsePreviewBody({ clientId: CLIENT, items: [{ description: 'x', unitPrice: 1 }] }))).toBeNull();
  });

  it('a job not found is printed as none, with a note', async () => {
    const { preview } = await both('exclusive', [line('1', 1, 10)], { ...FORM, projectId: JOB });
    expect(preview.model.invoice.project_name).toBeNull();
    expect(preview.notes).toEqual([JOB_NOT_RECOGNISED]);
  });

  it('a line refused by create is refused here, before any read', async () => {
    await expect(buildInvoicePreviewModel(CO, parsePreviewBody({ clientId: CLIENT, items: [{ description: 'x', quantity: -1, unitPrice: 1 }] })))
      .rejects.toThrow(/Line quantities must be positive numbers/);
    expect(m.sql).not.toHaveBeenCalled();
  });
});

describe('the body\'s caps and shape', () => {
  const items = (n: number) => Array.from({ length: n }, () => ({ description: 'x', quantity: 1, unitPrice: 1 }));

  it(`takes ${PREVIEW_MAX_LINES} lines and refuses one more`, () => {
    expect(parsePreviewBody({ clientId: CLIENT, items: items(PREVIEW_MAX_LINES) }).items).toHaveLength(PREVIEW_MAX_LINES);
    expect(() => parsePreviewBody({ clientId: CLIENT, items: items(PREVIEW_MAX_LINES + 1) })).toThrow(PreviewBodyError);
  });

  it('refuses a body over 64 KB', () => {
    // Each line within the text caps (2,000 characters); it is their sum that is too large.
    const long = (n: number) => Array.from({ length: n }, () => ({ description: 'd'.repeat(2000), quantity: 1, unitPrice: 1 }));
    expect(() => parsePreviewBody({ clientId: CLIENT, items: long(Math.ceil(PREVIEW_MAX_BYTES / 2000)) })).toThrow(/too large to preview/);
    expect(parsePreviewBody({ clientId: CLIENT, items: long(10) }).items).toHaveLength(10);
  });

  it.each([
    [{ items: items(1) }, /Select a client/],
    [{ clientId: 'not-a-uuid', items: items(1) }, /Select a client/],
    [{ clientId: CLIENT, items: [] }, /at least one line/],
    [{ clientId: CLIENT, items: items(1), exchangeRate: 0 }, /exchangeRate/],
    [{ clientId: CLIENT, items: items(1), exchangeRate: -2 }, /exchangeRate/],
    [{ clientId: CLIENT, items: items(1), exchangeRate: '18' }, /exchangeRate/],
    [{ clientId: CLIENT, items: items(1), invoiceDate: '6 Nov' }, /invoiceDate/],
    [{ clientId: CLIENT, items: [{ quantity: 1, unitPrice: 1 }] }, /needs a description/],
  ])('refuses %j', (raw, message) => {
    expect(() => parsePreviewBody(raw)).toThrow(message);
  });

  it('does not carry a line\'s job or dimensions; its VAT type, rate, item and account for create\'s VAT and item refusals', () => {
    const parsed = parsePreviewBody({ clientId: CLIENT, items: [{ description: 'x', unitPrice: 1, glAccountId: JOB, projectId: JOB, itemId: JOB, cc2Id: JOB }] });
    expect(parsed.items).toEqual([{ description: 'x', quantity: undefined, unitPrice: 1, discount: undefined,
      vatType: undefined, taxRate: undefined, itemId: JOB, glAccountId: JOB }]);
  });
});

describe('#1701 round 1: the preview prices and refuses as create does', () => {
  const body = (over: Record<string, unknown>) => parsePreviewBody({ clientId: CLIENT, invoiceDate: '2026-11-20', ...over });
  const printed = async (over: Record<string, unknown>) => {
    const p = (await buildInvoicePreviewModel(CO, body(over)))!;
    return { header: { subtotal: p.model.invoice.subtotal, tax: p.model.invoice.tax_amount, total: p.model.invoice.total_amount,
      rate: p.model.invoice.tax_rate, amountsAre: p.model.invoice.amounts_are }, lines: p.model.items.map((i) => [i.vat_type, i.tax_amount]) };
  };

  it('a company not registered for VAT: untyped, no VAT, stored exclusive, whatever the body asks', async () => {
    m.sql.mockResolvedValue([{ ...ROW, vat_period: 'none', vat_system_type: 'none' }]);
    expect(await printed({ amountsAre: 'inclusive', items: [{ description: 'A', quantity: 1, unitPrice: 115 }] })).toEqual({
      header: { subtotal: 115, tax: 0, total: 115, rate: 0, amountsAre: 'exclusive' }, lines: [[null, null]],
    });
    await expect(buildInvoicePreviewModel(CO, body({ items: [{ description: 'A', quantity: 1, unitPrice: 1, vatType: 'standard' }] })))
      .rejects.toThrow(/not registered for VAT/);
  });

  it('the customer\'s default (exempt) types a line with none, as create does', async () => {
    m.sql.mockResolvedValue([{ ...ROW, customer_vat: 'exempt' }]);
    expect((await printed({ items: [{ description: 'A', quantity: 1, unitPrice: 100 }] })).lines).toEqual([['exempt', 0]]);
  });

  it('mixed types, inclusive: the figures create stores (priceInvoiceVat on the same lines)', async () => {
    const items = [{ description: 'S', quantity: 100, unitPrice: 9.99, vatType: 'standard' }, { description: 'Z', quantity: 1, unitPrice: 300, vatType: 'zero_rated' },
      { description: 'E', quantity: 3, unitPrice: 33.33, discount: 12.5, vatType: 'exempt' }];
    const created = priceInvoiceVat(items, { typed: true, types: ['standard', 'zero_rated', 'exempt'] }, '2026-11-20', 'inclusive');
    expect(await printed({ amountsAre: 'inclusive', items })).toEqual({
      header: { subtotal: created.header.subtotal, tax: created.header.tax, total: created.header.total, rate: 15, amountsAre: 'inclusive' },
      lines: created.lines.map((l) => [l.vatType, l.taxAmount]),
    });
  });

  it.each([
    ['1 x R0.03 standard (approve would refuse it)', { items: [{ description: 'T', quantity: 1, unitPrice: 0.03, vatType: 'standard' }] }, /rounds to nothing/],
    ['a date before VAT began', { invoiceDate: '1991-09-29', items: [{ description: 'A', quantity: 1, unitPrice: 1 }] }, /before VAT began/],
    ['a header rate of 14', { taxRate: 14, items: [{ description: 'A', quantity: 1, unitPrice: 1 }] }, /neither the VAT rate/],
  ])('refuses %s, as create does', async (_l, over, msg) => {
    await expect(buildInvoicePreviewModel(CO, body(over))).rejects.toThrow(msg);
  });
});

describe('#1701 round 2: the preview refuses what create refuses', () => {
  const body = (items: Record<string, unknown>[]) => parsePreviewBody({ clientId: CLIENT, invoiceDate: '2026-11-20', items });
  it('a per-line taxRate that is not its type\'s rate', async () => {
    await expect(buildInvoicePreviewModel(CO, body([{ description: 'A', quantity: 1, unitPrice: 1, vatType: 'exempt', taxRate: 15 }])))
      .rejects.toThrow('items[0]: taxRate 15 is not the rate of its VAT type exempt (0% on 2026-11-20). Leave taxRate out: the rate comes from the type.');
  });
  it('an inactive item, and an item not the company\'s', async () => {
    const ITEM = '00000000-0000-4000-8000-0000000000d1';
    m.sql.mockImplementation(async (strings: TemplateStringsArray) => (strings.join('?').includes('FROM items')
      ? [{ id: ITEM, is_active: false, sales_account_id: null, purchases_account_id: null }] : [ROW]));
    await expect(buildInvoicePreviewModel(CO, body([{ description: 'A', quantity: 1, unitPrice: 1, itemId: ITEM }])))
      .rejects.toThrow('items[0].item_id is an inactive item');
    m.sql.mockImplementation(async (strings: TemplateStringsArray) => (strings.join('?').includes('FROM items') ? [] : [ROW]));
    await expect(buildInvoicePreviewModel(CO, body([{ description: 'A', quantity: 1, unitPrice: 1, itemId: ITEM }])))
      .rejects.toThrow('items[0].item_id is not an item of your company');
  });
});
