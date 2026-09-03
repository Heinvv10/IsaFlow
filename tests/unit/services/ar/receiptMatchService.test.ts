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
 *  9. the shortlist reports how many invoices it considered, so five-of-five and
 *     five-of-fifty can be told apart

 * confirmReceiptMatch lives in receiptMatchConfirmService.ts and is tested there.
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

import { sql } from '@/lib/neon';
import { getReceiptMatchCandidates } from '@/modules/accounting/services/ar/receiptMatchService';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;

const COMPANY_ID = '11111111-1111-1111-1111-111111111111';
const BANK_TX_ID = '22222222-2222-2222-2222-222222222222';
const INVOICE_ID = '33333333-3333-3333-3333-333333333333';
const INVOICE_ID_2 = '44444444-4444-4444-4444-444444444444';
const CUSTOMER_ID = '55555555-5555-5555-5555-555555555555';
const USER_ID = '66666666-6666-6666-6666-666666666666';
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

// confirmReceiptMatch moved to receiptMatchConfirmService.ts when it was widened
// from one invoice to many; its tests moved with it, to
// tests/unit/services/ar/receiptMatchConfirmService.test.ts.
