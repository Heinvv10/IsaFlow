/**
 * Master plan wave 4, PR PV: the unsaved invoice's PDF model. Built from the body the new page's Create sends
 * (createBody), its totals are the page's own (previewTotals over lineTotalForMode) for amounts excluding VAT,
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
import { effectiveTaxRate, lineTotalForMode, type TaxMode } from '@/components/accounting/customer-invoices/taxMode';
import { previewTotals } from '@/modules/accounting/services/ar/invoiceLineAmount';
import { parsePreviewBody, PREVIEW_MAX_BYTES, PREVIEW_MAX_LINES, PreviewBodyError } from '@/modules/accounting/services/ar/invoicePreviewBody';
import { buildInvoicePreviewModel, JOB_NOT_RECOGNISED } from '@/modules/accounting/services/ar/invoicePreviewModel';

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
  const page = previewTotals(lines.map((l) => lineTotalForMode(mode, rate, l)), rate);
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
    ['inclusive', [line('1', 3, 10)]], // 3 × R10 incl.: R8.70 a unit stored, R26.10 + R3.92 = R30.02
    ['inclusive', [line('1', 7, 33.33, 5), line('2', 2, 0.07)]],
    ['none', [line('1', 3, 10), line('2', 2, 49.995)]],
  ])('%s', async (mode, lines) => {
    const { page, printed } = await both(mode, lines);
    expect(printed).toEqual(page);
  });

  it('pins the inclusive 3 × R10 case to the cent', async () => {
    const { printed, preview } = await both('inclusive', [line('1', 3, 10)]);
    expect(printed).toEqual({ subtotal: 26.1, tax: 3.92, total: 30.02 });
    expect(preview.model.items).toEqual([{ description: 'Line 1', quantity: 3, unit_price: 8.7, amount: 26.1, tax_rate: 15 }]);
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
    expect(parsePreviewBody({ clientId: CLIENT, items: long(30) }).items).toHaveLength(30);
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

  it('does not carry a line\'s coding (never looked up, never printed)', () => {
    const parsed = parsePreviewBody({ clientId: CLIENT, items: [{ description: 'x', unitPrice: 1, glAccountId: JOB, projectId: JOB, itemId: JOB }] });
    expect(parsed.items).toEqual([{ description: 'x', quantity: undefined, unitPrice: 1, discount: undefined }]);
  });
});
