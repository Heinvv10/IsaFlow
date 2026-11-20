/**
 * Creating a customer credit note linked to a TYPED invoice with the right VAT, on every surface:
 * - the REST route (credit-notes POST) passes an explicit `taxAmount` through, refuses a malformed one, and answers the
 *   typed-note refusal 400 with CREDIT_NOTE_VAT_SPLIT_REFUSED;
 * - the MCP create_credit_note tool takes `tax_amount`, defaults a typed note's VAT to the required figure (so its replay
 *   and duplicate checks compare the stored total), lets the refusal propagate, and refuses tax_amount with mirror_bill;
 * - creditNoteService.createCreditNote stores the typed figure (the rule itself: creditNoteTypedVat.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const m = vi.hoisted(() => ({ create: vi.fn(), typed: vi.fn(), links: vi.fn(async () => null), dup: vi.fn(async () => null) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', async (orig) => ({ ...(await orig<typeof import('@/lib/api-error-handler')>()), withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    created: vi.fn((_r: unknown, data: unknown) => ({ kind: 'created', data })),
    badRequest: vi.fn((_r: unknown, error: string, details?: unknown) => ({ kind: 'badRequest', error, details })),
    internalError: vi.fn(() => ({ kind: 'internalError' })),
    methodNotAllowed: vi.fn(() => ({ kind: 'methodNotAllowed' })),
    success: vi.fn((_r: unknown, data: unknown) => ({ kind: 'success', data })),
  },
}));
vi.mock('@/modules/accounting/services/ar/creditNoteService', () => ({ createCreditNote: m.create, getCreditNotes: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/creditNoteTypedVat', () => ({ typedCreditNoteVat: m.typed }));
vi.mock('@/modules/accounting/services/ar/creditNoteLinkService', () => ({ validateCreditNoteLinks: m.links, findOpenDuplicateDraft: m.dup }));
vi.mock('@/lib/mcp/tools/externalRef', async (orig) => ({
  ...(await orig<typeof import('@/lib/mcp/tools/externalRef')>()),
  createReplayOrLock: vi.fn(async () => null), stampCreated: vi.fn(async () => undefined),
}));

import routeHandler from '../../../../pages/api/accounting/credit-notes';
import { createCreditNoteTool } from '@/lib/mcp/tools/writeCreditNotesCreate';
import { CreditNoteVatSplitRefusal } from '@/modules/accounting/services/ar/creditNoteTypedSplit';
import type { McpToolContext } from '@/lib/mcp/types';

const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const INV = '44444444-4444-4444-8444-444444444444';
type Out = { kind: string; error?: string; details?: unknown };
const post = (body: unknown) => (routeHandler as unknown as (r: NextApiRequest, s: NextApiResponse) => Promise<Out>)(
  { method: 'POST', body, query: {}, companyId: 'co-1', user: { id: 'user-1' } } as unknown as NextApiRequest, {} as NextApiResponse);
const ctx = { companyId: '11111111-1111-4111-8111-111111111111', userId: 'u1', scopes: ['write:invoices'], tokenJti: 'j' } as unknown as McpToolContext;
const NOTE = { id: 'n1', creditNoteNumber: 'CN-1', type: 'customer', status: 'draft', subtotal: 150, taxRate: 15, taxAmount: 15, totalAmount: 165 };

beforeEach(() => { vi.clearAllMocks(); m.create.mockResolvedValue(NOTE); m.typed.mockResolvedValue(null); });

describe('REST credit-notes POST', () => {
  const base = { type: 'customer', clientId: CUSTOMER, customerInvoiceId: INV, creditDate: '2026-09-20', subtotal: 150 };

  it('passes an explicit taxAmount through; absent stays absent (the service defaults a typed note)', async () => {
    await post({ ...base, taxAmount: 15 });
    expect(m.create.mock.calls[0]![1]).toMatchObject({ subtotal: 150, taxAmount: 15, taxRate: undefined });
    await post(base);
    expect(m.create.mock.calls[1]![1].taxAmount).toBeUndefined();
  });

  it.each([-1, '15', Number.NaN])('refuses taxAmount %s before any write', async (v) => {
    expect(await post({ ...base, taxAmount: v })).toMatchObject({ kind: 'badRequest', error: 'taxAmount must be a number of zero or more' });
    expect(m.create).not.toHaveBeenCalled();
  });

  it('answers the typed-note refusal 400 with its code', async () => {
    m.create.mockRejectedValueOnce(new CreditNoteVatSplitRefusal('… must carry VAT of 15.00 …'));
    expect(await post({ ...base, taxRate: 15 })).toEqual({ kind: 'badRequest', error: '… must carry VAT of 15.00 …', details: { code: 'CREDIT_NOTE_VAT_SPLIT_REFUSED' } });
  });
});

describe('MCP create_credit_note', () => {
  const args = { type: 'customer', client_id: CUSTOMER, customer_invoice_id: INV, credit_date: '2026-09-20', subtotal: 150, idempotency_key: 'k' };

  it('a typed invoice, no VAT given: the required figure is stored and the duplicate check compares its total', async () => {
    m.typed.mockResolvedValueOnce({ taxAmount: 15, taxRate: 15 });
    await createCreditNoteTool.handler(args, ctx);
    expect(m.typed).toHaveBeenCalledWith(ctx.companyId, expect.objectContaining({ customerInvoiceId: INV, subtotal: 150 }));
    expect(m.create.mock.calls[0]![1]).toMatchObject({ taxAmount: 15, taxRate: 15 });
    expect((m.dup.mock.calls[0] as unknown[])[2]).toBe(165);
  });

  it('tax_amount is passed through as the figure', async () => {
    await createCreditNoteTool.handler({ ...args, tax_amount: 15 }, ctx);
    expect(m.create.mock.calls[0]![1]).toMatchObject({ taxAmount: 15 });
    expect((m.dup.mock.calls[0] as unknown[])[2]).toBe(165);
  });

  it.each([[-1, 'tax_amount must be a number of zero or more'], [1.005, 'tax_amount must be in whole cents']])('refuses tax_amount %s', async (v, msg) => {
    const r = await createCreditNoteTool.handler({ ...args, tax_amount: v }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe(msg);
    expect(m.create).not.toHaveBeenCalled();
  });

  it('a tax_rate that misses the required VAT: the registered refusal propagates, nothing created', async () => {
    m.typed.mockRejectedValueOnce(new CreditNoteVatSplitRefusal('… taxRate 15 gives 22.50 …'));
    await expect(createCreditNoteTool.handler({ ...args, tax_rate: 15 }, ctx)).rejects.toBeInstanceOf(CreditNoteVatSplitRefusal);
    expect(m.create).not.toHaveBeenCalled();
  });

  it('refuses tax_amount with mirror_bill', async () => {
    const r = await createCreditNoteTool.handler({ type: 'supplier', supplier_id: CUSTOMER, supplier_invoice_id: INV, credit_date: '2026-09-20',
      subtotal: 100, mirror_bill: true, tax_amount: 15, idempotency_key: 'k' }, ctx);
    expect(r.content[0]!.text).toBe('tax_amount cannot be given with mirror_bill: the bill gives the VAT');
  });

  it('declares tax_amount', () => {
    expect((createCreditNoteTool.inputSchema as { properties: Record<string, unknown> }).properties.tax_amount).toMatchObject({ type: 'number', minimum: 0 });
  });
});
