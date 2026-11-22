/**
 * The quote routes and per-line VAT (migration 1024): create / edit answer a VAT refusal 400 with its code
 * (INVOICE_LINE_VAT_REFUSED / INVOICE_VAT_NOT_REGISTERED), as the invoice create does; convert answers the invoice's VAT
 * refused as priced the same way; convert-to-order answers an inclusive quote's refusal 400. Every one is raised before
 * the first write (withAuth commits a 4xx).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withSavepoint: vi.fn(async (_n: string, fn: () => unknown) => fn()) }));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn((_r: unknown, data: unknown) => ({ kind: 'success', data })),
    created: vi.fn((_r: unknown, data: unknown) => ({ kind: 'created', data })),
    badRequest: vi.fn((_r: unknown, error: string, details?: unknown) => ({ kind: 'badRequest', error, details })),
    conflict: vi.fn(() => ({ kind: 'conflict' })),
    notFound: vi.fn(() => ({ kind: 'notFound' })),
    methodNotAllowed: vi.fn(() => ({ kind: 'methodNotAllowed' })),
  },
}));
const m = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), convert: vi.fn(), toOrder: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/quoteService', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/ar/quoteService')>()),
  createQuote: m.create, updateQuote: m.update, convertToInvoice: m.convert, convertToSalesOrder: m.toOrder,
}));

import quotesHandler from '../../../../pages/api/accounting/customer-quotes';
import quoteActionHandler from '../../../../pages/api/accounting/customer-quotes-action';
import { InvoiceLineVatRefusal, InvoiceVatNotRegisteredRefusal } from '@/modules/accounting/services/ar/invoiceLineVatTypes';
import { LineValidationError } from '@/modules/accounting/services/ar/quoteLineChecks';

type Out = { kind: string; error?: string; details?: unknown };
const run = (h: unknown, method: string, body: unknown) =>
  (h as (r: NextApiRequest, s: NextApiResponse) => Promise<Out>)(
    { method, body, companyId: 'company-1', user: { id: 'user-1' } } as unknown as NextApiRequest, {} as NextApiResponse);

const VAT = new InvoiceLineVatRefusal('items[0]: "luxury" is not a VAT type; a line is standard, zero_rated or exempt');
const NOT_REG = new InvoiceVatNotRegisteredRefusal('items[0] is standard-rated, but this company is not registered for VAT, so its quotes carry no VAT: leave vatType out.');

beforeEach(() => vi.clearAllMocks());

describe('customer-quotes POST / PUT', () => {
  it.each([[VAT, 'INVOICE_LINE_VAT_REFUSED'], [NOT_REG, 'INVOICE_VAT_NOT_REGISTERED']])('answers %s 400 with its code', async (err, code) => {
    m.create.mockRejectedValueOnce(err);
    expect(await run(quotesHandler, 'POST', { customerName: 'x', lines: [] })).toEqual({ kind: 'badRequest', error: err.message, details: { code } });
    m.update.mockRejectedValueOnce(err);
    expect(await run(quotesHandler, 'PUT', { id: 'q1', customerName: 'x', lines: [] })).toEqual({ kind: 'badRequest', error: err.message, details: { code } });
  });
});

describe('customer-quotes-action', () => {
  it('convert answers a VAT refusal 400 with its code', async () => {
    m.convert.mockRejectedValueOnce(NOT_REG);
    expect(await run(quoteActionHandler, 'POST', { id: 'q1', action: 'convert' }))
      .toEqual({ kind: 'badRequest', error: NOT_REG.message, details: { code: 'INVOICE_VAT_NOT_REGISTERED' } });
  });

  it('convert-to-order answers an inclusive quote\'s refusal 400', async () => {
    const err = new LineValidationError('Quote QUO1\'s prices include VAT, and a sales order holds prices before VAT');
    m.toOrder.mockRejectedValueOnce(err);
    expect(await run(quoteActionHandler, 'POST', { id: 'q1', action: 'convert-to-order' })).toEqual({ kind: 'badRequest', error: err.message, details: undefined });
  });
});
