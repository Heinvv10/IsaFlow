/**
 * The subledger side of `reconcile_subledger` against the aging reports it
 * claims to explain. Read-only; DB-gated.
 *
 * TWO PROPERTIES, and the endpoint was wrong about both.
 *
 *  1. `agedTotal` must BE what `aged_debtors` / `aged_creditors` report, not a
 *     second opinion about it. It was recomputed from the snapshot, and at
 *     today's date on production it read R63,133,371.78 against the aging
 *     report's R75,864,129.21 — a R12,730,757.43 gap, exactly the invoices with
 *     no due date. Master's #303 fix ages those from `invoice_date` instead of
 *     dropping them, so the aged report DOES carry them and the reconciler's
 *     `unageable_document` item described behaviour that no longer exists.
 *
 *  2. `subledgerTotal` must MOVE with `as_at`. It read the current
 *     `amount_paid` with no document-date cutoff, so it was frozen at today's
 *     figure while `controlAccountBalance` correctly moved: at 2025-12-31
 *     Velocity AR reported today's R75,864,129.21 against a control balance of
 *     −R6,132,241.61 and closed the R81,996,370.82 gap with a
 *     `document_after_as_at` item of R72,867,375.59. The arithmetic added up
 *     and answered a question nobody asked.
 *
 * Both are asserted as IDENTITIES against master's aging, which owns the
 * point-in-time reconstruction (`services/shared/agingRewind.ts`). A hardcoded
 * figure would be a check tuned to reproduce one day's books.
 */
import { describe, it, expect, vi } from 'vitest';
import { als } from '@/lib/als';
import { isDbReachable } from '../../helpers/dbReachable';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { getPoolForTests, sql } from '@/lib/neon';
import { reconcileSubledger } from '@/modules/accounting/services/reconciliation/subledgerReconciliationService';
import { getARAging } from '@/modules/accounting/services/ar/arAgingService';
import { getAPAging } from '@/modules/accounting/services/ap/apAgingService';

type AlsCtx = Parameters<typeof als.run>[0];

/** Dates spanning the books: one current, two historical. */
const DATES = ['2026-09-03', '2026-06-30', '2025-12-31'] as const;

async function withBusyCompanies(run: (ids: string[]) => Promise<void>) {
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    await als.run(
      { client, userId: 'test', companyId: 'bootstrap', claims: {} } as unknown as AlsCtx,
      async () => {
        // The companies with the MOST open documents, not an arbitrary five.
        // `ORDER BY company_id LIMIT 5` picks by uuid, and most companies in
        // dev reconcile zero against zero — a suite that samples those passes
        // without exercising anything.
        const rows = (await sql`
          SELECT company_id AS id, COUNT(*) AS n
          FROM customer_invoices
          WHERE status NOT IN ('draft', 'cancelled')
          GROUP BY company_id
          HAVING COUNT(*) > 20
          ORDER BY COUNT(*) DESC
          LIMIT 3
        `) as Array<{ id: string }>;
        if (rows.length === 0) throw new Error('no company with >20 live customer invoices');
        await run(rows.map((r) => r.id));
      },
    );
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

function agingTotal(buckets: Array<{ total: number }>): number {
  return Math.round(buckets.reduce((s, b) => s + Number(b.total ?? 0), 0) * 100) / 100;
}

describe('the subledger ties to the aging report it explains', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('reports the aging report’s OWN total as agedTotal, at every date', async () => {
    await withBusyCompanies(async (companyIds) => {
      let compared = 0;
      for (const companyId of companyIds) {
        for (const asAt of DATES) {
          const ar = await reconcileSubledger(companyId, 'ar', asAt);
          expect(ar.agedTotal).toBeCloseTo(agingTotal(await getARAging(companyId, asAt)), 2);

          const ap = await reconcileSubledger(companyId, 'ap', asAt);
          expect(ap.agedTotal).toBeCloseTo(agingTotal(await getAPAging(companyId, asAt)), 2);
          compared += 1;
        }
      }
      // Guard against the assertions passing because nothing ran.
      expect(compared).toBeGreaterThanOrEqual(3);
    });
  }, 60000);

  it.skipIf(!reachable)('moves subledgerTotal when the reporting date moves', async () => {
    await withBusyCompanies(async (companyIds) => {
      let sawMovement = false;
      for (const companyId of companyIds) {
        const now = await reconcileSubledger(companyId, 'ar', '2026-09-03');
        const then = await reconcileSubledger(companyId, 'ar', '2025-12-31');
        if (now.subledgerTotal !== then.subledgerTotal) sawMovement = true;
        // A past date can never carry MORE receivable than every document
        // raised since — if it does, the cutoff is not being applied.
        if (now.subledgerTotal !== null && then.subledgerTotal !== null) {
          expect(then.subledgerTotal).toBeLessThanOrEqual(now.subledgerTotal + 0.01);
        }
      }
      // On these books documents were raised between the two dates, so a
      // frozen figure is the defect and this is what catches it.
      expect(sawMovement).toBe(true);
    });
  }, 60000);

  it.skipIf(!reachable)('closes the aged-to-subledger bridge with named items, not a shrug', async () => {
    await withBusyCompanies(async (companyIds) => {
      for (const companyId of companyIds) {
        for (const role of ['ar', 'ap'] as const) {
          const rec = await reconcileSubledger(companyId, role, '2026-09-03');
          if (rec.subledgerTotal === null || rec.agedTotal === null) continue;
          const named = rec.reconcilingItems
            .filter((i) => i.bridge === 'aged_to_subledger' && i.type !== 'aged_unexplained_difference')
            .reduce((s, i) => s + i.amount, 0);
          // subledgerTotal − agedTotal is what this bridge exists to explain.
          expect(named).toBeCloseTo(rec.subledgerTotal - rec.agedTotal, 2);
          expect(rec.reconcilingItems.some((i) => i.type === 'aged_unexplained_difference')).toBe(false);
        }
      }
    });
  }, 60000);
});
