/**
 * Unit tests for receiptMatchService.ts — PRD-06 Phase 4.
 *
 * Covers:
 *  1. non-receipt (negative amount) returns []
 *  2. unknown bankTxId returns []
 *  3. exact invoice_number reference wins over partial & over amount-only
 *  4. trigram similarity ≥ 0.4 counts as partial hit (+20)
 *  5. portal-view boost (+10) stacks on top of other signals
 *  6. top-5 cap + descending score ordering
 *  7. description scoring still runs as a tiebreaker
 *  8. entity-name narrowing filters candidates when extracted name matches
 *  9. confirmReceiptMatch rejects amount > outstanding balance
 * 10. confirmReceiptMatch rejects invoice with no customer link
 * 11. confirmReceiptMatch posts journal + inserts allocation + updates invoice
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  // withTransaction: use the same sqlMock for tx so tests can queue
  // results for both outer and inner queries via a single mock chain.
  return {
    sql: sqlMock,
    withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(sqlMock)),
  };
});

vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({
  allocateTransaction: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import {
  getReceiptMatchCandidates,
  confirmReceiptMatch,
} from '@/modules/accounting/services/ar/receiptMatchService';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockAllocate = allocateTransaction as unknown as MockedFunction<typeof allocateTransaction>;

const COMPANY_ID = '11111111-1111-1111-1111-111111111111';
const BANK_TX_ID = '22222222-2222-2222-2222-222222222222';
const INVOICE_ID = '33333333-3333-3333-3333-333333333333';
const INVOICE_ID_2 = '44444444-4444-4444-4444-444444444444';
const CUSTOMER_ID = '55555555-5555-5555-5555-555555555555';
const USER_ID = '66666666-6666-6666-6666-666666666666';
const JE_ID = '77777777-7777-7777-7777-777777777777';
const PAYMENT_ID = '88888888-8888-8888-8888-888888888888';

function bankTxRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BANK_TX_ID,
    amount: '2300.00',
    transaction_date: '2026-04-15',
    description: 'EFT REC Acme Corp INV-001',
    reference: 'INV-001',
    ...overrides,
  };
}

function invoiceCandidate(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    invoice_number: 'INV-001',
    customer_name: 'Acme Corp',
    total_amount: '2300.00',
    amount_paid: '0',
    invoice_date: '2026-04-14',
    trigram_similarity: 1.0,
    viewed_within_30d: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getReceiptMatchCandidates — guards', () => {
  it('returns [] for negative-amount tx (payment, not receipt)', async () => {
    mockSql.mockResolvedValueOnce([bankTxRow({ amount: '-500.00' })]);
    const result = await getReceiptMatchCandidates(BANK_TX_ID, COMPANY_ID);
    expect(result.candidates).toEqual([]);
  });

  it('returns [] for unknown bank tx', async () => {
    mockSql.mockResolvedValueOnce([]);
    const result = await getReceiptMatchCandidates(BANK_TX_ID, COMPANY_ID);
    expect(result.candidates).toEqual([]);
  });
});

describe('getReceiptMatchCandidates — scoring', () => {
  it('exact reference + exact amount + portal view scores highest', async () => {
    mockSql
      .mockResolvedValueOnce([bankTxRow()])
      .mockResolvedValueOnce([invoiceCandidate()]);

    const { candidates } = await getReceiptMatchCandidates(BANK_TX_ID, COMPANY_ID);

    expect(candidates).toHaveLength(1);
    const c = candidates[0]!;
    expect(c.signals?.paymentReferenceExact).toBe(true);
    expect(c.signals?.paymentReferencePartial).toBe(false);
    expect(c.signals?.portalViewBoost).toBeCloseTo(0.1, 5);
    expect(c.signals?.scoreBreakdown.reference).toBe(40);
    expect(c.signals?.scoreBreakdown.portalView).toBe(10);
    expect(c.signals?.scoreBreakdown.amount).toBe(50);
    expect(c.signals?.scoreBreakdown.date).toBeGreaterThanOrEqual(28);
    expect(c.score).toBeGreaterThanOrEqual(40 + 10 + 50 + 28);
    expect(c.matchReason).toContain('Exact INV reference');
  });

  it('exact ref beats partial ref, which beats no-ref', async () => {
    // All three candidates share the same customer name so the entity-name
    // filter (extracted from "Acme Corp") doesn't narrow the pool.
    mockSql
      .mockResolvedValueOnce([bankTxRow()])
      .mockResolvedValueOnce([
        invoiceCandidate({
          id: INVOICE_ID,
          invoice_number: 'INV-001',
          trigram_similarity: 1.0,
          viewed_within_30d: false,
        }),
        invoiceCandidate({
          id: INVOICE_ID_2,
          invoice_number: 'INV-999',
          trigram_similarity: 0.55,
          viewed_within_30d: false,
        }),
        invoiceCandidate({
          id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          invoice_number: 'XYZ-500',
          trigram_similarity: 0.1,
          viewed_within_30d: false,
        }),
      ]);

    const { candidates } = await getReceiptMatchCandidates(BANK_TX_ID, COMPANY_ID);

    expect(candidates).toHaveLength(3);
    expect(candidates[0]!.id).toBe(INVOICE_ID);
    expect(candidates[0]!.signals?.paymentReferenceExact).toBe(true);
    expect(candidates[1]!.id).toBe(INVOICE_ID_2);
    expect(candidates[1]!.signals?.paymentReferencePartial).toBe(true);
    expect(candidates[2]!.signals?.paymentReferenceExact).toBe(false);
    expect(candidates[2]!.signals?.paymentReferencePartial).toBe(false);
    expect(candidates[0]!.score).toBeGreaterThan(candidates[1]!.score);
    expect(candidates[1]!.score).toBeGreaterThan(candidates[2]!.score);
  });

  it('trigram below 0.4 is not a partial hit', async () => {
    mockSql
      .mockResolvedValueOnce([bankTxRow({ description: 'random deposit', reference: '' })])
      .mockResolvedValueOnce([
        invoiceCandidate({ trigram_similarity: 0.39, viewed_within_30d: false }),
      ]);
    const { candidates } = await getReceiptMatchCandidates(BANK_TX_ID, COMPANY_ID);
    expect(candidates[0]!.signals?.paymentReferencePartial).toBe(false);
    expect(candidates[0]!.signals?.scoreBreakdown.reference).toBe(0);
  });

  it('portal-view boost adds +10 when and only when viewed within 30d', async () => {
    mockSql
      .mockResolvedValueOnce([bankTxRow({ description: 'random deposit', reference: '' })])
      .mockResolvedValueOnce([
        invoiceCandidate({ trigram_similarity: 0.1, viewed_within_30d: true }),
        invoiceCandidate({
          id: INVOICE_ID_2,
          trigram_similarity: 0.1,
          viewed_within_30d: false,
        }),
      ]);
    const { candidates } = await getReceiptMatchCandidates(BANK_TX_ID, COMPANY_ID);
    const viewed = candidates.find((c) => c.id === INVOICE_ID)!;
    const notViewed = candidates.find((c) => c.id === INVOICE_ID_2)!;
    expect(viewed.signals?.scoreBreakdown.portalView).toBe(10);
    expect(notViewed.signals?.scoreBreakdown.portalView).toBe(0);
    expect(viewed.score).toBe(notViewed.score + 10);
  });

  it('caps output at top-5 and sorts descending by score', async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      invoiceCandidate({
        id: `0000000${i}-0000-0000-0000-000000000000`,
        invoice_number: `INV-${String(i).padStart(3, '0')}`,
        trigram_similarity: 0.1,
        viewed_within_30d: false,
        total_amount: String(2300 - i * 100),
      }),
    );
    mockSql
      .mockResolvedValueOnce([bankTxRow({ description: 'random deposit', reference: '' })])
      .mockResolvedValueOnce(rows);

    const { candidates } = await getReceiptMatchCandidates(BANK_TX_ID, COMPANY_ID);
    expect(candidates).toHaveLength(5);
    for (let i = 1; i < candidates.length; i++) {
      expect(candidates[i]!.score).toBeLessThanOrEqual(candidates[i - 1]!.score);
    }
  });

  it('entity-name filter narrows the pool when a matching name is found', async () => {
    mockSql
      .mockResolvedValueOnce([bankTxRow({ description: 'EFT REC Acme Corp', reference: '' })])
      .mockResolvedValueOnce([
        invoiceCandidate({
          id: INVOICE_ID,
          customer_name: 'Acme Corp',
          trigram_similarity: 0.1,
          viewed_within_30d: false,
        }),
        invoiceCandidate({
          id: INVOICE_ID_2,
          customer_name: 'Zed Ltd',
          trigram_similarity: 0.1,
          viewed_within_30d: false,
        }),
      ]);

    const { candidates } = await getReceiptMatchCandidates(BANK_TX_ID, COMPANY_ID);
    expect(candidates.every((c) => c.label.startsWith('Acme'))).toBe(true);
  });
});

describe('confirmReceiptMatch', () => {
  it('rejects non-positive amount', async () => {
    await expect(
      confirmReceiptMatch(COMPANY_ID, {
        bankTxId: BANK_TX_ID,
        customerInvoiceId: INVOICE_ID,
        amount: 0,
        userId: USER_ID,
      }),
    ).rejects.toThrow(/positive/i);
  });

  it('rejects unknown invoice', async () => {
    mockSql.mockResolvedValueOnce([]);
    await expect(
      confirmReceiptMatch(COMPANY_ID, {
        bankTxId: BANK_TX_ID,
        customerInvoiceId: INVOICE_ID,
        amount: 100,
        userId: USER_ID,
      }),
    ).rejects.toThrow(/not found/i);
  });

  it('rejects invoice with no customer link', async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: INVOICE_ID,
        invoice_number: 'INV-001',
        total_amount: '1000',
        amount_paid: '0',
        status: 'sent',
        customer_id: null,
      },
    ]);
    await expect(
      confirmReceiptMatch(COMPANY_ID, {
        bankTxId: BANK_TX_ID,
        customerInvoiceId: INVOICE_ID,
        amount: 100,
        userId: USER_ID,
      }),
    ).rejects.toThrow(/customer link/i);
  });

  it('rejects amount greater than outstanding balance', async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: INVOICE_ID,
        invoice_number: 'INV-001',
        total_amount: '1000',
        amount_paid: '800',
        status: 'partially_paid',
        customer_id: CUSTOMER_ID,
      },
    ]);
    await expect(
      confirmReceiptMatch(COMPANY_ID, {
        bankTxId: BANK_TX_ID,
        customerInvoiceId: INVOICE_ID,
        amount: 500,
        userId: USER_ID,
      }),
    ).rejects.toThrow(/exceeds outstanding/i);
  });

  it('allocates + inserts payment-allocation + updates invoice', async () => {
    mockSql
      // 1. invoice lookup (outer)
      .mockResolvedValueOnce([
        {
          id: INVOICE_ID,
          invoice_number: 'INV-001',
          total_amount: '1000',
          amount_paid: '0',
          status: 'sent',
          customer_id: CUSTOMER_ID,
        },
      ])
      // 2. customer_payments lookup by JE (outer)
      .mockResolvedValueOnce([{ id: PAYMENT_ID }])
      // 3. INSERT customer_payment_allocations (inside tx)
      .mockResolvedValueOnce([])
      // 4. UPDATE customer_invoices (inside tx)
      .mockResolvedValueOnce([])
      // 5. SELECT after update (inside tx)
      .mockResolvedValueOnce([
        { status: 'paid', total_amount: '1000', amount_paid: '1000' },
      ]);

    mockAllocate.mockResolvedValue({ journalEntryId: JE_ID } as never);

    const result = await confirmReceiptMatch(COMPANY_ID, {
      bankTxId: BANK_TX_ID,
      customerInvoiceId: INVOICE_ID,
      amount: 1000,
      userId: USER_ID,
    });

    expect(mockAllocate).toHaveBeenCalledTimes(1);
    const call = mockAllocate.mock.calls[0]!;
    expect(call[0]).toBe(COMPANY_ID);
    expect(call[1]).toBe(BANK_TX_ID);
    expect(call[2]).toBe(null);
    expect(call[3]).toBe(USER_ID);
    expect(call[5]).toBe('customer');
    expect(call[6]).toBe(CUSTOMER_ID);
    expect(call[11]).toBe(INVOICE_ID);

    expect(result.journalEntryId).toBe(JE_ID);
    expect(result.customerPaymentId).toBe(PAYMENT_ID);
    expect(result.invoiceStatus).toBe('paid');
    expect(result.amountApplied).toBe(1000);
    expect(result.newBalance).toBe(0);
  });
});
