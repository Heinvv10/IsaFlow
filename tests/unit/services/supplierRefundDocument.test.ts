/**
 * The supplier refund document — the refusal, the sign, and the netting.
 *
 * A refund is cash coming BACK from a supplier: a `supplier_payments` row with
 * `payment_method = 'refund'` and a NEGATIVE `total_amount`, carrying the bank
 * line's journal and no allocations. These tests pin the three things that make
 * it safe rather than merely present:
 *
 *   · it is REFUSED when it exceeds the supplier's on-account credit, because a
 *     refund larger than the credit it returns is not a refund — the supplier
 *     would then owe the company, which is a receivable and not an AP document;
 *   · the document it writes is negative, `refund`, `processed`, unallocated;
 *   · the shared unapplied basis reports it as a NEGATIVE remainder, so the
 *     per-supplier totals every AP report is built on net rather than double-
 *     count. The old `> 0` predicate dropped the row entirely, which made the
 *     credit read as if the cash had never come back.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(
    vi.fn().mockResolvedValue([]),
    { transaction: vi.fn(), unsafe: vi.fn((s: string) => s) },
  );
  return { sql: sqlMock, withTransaction: vi.fn(), withSavepoint: vi.fn() };
});

vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({
  resolveUserUuid: vi.fn().mockResolvedValue('11111111-1111-4111-8111-111111111111'),
}));

import { sql } from '@/lib/neon';
import {
  planSupplierRefund,
  recordSupplierRefund,
  isSupplierRefundRefusal,
} from '@/modules/accounting/services/ap/supplierRefundDocument';
import { getUnappliedPaymentBasis } from '@/modules/accounting/services/shared/unappliedPaymentBasis';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;

const CO = 'cccccccc-0000-4000-8000-cccccccccccc';
const SUP = 'ssssssss-0000-4000-8000-ssssssssssss';
const JE = 'jjjjjjjj-0000-4000-8000-jjjjjjjjjjjj';
const BANK = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';
const TX = 'tttttttt-0000-4000-8000-tttttttttttt';

beforeEach(() => {
  vi.clearAllMocks();
  mockSql.mockResolvedValue([]);
});

describe('planSupplierRefund — the on-account credit ceiling', () => {
  it('allows a refund up to the credit exactly', async () => {
    mockSql.mockResolvedValueOnce([{ credit: '5000.00', supplier_name: 'ACME' }]);
    const plan = await planSupplierRefund(CO, SUP, 5000, '2026-09-19');
    expect(plan.onAccountCredit).toBe(5000);
    expect(plan.amount).toBe(5000);
  });

  it('refuses a refund of one cent more than the credit', async () => {
    mockSql.mockResolvedValueOnce([{ credit: '5000.00', supplier_name: 'ACME' }]);
    await expect(planSupplierRefund(CO, SUP, 5000.01, '2026-09-19')).rejects.toThrow(
      /ACME[\s\S]*owing the company/i,
    );
  });

  it('refuses against a supplier with no on-account credit at all', async () => {
    mockSql.mockResolvedValueOnce([{ credit: '0', supplier_name: 'ACME' }]);
    const err = await planSupplierRefund(CO, SUP, 100, '2026-09-19').catch((e) => e);
    expect(isSupplierRefundRefusal(err)).toBe(true);
  });

  it('reads the credit as at the payment date, and nets earlier refunds', async () => {
    // The query returns one already-netted figure; what is pinned here is that
    // the date is the third bound parameter, so a later payment cannot fund an
    // earlier refund.
    mockSql.mockResolvedValueOnce([{ credit: '1200.00', supplier_name: 'ACME' }]);
    await planSupplierRefund(CO, SUP, 1200, '2026-03-31');
    const params = mockSql.mock.calls[0]!.slice(1);
    expect(params).toContain('2026-03-31');
    expect(params).toContain(SUP);
    expect(params).toContain(CO);
  });

  it('takes an absolute amount — a caller passing a signed one is not silently doubled', async () => {
    mockSql.mockResolvedValueOnce([{ credit: '900.00', supplier_name: 'ACME' }]);
    const plan = await planSupplierRefund(CO, SUP, -900, '2026-09-19');
    expect(plan.amount).toBe(900);
  });
});

describe('recordSupplierRefund — the document it writes', () => {
  it('writes a negative total under payment_method refund, processed, unallocated', async () => {
    mockSql
      .mockResolvedValueOnce([{ credit: '5000.00', supplier_name: 'ACME' }]) // re-check
      .mockResolvedValueOnce([{ id: 'pay-1' }]);
    const doc = await recordSupplierRefund({
      companyId: CO, supplierId: SUP, bankTxId: TX, bankAccountId: BANK,
      journalEntryId: JE, amount: 1500, paymentDate: '2026-09-19',
      description: 'Refund from ACME', userId: 'user-1',
    });
    expect(doc.paymentId).toBe('pay-1');
    expect(doc.amount).toBe(-1500);
    const params = mockSql.mock.calls[1]!.slice(1);
    expect(params).toContain(-1500);
    expect(params).toContain('refund');
    expect(params).toContain('processed');
    expect(params).toContain(TX);
  });

  it('re-checks the ceiling and writes NOTHING when it is exceeded', async () => {
    mockSql.mockResolvedValueOnce([{ credit: '100.00', supplier_name: 'ACME' }]);
    await expect(recordSupplierRefund({
      companyId: CO, supplierId: SUP, bankTxId: TX, bankAccountId: BANK,
      journalEntryId: JE, amount: 1500, paymentDate: '2026-09-19',
      description: 'Refund from ACME', userId: 'user-1',
    })).rejects.toThrow(/cannot be recorded against/i);
    // One call — the read. The INSERT never happened.
    expect(mockSql).toHaveBeenCalledTimes(1);
  });
});

describe('getUnappliedPaymentBasis — a refund is a negative remainder', () => {
  /** rows, totals, allocation watermark — the three statements the basis runs. */
  function basisReturns(rows: unknown[]): void {
    mockSql
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([{
        universe_total: rows.length, rows_total: rows.length,
        total_unapplied: 0, total_unattributed: 0, posted_through: null,
      }])
      .mockResolvedValueOnce([{ posted_through: null }]);
  }

  it('carries a refund through as a negative unappliedAmount, kind refund', async () => {
    basisReturns([{
      id: 'pay-r', document_number: 'SP-9', document_date: '2026-09-19',
      entity_id: SUP, entity_name: 'ACME', attributed: true,
      total_amount: '-160609.85', status: 'processed', reference: TX,
      description: 'Refund from ACME', gl_journal_entry_id: JE,
      created_at: null, allocated_amount: '0', payment_method: 'refund',
    }]);
    const basis = await getUnappliedPaymentBasis(CO, 'ap', '2026-09-19');
    expect(basis.rows).toHaveLength(1);
    expect(basis.rows[0]!.unappliedAmount).toBe(-160609.85);
    expect(basis.rows[0]!.kind).toBe('refund');
  });

  it('does not let a negative total absorb itself through the allocation cap', async () => {
    // The old cap was `min(allocated, totalAmount)`. On a refund that is
    // `min(0, -500) = -500`, so the remainder came out at exactly zero and the
    // row vanished from every total that netted it.
    basisReturns([{
      id: 'pay-r', document_number: '', document_date: '2026-09-19',
      entity_id: SUP, entity_name: 'ACME', attributed: true,
      total_amount: '-500', status: 'processed', reference: null,
      description: null, gl_journal_entry_id: JE,
      created_at: null, allocated_amount: '0', payment_method: 'refund',
    }]);
    const basis = await getUnappliedPaymentBasis(CO, 'ap', '2026-09-19');
    expect(basis.rows[0]!.allocatedAmount).toBe(0);
    expect(basis.rows[0]!.unappliedAmount).toBe(-500);
  });

  it('still reports an ordinary payment as a positive remainder, kind payment', async () => {
    basisReturns([{
      id: 'pay-p', document_number: 'SP-1', document_date: '2026-09-19',
      entity_id: SUP, entity_name: 'ACME', attributed: true,
      total_amount: '1000', status: 'processed', reference: null,
      description: null, gl_journal_entry_id: JE,
      created_at: null, allocated_amount: '250', payment_method: 'eft',
    }]);
    const basis = await getUnappliedPaymentBasis(CO, 'ap', '2026-09-19');
    expect(basis.rows[0]!.unappliedAmount).toBe(750);
    expect(basis.rows[0]!.kind).toBe('payment');
  });

  it('drops a fully applied payment, which is still the zero rule', async () => {
    basisReturns([{
      id: 'pay-p', document_number: 'SP-1', document_date: '2026-09-19',
      entity_id: SUP, entity_name: 'ACME', attributed: true,
      total_amount: '1000', status: 'processed', reference: null,
      description: null, gl_journal_entry_id: JE,
      created_at: null, allocated_amount: '1000', payment_method: 'eft',
    }]);
    const basis = await getUnappliedPaymentBasis(CO, 'ap', '2026-09-19');
    expect(basis.rows).toHaveLength(0);
  });
});
