/**
 * The invoice detail GET and per-line VAT (migration 1008): the header passes `amounts_are` through and says whether
 * the invoice's VAT is per line (`vat_per_line`: every line typed); each line passes `vat_type`, `tax_rate`,
 * `tax_amount`, `amount` and gains `vat_type_effective` — its own type, or for a legacy line 'standard' when its rate
 * (else the header's) is above zero and 'zero_rated' otherwise, which is how zero-VAT invoices have always reported.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const q = vi.hoisted(() => ({ header: [] as unknown[], items: [] as unknown[], texts: [] as string[] }));
// By statement, not position: the header query splices sql fragments (linkExpiredSql) that are sql calls too.
vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(async (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    q.texts.push(text);
    if (/FROM customer_invoice_items cii JOIN customer_invoices ci/.test(text)) return q.items;
    if (/SELECT ci\.id, ci\.invoice_number/.test(text)) return q.header;
    return [];
  }), { unsafe: vi.fn((s: string) => s) });
  return { sql: sqlMock };
});
vi.mock('@/modules/accounting/services/ar/invoicePdfModel', () => ({
  invoiceDigests: vi.fn(async () => ({ shown: 's', draft: 'd' })),
}));

import { getCustomerInvoiceDetail } from '@/modules/accounting/services/ar/customerInvoiceReadService';

const HEADER = { id: 'inv-1', invoice_number: 'INV-1', tax_rate: '15.00', amounts_are: null };
const item = (over: Record<string, unknown>) => ({ id: 'l', description: 'Line', amount: '100.00', tax_rate: '15.00',
  vat_type: null, tax_amount: null, ...over });

async function detail(header: Record<string, unknown>, items: Record<string, unknown>[]) {
  q.header = [header];
  q.items = items;
  return (await getCustomerInvoiceDetail('co', 'inv-1')) as Record<string, unknown> & { items: Record<string, unknown>[] };
}

describe('getCustomerInvoiceDetail and per-line VAT', () => {
  beforeEach(() => { q.header = []; q.items = []; q.texts = []; });

  it('a typed invoice: vat_per_line, amounts_are, and each line\'s own type', async () => {
    const d = await detail({ ...HEADER, amounts_are: 'exclusive' }, [
      item({ vat_type: 'standard', tax_amount: '15.00' }), item({ vat_type: 'exempt', tax_amount: '0.00', tax_rate: '0.00' }),
    ]);
    expect(d.amounts_are).toBe('exclusive');
    expect(q.texts.find((t) => /SELECT ci\.id, ci\.invoice_number/.test(t))).toMatch(/\bci\.amounts_are\b/);
    expect(q.texts.find((t) => /FROM customer_invoice_items cii JOIN/.test(t))).toMatch(/SELECT cii\.\*/);
    expect(d.vat_per_line).toBe(true);
    expect(d.items.map((l) => [l.vat_type, l.vat_type_effective, l.tax_rate, l.tax_amount, l.amount])).toEqual([
      ['standard', 'standard', '15.00', '15.00', '100.00'],
      ['exempt', 'exempt', '0.00', '0.00', '100.00'],
    ]);
  });

  it('a legacy invoice: not per line; a rated line reads standard, an unrated one zero_rated', async () => {
    const d = await detail(HEADER, [item({}), item({ tax_rate: '0.00' })]);
    expect(d.amounts_are).toBeNull();
    expect(d.vat_per_line).toBe(false);
    expect(d.items.map((l) => [l.vat_type, l.vat_type_effective])).toEqual([[null, 'standard'], [null, 'zero_rated']]);
  });

  it('a legacy line with no rate of its own reads the header\'s', async () => {
    expect((await detail({ ...HEADER, tax_rate: '0.00' }, [item({ tax_rate: null })])).items[0]!.vat_type_effective)
      .toBe('zero_rated');
    expect((await detail(HEADER, [item({ tax_rate: null })])).items[0]!.vat_type_effective).toBe('standard');
  });

  it('a partly typed invoice is not per line', async () => {
    expect((await detail(HEADER, [item({ vat_type: 'standard', tax_amount: '15.00' }), item({})])).vat_per_line).toBe(false);
  });

  it('an invoice with no lines is not per line', async () => {
    expect((await detail(HEADER, [])).vat_per_line).toBe(false);
  });
});
