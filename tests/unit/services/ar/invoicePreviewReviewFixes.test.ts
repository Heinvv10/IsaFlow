/**
 * Master plan wave 4, PR PV, review round 1: what the unsaved preview must refuse or accept as create does.
 *
 * - The totals cap (create's "The invoice total is too large", total or functional total of 1e13 or more) is one pure
 *   function, `draftTotals`, that create and the preview both call.
 * - A body nested too deep for `JSON.stringify` is a PreviewBodyError (a 400), never a RangeError (a 500).
 * - A line description or the notes over 2,000 characters or 20 line breaks is refused (page amplification).
 * - A date that is not on the calendar (2026-02-30) is refused, by the preview and by create, before any write.
 * - A null taxRate is 15, as create takes it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: m.sql, withSavepoint: vi.fn(async (_n: string, fn: () => unknown) => fn()) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({
  assertCustomerInCompany: vi.fn(),
  CustomerNotInCompanyError: class extends Error {},
}));

import {
  createDraftCustomerInvoice, draftTotals, InvoiceLineValidationError,
} from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import {
  parsePreviewBody, PREVIEW_MAX_TOTAL_DESCRIPTION_CHARS, PREVIEW_MAX_TOTAL_LINE_BREAKS, PREVIEW_MAX_TEXT_CHARS, PREVIEW_MAX_TEXT_LINE_BREAKS, PreviewBodyError,
} from '@/modules/accounting/services/ar/invoicePreviewBody';
import { buildInvoicePreviewModel } from '@/modules/accounting/services/ar/invoicePreviewModel';

const CO = '00000000-0000-4000-8000-0000000000c0';
const CLIENT = '00000000-0000-4000-8000-0000000000c1';
const USER = '00000000-0000-4000-8000-0000000000c3';
const ROW = {
  client_name: 'Acme', contact_terms_days: 30, contact_terms_type: 'invoice_days', company_default_terms: null,
  project_name: null, company_found: true, functional_currency: 'ZAR', fx_documents_enabled: true, company_name: 'Issuer',
};
const one = (extra: Record<string, unknown> = {}) => ({ clientId: CLIENT, items: [{ description: 'x', quantity: 1, unitPrice: 10 }], ...extra });
const HUGE_LINES = [{ description: 'a', quantity: 9e7, unitPrice: 9e12 }, { description: 'b', quantity: 9e7, unitPrice: 9e12 }];
const inserts = () => m.sql.mock.calls.filter((c) => String((c[0] as string[]).join('')).includes('INSERT INTO customer_invoices'));

beforeEach(() => { m.sql.mockReset(); m.sql.mockResolvedValue([ROW]); });

describe('draftTotals: the totals cap create and the preview share', () => {
  it('returns invoiceTotals under the cap', () => {
    expect(draftTotals([100, 50], 15, 1)).toEqual({ subtotal: 150, tax: 22.5, total: 172.5 });
  });

  it('refuses a total of 1e13 or more', () => {
    expect(() => draftTotals([1e13], 0, 1)).toThrow(InvoiceLineValidationError);
    expect(() => draftTotals([1e13], 0, 1)).toThrow('The invoice total is too large');
    // A rate under 1 shrinks the functional amount: the document total's own cap still holds.
    expect(() => draftTotals([1e13], 0, 0.5)).toThrow('The invoice total is too large');
    expect(draftTotals([9_999_999_999_999.99], 0, 1).total).toBe(9_999_999_999_999.99);
  });

  it('refuses a functional total of 1e13 or more', () => {
    expect(() => draftTotals([100], 0, 1e12)).toThrow('The invoice total is too large');
    expect(() => draftTotals([1e12], 0, 10)).toThrow('The invoice total is too large');
    expect(draftTotals([1e11], 0, 10).total).toBe(1e11);
  });
});

describe('the preview refuses a total create refuses', () => {
  it('two lines of 9e7 × 9e12', async () => {
    await expect(buildInvoicePreviewModel(CO, parsePreviewBody({ clientId: CLIENT, items: HUGE_LINES })))
      .rejects.toThrow(new InvoiceLineValidationError('The invoice total is too large'));
  });

  it('USD at an exchange rate of 1e300 on a company with foreign currencies (beyond a plain decimal)', async () => {
    expect(() => draftTotals([100], 0, 1e300)).toThrow(new InvoiceLineValidationError('The exchange rate is too large'));
    await expect(buildInvoicePreviewModel(CO, parsePreviewBody(one({ currencyCode: 'USD', exchangeRate: 1e300 }))))
      .rejects.toThrow(new InvoiceLineValidationError('The exchange rate is too large'));
  });

  it('USD at 1e12: the functional total is too large', async () => {
    await expect(buildInvoicePreviewModel(CO, parsePreviewBody(one({ currencyCode: 'USD', exchangeRate: 1e12 }))))
      .rejects.toThrow(new InvoiceLineValidationError('The invoice total is too large'));
  });

  it('create still refuses the same bodies, before any invoice is written', async () => {
    await expect(createDraftCustomerInvoice(CO, USER, { clientId: CLIENT, items: HUGE_LINES }))
      .rejects.toThrow(new InvoiceLineValidationError('The invoice total is too large'));
    await expect(createDraftCustomerInvoice(CO, USER, { ...one(), currencyCode: 'USD', exchangeRate: 1e12 }))
      .rejects.toThrow(new InvoiceLineValidationError('The invoice total is too large'));
    await expect(createDraftCustomerInvoice(CO, USER, { ...one(), currencyCode: 'USD', exchangeRate: 1e300 }))
      .rejects.toThrow(new InvoiceLineValidationError('The exchange rate is too large'));
    expect(inserts()).toHaveLength(0);
  });
});

describe('a body nested too deep to measure', () => {
  it('is a PreviewBodyError, not a RangeError', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 100_000; i++) deep = [deep];
    expect(() => parsePreviewBody({ ...one(), deep })).toThrow(PreviewBodyError);
  });
});

describe('exchange rate and date shapes the columns cannot hold', () => {
  it('draftTotals refuses an exchange rate of 1e12 or more (numeric(18,6)), and takes just under', () => {
    expect(() => draftTotals([0.01], 0, 5e14)).toThrow(InvoiceLineValidationError);
    expect(() => draftTotals([0.01], 0, 1e12)).toThrow('The exchange rate is too large');
    expect(draftTotals([0.01], 0, 999_999_999_999).total).toBe(0.01);
  });

  it('create refuses that rate as a 400 before any insert', async () => {
    const err = await createDraftCustomerInvoice(CO, USER, { ...one(), items: [{ description: 'x', quantity: 1, unitPrice: 0.01 }], currencyCode: 'USD', exchangeRate: 5e14 })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(InvoiceLineValidationError);
    expect(inserts()).toHaveLength(0);
  });

  it.each(['invoiceDate', 'dueDate', 'billingPeriodStart', 'billingPeriodEnd'])('create refuses %s in any shape but a real YYYY-MM-DD', async (field) => {
    for (const bad of ['2026-02-30T00:00', '30/02/2026', '2026-2-3', 'tomorrow', 20260101]) {
      const err = await createDraftCustomerInvoice(CO, USER, { ...one(), [field]: bad }).then(() => null, (e: unknown) => e);
      expect(err, String(bad)).toBeInstanceOf(InvoiceLineValidationError);
    }
    expect(inserts()).toHaveLength(0);
  });
});

describe('the text caps (page amplification)', () => {
  const text = (chars: number, breaks = 0) => `${'\n'.repeat(breaks)}${'x'.repeat(chars - breaks)}`;
  const withDescription = (description: string) => ({ clientId: CLIENT, items: [{ description, quantity: 1, unitPrice: 1 }] });

  it(`takes a description of ${PREVIEW_MAX_TEXT_CHARS} characters and ${PREVIEW_MAX_TEXT_LINE_BREAKS} line breaks`, () => {
    expect(PREVIEW_MAX_TEXT_CHARS).toBe(2000);
    expect(PREVIEW_MAX_TEXT_LINE_BREAKS).toBe(20);
    expect(parsePreviewBody(withDescription(text(2000, 20))).items[0]!.description).toHaveLength(2000);
  });

  it('refuses one character more, or one line break more, naming the line', () => {
    expect(() => parsePreviewBody(withDescription(text(2001)))).toThrow(/Line 1's description is too long to preview/);
    expect(() => parsePreviewBody(withDescription(text(30, 21)))).toThrow(/Line 1's description has too many lines to preview/);
  });

  it('caps the notes the same way', () => {
    expect(parsePreviewBody(one({ notes: text(2000, 20) })).notes).toHaveLength(2000);
    expect(() => parsePreviewBody(one({ notes: text(2001) }))).toThrow(/notes are too long to preview/);
    expect(() => parsePreviewBody(one({ notes: text(30, 21) }))).toThrow(/notes have too many lines to preview/);
  });

  it('counts \\r\\n as one line break', () => {
    expect(parsePreviewBody(withDescription('a\r\n'.repeat(20))).items[0]!.description).toContain('a');
    expect(() => parsePreviewBody(withDescription('a\r\n'.repeat(21)))).toThrow(/too many lines/);
  });
});

describe('the body-wide text caps (amplification across lines)', () => {
  const lines = (n: number, description: string) => Array.from({ length: n }, () => ({ description, quantity: 1, unitPrice: 1 }));
  const body = (items: unknown[], notes?: string) => ({ clientId: CLIENT, items, ...(notes === undefined ? {} : { notes }) });

  it('caps the total line breaks across descriptions and notes at 400', () => {
    expect(PREVIEW_MAX_TOTAL_LINE_BREAKS).toBe(400);
    const twenty = `${'\n'.repeat(20)}x`;
    expect(parsePreviewBody(body(lines(20, twenty))).items).toHaveLength(20); // 400 exactly
    expect(() => parsePreviewBody(body(lines(20, twenty), '\n'))).toThrow(/too many line breaks to preview/);
    expect(() => parsePreviewBody(body([...lines(20, twenty), { description: 'a\r\nb' }]))).toThrow(PreviewBodyError);
    expect(parsePreviewBody(body(lines(19, twenty), twenty)).notes).toHaveLength(21);
  });

  it('caps the total description characters at 20,000', () => {
    expect(PREVIEW_MAX_TOTAL_DESCRIPTION_CHARS).toBe(20000);
    expect(parsePreviewBody(body(lines(10, 'x'.repeat(2000)))).items).toHaveLength(10);
    expect(() => parsePreviewBody(body([...lines(10, 'x'.repeat(2000)), { description: 'y' }]))).toThrow(/descriptions are too long to preview/);
  });
});

describe('billing period dates', () => {
  it.each(['billingPeriodStart', 'billingPeriodEnd'])('the preview refuses a malformed %s as create does, and takes a real one or none', (field) => {
    expect(() => parsePreviewBody(one({ [field]: '2026-02-30' }))).toThrow(new RegExp(`${field} must be a date`));
    expect(() => parsePreviewBody(one({ [field]: '30/02/2026' }))).toThrow(PreviewBodyError);
    expect(parsePreviewBody(one({ [field]: '2026-03-01' })).items).toHaveLength(1);
    expect(parsePreviewBody(one({ [field]: '' })).items).toHaveLength(1);
  });
});

describe('calendar dates', () => {
  it.each(['invoiceDate', 'dueDate'])('the preview refuses %s 2026-02-30 and takes 2028-02-29', (field) => {
    expect(() => parsePreviewBody(one({ [field]: '2026-02-30' }))).toThrow(new RegExp(`${field} must be a date`));
    expect(() => parsePreviewBody(one({ [field]: '2026-13-01' }))).toThrow(PreviewBodyError);
    expect(parsePreviewBody(one({ [field]: '2028-02-29' }))[field as 'invoiceDate']).toBe('2028-02-29');
  });

  it.each(['invoiceDate', 'dueDate', 'billingPeriodStart', 'billingPeriodEnd'])(
    'create refuses %s 2026-02-30 as a 400, before any write', async (field) => {
      m.sql.mockResolvedValue([]);
      const err = await createDraftCustomerInvoice(CO, USER, { ...one(), [field]: '2026-02-30' }).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(InvoiceLineValidationError);
      expect((err as Error).message).toBe(`${field} is not a real date: 2026-02-30`);
      expect(m.sql).not.toHaveBeenCalled();
    });

  it('create lets a real date past the check', async () => {
    m.sql.mockResolvedValue([]);
    const err = await createDraftCustomerInvoice(CO, USER, { ...one(), invoiceDate: '2028-02-29', dueDate: '' })
      .then(() => null, (e: unknown) => e);
    expect(String(err)).not.toMatch(/not a real date/);
  });
});

describe('taxRate null', () => {
  it('is 15, as create takes it', async () => {
    const body = parsePreviewBody(one({ taxRate: null }));
    expect(body.taxRate).toBeUndefined();
    const preview = await buildInvoicePreviewModel(CO, body);
    expect(preview!.model.invoice).toMatchObject({ tax_rate: 15, subtotal: 10, tax_amount: 1.5, total_amount: 11.5 });
  });

  it('still refuses a string', () => {
    expect(() => parsePreviewBody(one({ taxRate: '15' }))).toThrow(/taxRate must be a number/);
  });
});
