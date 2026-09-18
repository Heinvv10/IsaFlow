/**
 * POST /api/accounting/credit-notes-action — the approve reply has to say WHERE
 * the money went, not only how much moved.
 *
 * Since the FIFO walk (migration 677) the documents a note settles are not
 * derivable from the note: the link is SKIPPED when that document has posted
 * nothing, and the walk can settle several others. A reply carrying only
 * `appliedAmount` and a status therefore tells the caller that balances
 * changed without saying whose — and the screen that renders it has no second
 * call that would find out. The MCP tools have reported `applied_to_invoice_ids`
 * from the start; this pins the REST route to the same disclosure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/auth', () => ({
  withAuth: (h: unknown) => h,
  withWriteAccess: (h: unknown) => h,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/ar/creditNoteService', () => ({
  approveCreditNote: vi.fn(),
  cancelCreditNote: vi.fn(),
  applyCreditNoteToInvoice: vi.fn(),
}));
vi.mock('@/modules/accounting/services/shared/creditNoteFifo', async () => {
  const actual = await vi.importActual<typeof import('@/modules/accounting/services/shared/creditNoteFifo')>(
    '@/modules/accounting/services/shared/creditNoteFifo',
  );
  return { ...actual, listCreditNoteAllocations: vi.fn() };
});

import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { listCreditNoteAllocations } from '@/modules/accounting/services/shared/creditNoteFifo';
import handler from '../../../pages/api/accounting/credit-notes-action';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const NOTE = '22222222-2222-4222-8222-222222222222';
const BILL_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const BILL_B = 'bbbbbbbb-0000-4000-8000-00000000000b';

function reqRes(body: Record<string, unknown>) {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
    setHeader() { return this; },
  };
  const req = {
    method: 'POST', body, query: {}, headers: {},
    user: { id: '33333333-3333-4333-8333-333333333333' },
    companyId: COMPANY,
  };
  return { req: req as unknown as NextApiRequest, res: res as unknown as NextApiResponse & typeof res };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(approveCreditNote).mockResolvedValue({
    id: NOTE, creditNoteNumber: 'CN-1', type: 'supplier',
    status: 'partially_applied', totalAmount: 1000, appliedAmount: 700,
  } as never);
});

describe('approve reply discloses the documents the note settled', () => {
  it('names every document and what each one took', async () => {
    vi.mocked(listCreditNoteAllocations).mockResolvedValue([
      { invoiceId: BILL_A, amount: 400 },
      { invoiceId: BILL_B, amount: 300 },
    ]);

    const { req, res } = reqRes({ action: 'approve', creditNoteId: NOTE });
    await (handler as unknown as (q: NextApiRequest, s: NextApiResponse) => Promise<void>)(req, res);

    const data = (res.body as { data: Record<string, unknown> }).data;
    expect(data.applied_to_invoice_ids).toEqual([
      { invoice_id: BILL_A, amount: 400 },
      { invoice_id: BILL_B, amount: 300 },
    ]);
    // The amount the note reports and the lines it names must account for each
    // other, or the reply is two answers to one question.
    expect(data.appliedAmount).toBe(700);
  });

  it('reports an empty list when the note applied nothing, never omits the field', async () => {
    // Absent and empty are different answers: absent reads as "this route does
    // not say", which is what the caller could not tell before.
    vi.mocked(listCreditNoteAllocations).mockResolvedValue([]);

    const { req, res } = reqRes({ action: 'approve', creditNoteId: NOTE, autoApply: 'none' });
    await (handler as unknown as (q: NextApiRequest, s: NextApiResponse) => Promise<void>)(req, res);

    const data = (res.body as { data: Record<string, unknown> }).data;
    expect(data).toHaveProperty('applied_to_invoice_ids');
    expect(data.applied_to_invoice_ids).toEqual([]);
  });

  it('reads the lines for the note that was approved', async () => {
    vi.mocked(listCreditNoteAllocations).mockResolvedValue([]);

    const { req, res } = reqRes({ action: 'approve', creditNoteId: NOTE });
    await (handler as unknown as (q: NextApiRequest, s: NextApiResponse) => Promise<void>)(req, res);

    expect(listCreditNoteAllocations).toHaveBeenCalledWith(COMPANY, NOTE);
  });
});
