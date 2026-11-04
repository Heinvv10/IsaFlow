/**
 * PR S round fifteen (review M2): the digests are read in TWO statements (the invoice with its customer, job, company
 * and approval digest; its lines), with the company's logo as its md5, not the logo itself. Before: six (header, lines,
 * the company in a savepoint: SAVEPOINT / SELECT / RELEASE, then the approval digest).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/modules/accounting/services/core/pdfShared', () => ({
  getCompanyDetailsFromCompany: vi.fn(async () => ({ name: 'From settings', address: '', phone: '', email: '', vatNumber: '',
    bankName: '', bankAccountName: '', bankAccountNumber: '', bankBranchCode: '', bankReference: '', logoData: null,
    primaryColor: '#0f766e', invoiceLayout: 'classic', quoteLayout: 'classic', statementLayout: 'classic' })),
}));

import { invoiceDigests, loadInvoicePdfModel } from '@/modules/accounting/services/ar/invoicePdfModel';
import { log } from '@/lib/logger';

const HEADER = { invoice_number: 'INV-1', company_found: true, company_name: 'Issuer', company_logo: 'abc', approval_digest: 'd' };
function fakeSql(header: Record<string, unknown> = HEADER) {
  const texts: string[] = [];
  const q = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    texts.push(strings.join('?') + JSON.stringify(values));
    return texts.length === 1 ? [header] : [{ description: 'Line', quantity: '1.00', unit_price: '1.00', amount: '1.00', tax_rate: '15.00' }];
  });
  return { q: q as never, texts };
}

describe('reading the invoice for its digests', () => {
  it('is two statements, the logo as its md5', async () => {
    const { q, texts } = fakeSql();
    const d = await invoiceDigests('co', 'inv', q);
    expect(d?.shown).toMatch(/^[0-9a-f]{64}$/);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toMatch(/CASE WHEN \?::BOOLEAN THEN md5\(co\.logo_data\) ELSE co\.logo_data END/);
    expect(texts[0]).toMatch(/approval_document_digest/);
    expect(texts[0]).toMatch(/\[true,"inv","co"\]$/); // forDigest: the md5 branch
  });

  it('for the PDF, the same two statements read the logo itself', async () => {
    const { q, texts } = fakeSql();
    const model = await loadInvoicePdfModel('co', 'inv', { q });
    expect(model?.company.logoData).toBe('abc');
    expect(texts).toHaveLength(2);
    expect(texts[0]).toMatch(/\[false,"inv","co"\]$/); // the logo itself
  });

  it('no companies row: the company comes from app settings, printed fields only, and it is logged with the invoice', async () => {
    const { q } = fakeSql({ ...HEADER, company_found: false });
    const model = await loadInvoicePdfModel('co', 'inv', { q });
    expect(model?.company.name).toBe('From settings');
    expect(Object.keys(model!.company)).not.toContain('quoteLayout');
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/app settings/), { companyId: 'co', invoiceId: 'inv' }, 'invoicePdfModel');
  });
});
