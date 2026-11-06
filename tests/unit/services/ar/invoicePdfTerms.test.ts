/**
 * The invoice PDF prints the customer's real terms (their own, else the company default), never the constant "30 Days",
 * and "On Receipt" only beside terms that say so. The terms are in the SHOWN digest (what the approver was shown) and not
 * in the DRAFT digest (a customer edited meanwhile must not refuse a draft's autosave).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const shown = vi.hoisted(() => ({ fields: [] as { label: string; value: string }[], rows: [] as Record<string, unknown>[] }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => shown.rows) }));
vi.mock('@/modules/accounting/services/core/pdfShared', async () => {
  const actual = await vi.importActual<typeof import('@/modules/accounting/services/core/pdfShared')>('@/modules/accounting/services/core/pdfShared');
  return {
    ...actual,
    renderRefStrip: (...args: Parameters<typeof actual.renderRefStrip>) => {
      shown.fields = args[4] as { label: string; value: string }[];
      return actual.renderRefStrip(...args);
    },
  };
});

import { generateInvoicePdf } from '@/modules/accounting/services/ar/invoicePdfBuilder';
import {
  draftDigestOfModel, loadInvoicePdfModel, shownDigestOfModel, type InvoicePdfModel,
} from '@/modules/accounting/services/ar/invoicePdfModel';

function model(over: Record<string, unknown>): InvoicePdfModel {
  return {
    company: { name: 'Issuer', address: '1 Road', phone: '', email: '', vatNumber: '', bankName: '', bankAccountName: 'Issuer',
      bankAccountNumber: '', bankBranchCode: '', logoData: null, primaryColor: '#0f766e' },
    invoice: { invoice_number: 'INV-1', invoice_date: '2026-09-01', due_date: '2026-10-01', status: 'approved', payment_terms: null,
      subtotal: '100.00', tax_rate: '15.00', tax_amount: '15.00', total_amount: '115.00', amount_paid: '0', currency_code: 'ZAR',
      exchange_rate: '1', notes: null, billing_period_start: null, billing_period_end: null, project_name: null, client_name: 'Acme',
      client_address: null, client_contact: null, client_email: null, client_phone: null, client_vat: null,
      client_terms: '30 days from invoice date', client_terms_immediate: false, ...over },
    items: [{ description: 'Line', quantity: '1.00', unit_price: '100.00', amount: '100.00', tax_rate: '15.00' }],
  } as unknown as InvoicePdfModel;
}
const printed = (label: string) => shown.fields.find((f) => f.label === label)?.value;

describe('the PDF header strip', () => {
  it('prints the customer\'s terms and the due date', async () => {
    await generateInvoicePdf('co', 'inv', model({ client_terms: '3 months after statement', due_date: '2026-12-31' }));
    expect(printed('Terms')).toBe('3 months after statement');
    expect(printed('Due Date')).toMatch(/2026/);
  });

  it('never prints the old constant "30 Days"', async () => {
    await generateInvoicePdf('co', 'inv', model({ client_terms: '14 days after statement' }));
    expect(printed('Terms')).toBe('14 days after statement');
    expect(JSON.stringify(shown.fields)).not.toContain('30 Days');
  });

  it('"On Receipt" follows the terms VALUE (0 days from invoice), not their wording', async () => {
    await generateInvoicePdf('co', 'inv', model({ due_date: null, client_terms: null, client_terms_immediate: true }));
    expect(printed('Due Date')).toBe('On Receipt');
  });

  it('the words "Immediate" do not make "On Receipt" when the value says otherwise', async () => {
    await generateInvoicePdf('co', 'inv', model({ due_date: null, client_terms: 'Immediate', client_terms_immediate: false }));
    expect(printed('Due Date')).toBe('—');
  });

  it('an undated invoice on other terms prints no date: never "On Receipt" beside a contradicting term', async () => {
    await generateInvoicePdf('co', 'inv', model({ due_date: null, client_terms: null }));
    expect(printed('Due Date')).toBe('—');
    expect(JSON.stringify(shown.fields)).not.toContain('On Receipt');
  });

  it('a model with no terms line prints no Terms field at all: the due date stands alone', async () => {
    await generateInvoicePdf('co', 'inv', model({ client_terms: null }));
    expect(shown.fields.map((f) => f.label)).toEqual(['Invoice #', 'Project', 'Issue Date', 'Due Date']);
    expect(JSON.stringify(shown.fields)).not.toContain('30 Days');
  });
});

describe('the model\'s client_terms', () => {
  const row = (over: Record<string, unknown>) => ({
    invoice_number: 'INV-1', invoice_date: '2026-09-01', due_date: null, status: 'approved', payment_terms: null,
    subtotal: 100, tax_rate: 15, tax_amount: 15, total_amount: 115, amount_paid: 0, currency_code: 'ZAR', exchange_rate: 1,
    notes: null, billing_period_start: null, billing_period_end: null, project_name: null, client_name: 'Acme',
    company_found: true, company_name: 'Issuer', contact_terms_days: null, contact_terms_type: null, company_default_terms: null, ...over,
  });
  beforeEach(() => { shown.rows = []; });

  it.each([
    ['the customer\'s own terms', { contact_terms_days: 45, contact_terms_type: 'invoice_days', due_date: '2026-10-16' }, '45 days from invoice date'],
    ['a legacy days row', { contact_terms_days: 45, contact_terms_type: 'days', due_date: '2026-10-16' }, '45 days from invoice date'],
    ['statement months', { contact_terms_days: 3, contact_terms_type: 'statement_months', due_date: '2026-12-31' }, '3 months after statement'],
    ['none: 30 days from invoice, the company\'s start', { due_date: '2026-10-01' }, '30 days from invoice date'],
    ['none: the company\'s own default', { company_default_terms: '{"days":2,"type":"statement_months"}', due_date: '2026-11-30' }, '2 months after statement'],
    ['own terms beat the company default', { contact_terms_days: 0, contact_terms_type: 'invoice_days', company_default_terms: '{"days":2,"type":"statement_months"}', due_date: '2026-09-01' }, 'Immediate'],
    // The terms line is only printed when these terms dated THIS invoice: otherwise it would contradict the date beside it.
    ['terms changed since: the stored date is not what the terms give', { contact_terms_days: 60, contact_terms_type: 'invoice_days', due_date: '2026-10-01' }, null],
    ['a date someone typed', { contact_terms_days: 3, contact_terms_type: 'statement_months', due_date: '2026-11-11' }, null],
    ['an undated invoice', { contact_terms_days: 45, contact_terms_type: 'invoice_days', due_date: null }, null],
  ])('%s', async (_why, over, words) => {
    shown.rows = [row(over)];
    const m = await loadInvoicePdfModel('co', 'inv');
    expect((m!.invoice as Record<string, unknown>).client_terms).toBe(words);
  });

  it.each([
    [0, 'invoice_days', true], [0, 'statement_days', false], [1, 'invoice_days', false], [null, null, false],
  ])('client_terms_immediate for (%s, %s) is %s: by value, whatever the words', async (days, type, immediate) => {
    shown.rows = [row({ contact_terms_days: days, contact_terms_type: type, due_date: null })];
    const m = await loadInvoicePdfModel('co', 'inv');
    expect((m!.invoice as Record<string, unknown>).client_terms_immediate).toBe(immediate);
  });

  it('is in the shown digest and not in the draft digest', () => {
    const a = model({ client_terms: '30 days from invoice date' });
    const b = model({ client_terms: '60 days from invoice date' });
    expect(shownDigestOfModel(a, 'x')).not.toBe(shownDigestOfModel(b, 'x'));
    expect(draftDigestOfModel(a, 'x')).toBe(draftDigestOfModel(b, 'x'));
  });
});
