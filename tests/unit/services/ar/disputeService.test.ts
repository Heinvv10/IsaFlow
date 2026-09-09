/**
 * Unit tests for disputeService.ts — PRD-06 Phase 3.
 *
 * Verifies:
 *  1. raiseDispute rejects ineligible invoices (cancelled, deleted, draft).
 *  2. raiseDispute rejects disputed_amount <= 0 and > invoice outstanding.
 *  3. raiseDispute inserts a company-scoped row with all metadata.
 *  4. raiseDispute surfaces a clean error when the unique constraint fires
 *     (duplicate OPEN dispute on the same invoice/line).
 *  5. listDisputes filters by status and customer_invoice_id, scoped by company.
 *  6. getDispute returns null for unknown id / cross-tenant id.
 *  7. resolveDispute(resolve_with_credit) calls createCreditNote and persists
 *     credit_note_id + resolution_mode + status='resolved'.
 *  8. resolveDispute(resolve_no_credit) sets status='resolved' without credit.
 *  9. resolveDispute(rejected) sets status='rejected'.
 * 10. resolveDispute refuses to act on an already-closed dispute.
 * 11. withdrawDispute sets status='withdrawn' + resolution_mode='withdrawn'.
 * 12. getOpenDisputeTotals aggregates per-invoice totals for open rows only.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { sql: sqlMock, withTransaction: vi.fn() };
});

vi.mock('@/modules/accounting/services/ar/creditNoteService', () => ({
  createCreditNote: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import {
  getDispute,
  getOpenDisputeTotals,
  listDisputes,
  raiseDispute,
  resolveDispute,
  withdrawDispute,
} from '@/modules/accounting/services/ar/disputeService';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockCreateCreditNote = createCreditNote as unknown as MockedFunction<
  typeof createCreditNote
>;

const COMPANY_ID = '11111111-1111-1111-1111-111111111111';
const INVOICE_ID = '22222222-2222-2222-2222-222222222222';
const DISPUTE_ID = '44444444-4444-4444-4444-444444444444';
const USER_ID = '55555555-5555-5555-5555-555555555555';
const CLIENT_ID = '66666666-6666-6666-6666-666666666666';
const CREDIT_NOTE_ID = '77777777-7777-7777-7777-777777777777';

function eligibleInvoiceRow() {
  return {
    id: INVOICE_ID,
    company_id: COMPANY_ID,
    status: 'sent',
    client_id: CLIENT_ID,
    total_amount: '10000.00',
    amount_paid: '2000.00',
    invoice_number: 'INV-001',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('raiseDispute', () => {
  it('rejects cancelled / deleted / draft invoices', async () => {
    mockSql.mockResolvedValueOnce([]); // invoice lookup — not eligible

    await expect(
      raiseDispute(COMPANY_ID, {
        customerInvoiceId: INVOICE_ID,
        reason: 'bogus',
        disputedAmount: 100,
        raisedBy: `user:${USER_ID}`,
      }),
    ).rejects.toThrow(/not found or not eligible/i);
  });

  it('rejects disputed_amount <= 0', async () => {
    await expect(
      raiseDispute(COMPANY_ID, {
        customerInvoiceId: INVOICE_ID,
        reason: 'bad math',
        disputedAmount: 0,
        raisedBy: `user:${USER_ID}`,
      }),
    ).rejects.toThrow(/disputed amount/i);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('rejects disputed_amount exceeding invoice outstanding', async () => {
    mockSql.mockResolvedValueOnce([eligibleInvoiceRow()]);

    // outstanding = 10000 - 2000 = 8000; asking for 9000 → reject
    await expect(
      raiseDispute(COMPANY_ID, {
        customerInvoiceId: INVOICE_ID,
        reason: 'too much',
        disputedAmount: 9000,
        raisedBy: `user:${USER_ID}`,
      }),
    ).rejects.toThrow(/exceeds outstanding/i);
  });

  it('inserts a whole-invoice dispute scoped by company', async () => {
    mockSql
      .mockResolvedValueOnce([eligibleInvoiceRow()]) // invoice lookup
      .mockResolvedValueOnce([
        {
          id: DISPUTE_ID,
          company_id: COMPANY_ID,
          customer_invoice_id: INVOICE_ID,
          customer_invoice_line_id: null,
          reason: 'Wrong line item',
          raised_by: `customer:abc`,
          raised_at: new Date('2026-04-23T10:00:00Z'),
          status: 'open',
          disputed_amount: '1500.00',
          source_document_id: null,
          resolved_at: null,
          resolved_by: null,
          resolution_note: null,
          resolution_mode: null,
          credit_note_id: null,
          ip_address: '10.0.0.1',
          user_agent: 'Mozilla',
        },
      ]);

    const dispute = await raiseDispute(COMPANY_ID, {
      customerInvoiceId: INVOICE_ID,
      reason: 'Wrong line item',
      disputedAmount: 1500,
      raisedBy: 'customer:abc',
      ipAddress: '10.0.0.1',
      userAgent: 'Mozilla',
    });

    expect(dispute.id).toBe(DISPUTE_ID);
    expect(dispute.status).toBe('open');
    expect(dispute.customerInvoiceLineId).toBeNull();

    const insertArgs = mockSql.mock.calls[1]!.slice(1);
    expect(insertArgs).toContain(COMPANY_ID);
    expect(insertArgs).toContain(INVOICE_ID);
    expect(insertArgs).toContain('customer:abc');
  });

  it('surfaces a clean error on duplicate open dispute (unique violation 23505)', async () => {
    const pgErr = Object.assign(new Error('duplicate key'), { code: '23505' });
    mockSql
      .mockResolvedValueOnce([eligibleInvoiceRow()])
      .mockRejectedValueOnce(pgErr);

    await expect(
      raiseDispute(COMPANY_ID, {
        customerInvoiceId: INVOICE_ID,
        reason: 'already raised',
        disputedAmount: 100,
        raisedBy: `user:${USER_ID}`,
      }),
    ).rejects.toThrow(/already an open dispute/i);
  });
});

describe('listDisputes', () => {
  it('scopes every query by company_id', async () => {
    mockSql.mockResolvedValueOnce([]);       // page
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]); // total count

    await listDisputes(COMPANY_ID, { status: 'open' });

    const args = mockSql.mock.calls[0]!.slice(1);
    expect(args).toContain(COMPANY_ID);
    expect(args).toContain('open');
  });

  it('filters by customer_invoice_id when provided', async () => {
    mockSql.mockResolvedValueOnce([]);       // page
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]); // total count

    await listDisputes(COMPANY_ID, { customerInvoiceId: INVOICE_ID });

    const args = mockSql.mock.calls[0]!.slice(1);
    expect(args).toContain(COMPANY_ID);
    expect(args).toContain(INVOICE_ID);
  });
});

describe('getDispute', () => {
  it('returns null when no row matches (unknown id or cross-tenant)', async () => {
    mockSql.mockResolvedValueOnce([]);

    const dispute = await getDispute(COMPANY_ID, DISPUTE_ID);
    expect(dispute).toBeNull();

    const args = mockSql.mock.calls[0]!.slice(1);
    expect(args).toContain(COMPANY_ID);
    expect(args).toContain(DISPUTE_ID);
  });
});

describe('resolveDispute', () => {
  it('resolve_with_credit creates a credit note and persists credit_note_id', async () => {
    const openDispute = {
      id: DISPUTE_ID,
      company_id: COMPANY_ID,
      customer_invoice_id: INVOICE_ID,
      customer_invoice_line_id: null,
      status: 'open',
      disputed_amount: '1500.00',
    };

    mockSql
      .mockResolvedValueOnce([openDispute]) // fetch current dispute
      .mockResolvedValueOnce([{ client_id: CLIENT_ID }]) // invoice client lookup
      .mockResolvedValueOnce([
        {
          ...openDispute,
          status: 'resolved',
          resolution_mode: 'resolve_with_credit',
          resolved_at: new Date(),
          resolved_by: USER_ID,
          credit_note_id: CREDIT_NOTE_ID,
        },
      ]);

    mockCreateCreditNote.mockResolvedValueOnce({
      id: CREDIT_NOTE_ID,
      creditNoteNumber: 'CN-001',
      type: 'customer',
      status: 'draft',
    } as never);

    const updated = await resolveDispute(COMPANY_ID, DISPUTE_ID, USER_ID, {
      mode: 'resolve_with_credit',
      note: 'agreed',
      creditDate: '2026-04-23',
    });

    expect(mockCreateCreditNote).toHaveBeenCalledOnce();
    const [ccCompany, ccInput, ccUser] = mockCreateCreditNote.mock.calls[0]!;
    expect(ccCompany).toBe(COMPANY_ID);
    expect(ccUser).toBe(USER_ID);
    expect(ccInput).toMatchObject({
      type: 'customer',
      clientId: CLIENT_ID,
      customerInvoiceId: INVOICE_ID,
      subtotal: 1500,
      creditDate: '2026-04-23',
    });

    expect(updated.status).toBe('resolved');
    expect(updated.resolutionMode).toBe('resolve_with_credit');
    expect(updated.creditNoteId).toBe(CREDIT_NOTE_ID);
  });

  it('resolve_no_credit sets status=resolved without creating a credit note', async () => {
    const openDispute = {
      id: DISPUTE_ID,
      company_id: COMPANY_ID,
      customer_invoice_id: INVOICE_ID,
      customer_invoice_line_id: null,
      status: 'open',
      disputed_amount: '1500.00',
    };

    mockSql
      .mockResolvedValueOnce([openDispute])
      .mockResolvedValueOnce([
        {
          ...openDispute,
          status: 'resolved',
          resolution_mode: 'resolve_no_credit',
          resolved_at: new Date(),
          resolved_by: USER_ID,
        },
      ]);

    const updated = await resolveDispute(COMPANY_ID, DISPUTE_ID, USER_ID, {
      mode: 'resolve_no_credit',
      note: 'sorted over the phone',
    });

    expect(mockCreateCreditNote).not.toHaveBeenCalled();
    expect(updated.status).toBe('resolved');
    expect(updated.resolutionMode).toBe('resolve_no_credit');
    expect(updated.creditNoteId).toBeNull();
  });

  it('mode=rejected sets status=rejected', async () => {
    const openDispute = {
      id: DISPUTE_ID,
      company_id: COMPANY_ID,
      customer_invoice_id: INVOICE_ID,
      customer_invoice_line_id: null,
      status: 'open',
      disputed_amount: '1500.00',
    };

    mockSql
      .mockResolvedValueOnce([openDispute])
      .mockResolvedValueOnce([
        {
          ...openDispute,
          status: 'rejected',
          resolution_mode: 'rejected',
          resolved_at: new Date(),
          resolved_by: USER_ID,
        },
      ]);

    const updated = await resolveDispute(COMPANY_ID, DISPUTE_ID, USER_ID, {
      mode: 'rejected',
      note: 'scope creep',
    });

    expect(mockCreateCreditNote).not.toHaveBeenCalled();
    expect(updated.status).toBe('rejected');
    expect(updated.resolutionMode).toBe('rejected');
  });

  it('refuses to act on an already-closed dispute', async () => {
    mockSql.mockResolvedValueOnce([
      { id: DISPUTE_ID, company_id: COMPANY_ID, status: 'resolved' },
    ]);

    await expect(
      resolveDispute(COMPANY_ID, DISPUTE_ID, USER_ID, { mode: 'resolve_no_credit' }),
    ).rejects.toThrow(/not open/i);
  });
});

describe('withdrawDispute', () => {
  it('sets status=withdrawn and resolution_mode=withdrawn', async () => {
    const openDispute = {
      id: DISPUTE_ID,
      company_id: COMPANY_ID,
      customer_invoice_id: INVOICE_ID,
      customer_invoice_line_id: null,
      status: 'open',
      disputed_amount: '1500.00',
    };

    mockSql
      .mockResolvedValueOnce([openDispute])
      .mockResolvedValueOnce([
        {
          ...openDispute,
          status: 'withdrawn',
          resolution_mode: 'withdrawn',
          resolved_at: new Date(),
          resolved_by: USER_ID,
        },
      ]);

    const updated = await withdrawDispute(COMPANY_ID, DISPUTE_ID, USER_ID, 'customer changed mind');

    expect(updated.status).toBe('withdrawn');
    expect(updated.resolutionMode).toBe('withdrawn');
  });
});

describe('getOpenDisputeTotals', () => {
  it('returns an empty map when no invoice ids given', async () => {
    const totals = await getOpenDisputeTotals(COMPANY_ID, []);
    expect(totals.size).toBe(0);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('aggregates per-invoice totals for open rows only, scoped by company', async () => {
    mockSql.mockResolvedValueOnce([
      { customer_invoice_id: INVOICE_ID, total: '2500.00' },
    ]);

    const totals = await getOpenDisputeTotals(COMPANY_ID, [INVOICE_ID]);

    expect(totals.get(INVOICE_ID)).toBe(2500);
    const args = mockSql.mock.calls[0]!.slice(1);
    expect(args).toContain(COMPANY_ID);
  });
});
