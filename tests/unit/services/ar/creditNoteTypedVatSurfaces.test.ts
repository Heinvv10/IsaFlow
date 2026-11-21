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
vi.mock('@/modules/accounting/services/ar/creditNoteTypedVat', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/ar/creditNoteTypedVat')>()),
  typedCreditNoteVat: m.typed, storedCreditNoteRate: vi.fn(async () => 15),
}));
vi.mock('@/modules/accounting/services/ar/creditNoteLinkService', () => ({ validateCreditNoteLinks: m.links, findOpenDuplicateDraft: m.dup }));
vi.mock('@/lib/mcp/tools/externalRef', async (orig) => ({
  ...(await orig<typeof import('@/lib/mcp/tools/externalRef')>()),
  createReplayOrLock: vi.fn(async () => null), stampCreated: vi.fn(async () => undefined),
}));

import routeHandler from '../../../../pages/api/accounting/credit-notes';
import { createCreditNoteTool } from '@/lib/mcp/tools/writeCreditNotesCreate';
import { createReplayOrLock } from '@/lib/mcp/tools/externalRef';
import { storedCreditNoteRate } from '@/modules/accounting/services/ar/creditNoteTypedVat';
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

  it.each([
    ['a subtotal not in whole cents', { subtotal: 1.234 }, 'subtotal must be in whole cents'],
    ['a taxRate that is not a number', { taxRate: 'abc' }, 'taxRate must be a number from 0 to 100'],
    ['a taxRate above 100', { taxRate: 150 }, 'taxRate must be a number from 0 to 100'],
    ['a taxRate finer than NUMERIC(5,2) stores', { subtotal: 10000, taxRate: 15.005, taxAmount: 1500.5 }, 'taxRate must have at most two decimal places (it is stored to the hundredth)'],
    ['a taxAmount not in whole cents', { taxAmount: 1.005 }, 'taxAmount must be in whole cents'],
    ['a taxAmount above the subtotal', { subtotal: 0.01, taxAmount: 50000 }, 'taxAmount cannot be more than the subtotal'],
  ])('refuses %s, 400 before any write (#1701)', async (_l, over, error) => {
    expect(await post({ ...base, ...over })).toMatchObject({ kind: 'badRequest', error });
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

  it.each([
    [{ subtotal: 0.295 }, 'subtotal must be in whole cents'],
    [{ subtotal: 0.01, tax_amount: 50000 }, 'tax_amount cannot be more than the subtotal'],
  ])('refuses %j before any read or write (#1701)', async (over, msg) => {
    const r = await createCreditNoteTool.handler({ ...args, ...over }, ctx);
    expect(r.content[0]!.text).toBe(msg);
    expect(m.typed).not.toHaveBeenCalled();
    expect(m.create).not.toHaveBeenCalled();
  });

  it('the replay runs BEFORE the typed VAT is read: a replay returns the note and never recomputes it (#1701)', async () => {
    const replayed = { content: [{ type: 'text', text: '{"already_existed":true}' }] };
    vi.mocked(createReplayOrLock).mockResolvedValueOnce(replayed as never);
    const r = await createCreditNoteTool.handler({ ...args, external_system: 'sage', external_ref: 'CRET-1' }, ctx);
    expect(r).toBe(replayed);
    expect(m.typed).not.toHaveBeenCalled();
    expect(m.create).not.toHaveBeenCalled();
    // A note that may be typed and names no figure is compared by date only: its VAT is the invoice's remaining VAT.
    expect(vi.mocked(createReplayOrLock).mock.calls[0]![3]).toEqual({ creditNoteType: 'customer', expect: { date: '2026-09-20', subtotal: 150, totalAmount: null } });
  });

  it('a replay of a note with a figure still compares the total', async () => {
    await createCreditNoteTool.handler({ ...args, tax_amount: 15, external_system: 'sage', external_ref: 'CRET-2' }, ctx);
    expect(vi.mocked(createReplayOrLock).mock.calls[0]![3]).toMatchObject({ expect: { date: '2026-09-20', subtotal: 150, totalAmount: 165 } });
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

describe('#1701 round 2: JSON numbers only, and a figure beside a rate must agree', () => {
  const rest = { type: 'customer', clientId: CUSTOMER, customerInvoiceId: INV, creditDate: '2026-09-20', subtotal: 150 };
  it.each([
    ['subtotal "150"', { subtotal: '150' }, 'subtotal must be a positive amount'],
    ['subtotal true', { subtotal: true }, 'subtotal must be a positive amount'],
    ['taxRate ""', { taxRate: '' }, 'taxRate must be a number from 0 to 100'],
    ['taxRate "15"', { taxRate: '15' }, 'taxRate must be a number from 0 to 100'],
    ['taxRate []', { taxRate: [] }, 'taxRate must be a number from 0 to 100'],
    ['taxRate false', { taxRate: false }, 'taxRate must be a number from 0 to 100'],
    ['taxAmount ""', { taxAmount: '' }, 'taxAmount must be a number of zero or more'],
    ['taxAmount true', { taxAmount: true }, 'taxAmount must be a number of zero or more'],
    ['taxRate 15 beside taxAmount 15.00 on 150 (15% is 22.50)', { taxRate: 15, taxAmount: 15 },
      'taxRate 15 does not give taxAmount 15.00 on 150.00: send one of them, or both agreeing'],
  ])('REST refuses %s, nothing created', async (_l, over, error) => {
    expect(await post({ ...rest, ...over })).toMatchObject({ kind: 'badRequest', error });
    expect(m.create).not.toHaveBeenCalled();
  });
  it('REST takes a figure beside the rate that gives it', async () => {
    expect(await post({ ...rest, taxRate: 15, taxAmount: 22.5 })).toMatchObject({ kind: 'created' });
    expect(m.create.mock.calls[0]![1]).toMatchObject({ taxRate: 15, taxAmount: 22.5 });
  });

  const args = { type: 'customer', client_id: CUSTOMER, customer_invoice_id: INV, credit_date: '2026-09-20', subtotal: 150, idempotency_key: 'k' };
  it.each([
    ['tax_amount ""', { tax_amount: '' }, 'tax_amount must be a number of zero or more'],
    ['tax_amount []', { tax_amount: [] }, 'tax_amount must be a number of zero or more'],
    ['tax_amount false', { tax_amount: false }, 'tax_amount must be a number of zero or more'],
    ['tax_amount true', { tax_amount: true }, 'tax_amount must be a number of zero or more'],
    ['tax_amount "15"', { tax_amount: '15' }, 'tax_amount must be a number of zero or more'],
    ['tax_rate ""', { tax_rate: '' }, 'tax_rate must be a number from 0 to 100'],
    ['tax_rate []', { tax_rate: [] }, 'tax_rate must be a number from 0 to 100'],
    ['tax_rate false', { tax_rate: false }, 'tax_rate must be a number from 0 to 100'],
    ['tax_rate true', { tax_rate: true }, 'tax_rate must be a number from 0 to 100'],
    ['subtotal "150"', { subtotal: '150' }, 'subtotal must be a positive amount'],
    ['subtotal true', { subtotal: true }, 'subtotal must be a positive amount'],
    ['subtotal []', { subtotal: [] }, 'subtotal must be a positive amount'],
  ])('MCP refuses %s, nothing read or created', async (_l, over, msg) => {
    const r = await createCreditNoteTool.handler({ ...args, ...over }, ctx);
    expect([r.isError, r.content[0]!.text]).toEqual([true, msg]);
    expect(m.typed).not.toHaveBeenCalled();
    expect(m.create).not.toHaveBeenCalled();
  });
});

describe('#1701 round 3: one money rule on both surfaces, exact cents, and the rate read only when it is used', () => {
  const rest = { type: 'customer', clientId: CUSTOMER, creditDate: '2026-09-20' };
  const args = { type: 'customer', client_id: CUSTOMER, credit_date: '2026-09-20', idempotency_key: 'k' };
  const mcp = async (over: Record<string, unknown>) => (await createCreditNoteTool.handler({ ...args, ...over }, ctx)).content[0]!.text;

  it.each([
    [{ subtotal: 100, taxRate: 15, taxAmount: 0 }, 'taxRate 15 does not give taxAmount 0.00 on 100.00: send one of them, or both agreeing',
      'tax_rate 15 does not give tax_amount 0.00 on 100.00: send one of them, or both agreeing'],
    [{ subtotal: 33.3, taxRate: 15, taxAmount: 4.99 }, 'taxRate 15 does not give taxAmount 4.99 on 33.30: send one of them, or both agreeing',
      'tax_rate 15 does not give tax_amount 4.99 on 33.30: send one of them, or both agreeing'],
    [{ subtotal: 100, taxRate: 101 }, 'taxRate must be a number from 0 to 100', 'tax_rate must be a number from 0 to 100'],
    [{ subtotal: 100, taxRate: -1 }, 'taxRate must be a number from 0 to 100', 'tax_rate must be a number from 0 to 100'],
    [{ subtotal: -5 }, 'subtotal must be a positive amount', 'subtotal must be a positive amount'],
    [{ subtotal: 1.234 }, 'subtotal must be in whole cents', 'subtotal must be in whole cents'],
    [{ subtotal: 100, taxAmount: -1 }, 'taxAmount must be a number of zero or more', 'tax_amount must be a number of zero or more'],
    [{ subtotal: 100, taxAmount: 1.234 }, 'taxAmount must be in whole cents', 'tax_amount must be in whole cents'],
    [{ subtotal: 1, taxAmount: 2 }, 'taxAmount cannot be more than the subtotal', 'tax_amount cannot be more than the subtotal'],
  ])('REST and MCP refuse %j in the same words (each naming its own fields), nothing read or created', async (money, restMsg, mcpMsg) => {
    expect(await post({ ...rest, ...money })).toMatchObject({ kind: 'badRequest', error: restMsg });
    const { subtotal, taxRate, taxAmount } = money as { subtotal: number; taxRate?: number; taxAmount?: number };
    expect(await mcp({ subtotal, ...(taxRate !== undefined ? { tax_rate: taxRate } : {}), ...(taxAmount !== undefined ? { tax_amount: taxAmount } : {}) }))
      .toBe(mcpMsg);
    expect(m.typed).not.toHaveBeenCalled();
    expect(vi.mocked(storedCreditNoteRate)).not.toHaveBeenCalled();
    expect(m.create).not.toHaveBeenCalled();
  });

  it('MCP takes a figure beside the rate that gives it (33.30 at 15% is 5.00)', async () => {
    await createCreditNoteTool.handler({ ...args, subtotal: 33.3, tax_rate: 15, tax_amount: 5 }, ctx);
    expect(m.create.mock.calls[0]![1]).toMatchObject({ subtotal: 33.3, taxRate: 15, taxAmount: 5 });
  });

  it.each([[33.3, 38.3], [3.3, 3.8], [43.3, 49.8], [100.3, 115.35]])(
    'MCP %s at 15 percent: the replay expectation and the duplicate-draft total are both %s (exact cents, as stored)', async (subtotal, total) => {
      await createCreditNoteTool.handler({ ...args, subtotal, tax_rate: 15, external_system: 'sage', external_ref: `R-${subtotal}` }, ctx);
      expect(vi.mocked(createReplayOrLock).mock.calls[0]![3]).toMatchObject({ expect: { subtotal, totalAmount: total } });
      expect((m.dup.mock.calls[0] as unknown[])[2]).toBe(total);
    });

  it('the stored rate is read only when a total is compared at it (Q5)', async () => {
    const rate = vi.mocked(storedCreditNoteRate);
    await createCreditNoteTool.handler({ ...args, subtotal: 100, tax_rate: 15 }, ctx);
    expect(rate).not.toHaveBeenCalled();
    await createCreditNoteTool.handler({ ...args, subtotal: 100, tax_amount: 15 }, ctx);
    expect(rate).not.toHaveBeenCalled();
    // A typed answer gives the figure: no replay total, and the duplicate total is the figure's.
    m.typed.mockResolvedValueOnce({ taxAmount: 15, taxRate: 15 });
    await createCreditNoteTool.handler({ ...args, customer_invoice_id: INV, subtotal: 150, external_system: 'sage', external_ref: 'Q5-T' }, ctx);
    expect(rate).not.toHaveBeenCalled();
    // A legacy linked invoice (no typed answer): read once, for the duplicate total only.
    await createCreditNoteTool.handler({ ...args, customer_invoice_id: INV, subtotal: 150 }, ctx);
    expect(rate).toHaveBeenCalledTimes(1);
    // Unlinked with no rate and no figure: read once, for both the replay and the duplicate totals.
    rate.mockClear();
    await createCreditNoteTool.handler({ ...args, subtotal: 100, external_system: 'sage', external_ref: 'Q5-U' }, ctx);
    expect(rate).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createReplayOrLock).mock.calls.at(-1)![3]).toMatchObject({ expect: { totalAmount: 115 } });
  });
});
