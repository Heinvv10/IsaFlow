/**
 * Bills flagged as settled that are still open. BEGIN … ROLLBACK; DB-gated.
 *
 * `fourWayMatchService#recordPaymentMatch` sets `payment_matched = true` when
 * `amount_paid + allocatedAmount` covers the bill. It never writes
 * `amount_paid` itself — the caller is supposed to have — so when the caller's
 * write does not happen the flag is the only trace that anyone considered the
 * bill paid. On production Velocity Fibre that is **397 bills carrying
 * R16,151,543.00, every one of them `amount_paid = 0.00`, with no
 * `payment_allocations` row and no `supplier_payments` row.** Brightsphere has
 * none: the two companies have different AP defects.
 *
 * WHY IT IS NOT A RECONCILING ITEM, which is the whole design question here.
 * The cash side of those bills IS on the control account — 1,090
 * `auto_supplier_payment` journals move Velocity's AP control by
 * −R61,115,350.09 with no `supplier_payments` row behind any of them — so the
 * money is already counted, once, as `posting_with_no_document`. Emitting a
 * second item for the same money would double-count it and drive the residual
 * to exactly minus this amount. The flag ATTRIBUTES part of an existing item;
 * it does not add one.
 *
 * So it is reported as an advisory, and this test asserts both halves: the
 * bills are named, and the arithmetic does not move.
 */
import { describe, it, expect, vi } from 'vitest';
import { als } from '@/lib/als';
import { isDbReachable } from '../../helpers/dbReachable';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { getPoolForTests, sql } from '@/lib/neon';
import { reconcileSubledger } from '@/modules/accounting/services/reconciliation/subledgerReconciliationService';
import { getSettlementFlagged } from '@/modules/accounting/services/reconciliation/settlementFlagService';

type AlsCtx = Parameters<typeof als.run>[0];

/** `gl_journal_entries.created_by` is uuid-typed, unlike `users.id`. */
const CREATOR = '00000000-0000-4000-8000-000000000001';
const AS_AT = '2026-12-31';

async function inTx(run: (companyId: string) => Promise<void>) {
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    await als.run(
      { client, userId: 'test', companyId: 'bootstrap', claims: {} } as unknown as AlsCtx,
      async () => {
        const rows = (await sql`
          SELECT company_id AS id FROM supplier_invoices
          GROUP BY company_id ORDER BY COUNT(*) DESC LIMIT 1
        `) as Array<{ id: string }>;
        const companyId = rows[0]?.id;
        if (!companyId) throw new Error('no company with supplier invoices in isaflow_dev');
        await run(companyId);
      },
    );
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/**
 * An open bill with nothing applied to it, flagged or not.
 *
 * The UNFLAGGED one is the negative control and it is not decoration: an
 * earlier version of this suite seeded only the flagged bill, and dropping
 * `AND payment_matched = TRUE` from the query left every assertion green. A
 * test that cannot tell the population apart from "every open bill" is not
 * testing the flag.
 */
async function seedBill(
  companyId: string,
  number: string,
  amount: number,
  flagged: boolean,
): Promise<string> {
  const [supplier] = (await sql`
    SELECT id FROM suppliers WHERE company_id = ${companyId}::UUID LIMIT 1
  `) as Array<{ id: string }>;
  if (!supplier) throw new Error('no supplier');
  const [bill] = (await sql`
    INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date,
                                   due_date, subtotal, total_amount, amount_paid, status,
                                   payment_matched, payment_matched_at, created_by)
    VALUES (${companyId}::UUID, ${supplier.id}::UUID, ${number}, '2026-03-01',
            '2026-04-01', ${amount}, ${amount}, 0, 'approved',
            ${flagged}, ${flagged ? '2026-03-15T10:00:00Z' : null}, ${CREATOR}::UUID)
    RETURNING id
  `) as Array<{ id: string }>;
  return bill!.id;
}

describe('bills flagged settled but still open — real database', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('names the flagged bill, with its id and the date it was flagged', async () => {
    await inTx(async (companyId) => {
      const id = await seedBill(companyId, 'ZZ-FLAGGED-1', 1234.56, true);
      const control = await seedBill(companyId, 'ZZ-UNFLAGGED-1', 9999.99, false);
      const flagged = await getSettlementFlagged(companyId, 'ap', AS_AT);

      const row = flagged.rows.find((r) => r.id === id);
      expect(row).toMatchObject({ documentNumber: 'ZZ-FLAGGED-1', amount: 1234.56 });
      expect(row!.flaggedAt).toBe('2026-03-15');
      expect(flagged.total).toBeGreaterThanOrEqual(1234.56);
      // The negative control: an equally open, equally unpaid bill that nobody
      // flagged is NOT in this population, and its R9,999.99 is not in the
      // total. Without this the query could select every open bill and pass.
      expect(flagged.rows.some((r) => r.id === control)).toBe(false);
      expect(flagged.count).toBe(flagged.rows.filter((r) => r.flaggedAt !== null).length);
    });
  }, 30000);

  it.skipIf(!reachable)('does NOT change the difference or the residual', async () => {
    await inTx(async (companyId) => {
      const before = await reconcileSubledger(companyId, 'ap', AS_AT);
      await seedBill(companyId, 'ZZ-FLAGGED-2', 5000, true);
      const after = await reconcileSubledger(companyId, 'ap', AS_AT);

      // The bill is new, so the subledger grows by its balance and the
      // difference grows with it — that part is ordinary. What must NOT happen
      // is the flag contributing a SECOND time: the residual has to stay
      // exactly where it was.
      expect(after.subledgerTotal).toBeCloseTo((before.subledgerTotal ?? 0) + 5000, 2);
      expect(after.unexplainedDifference).toBe(before.unexplainedDifference);
      // The flag is reported, and its amount appears in NO reconciling item's
      // total. Summing the control bridge before and after must differ by the
      // bill's balance once — not once for the document and again for the flag.
      const flaggedIds = after.settlementFlagged.rows.map((r) => r.id);
      expect(flaggedIds.length).toBeGreaterThan(0);
      const bridgeSum = (r: typeof after) =>
        r.reconcilingItems
          .filter((i) => i.bridge === 'subledger_to_control')
          .reduce((s, i) => s + i.amount, 0);
      expect(bridgeSum(after)).toBeCloseTo(bridgeSum(before) + 5000, 2);
      expect(after.settlementFlagged.total).toBeGreaterThanOrEqual(5000);
    });
  }, 30000);

  it.skipIf(!reachable)('reports nothing for AR, which has no such flag', async () => {
    await inTx(async (companyId) => {
      // `payment_matched` exists on `supplier_invoices` only. Answering with an
      // empty list rather than running a query against a column that is not
      // there is the difference between a stated limit and a 42703.
      const flagged = await getSettlementFlagged(companyId, 'ar', AS_AT);
      expect(flagged).toEqual({ rows: [], total: 0, count: 0, truncated: false });
    });
  }, 30000);
});
