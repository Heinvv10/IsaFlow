/**
 * `reconcile_subledger` end-to-end against isaflow_dev. Read-only; DB-gated.
 *
 * The unit suites mock every query, so none of them can tell whether the SQL
 * runs at all — and the unapplied-cash reader is the most intricate SQL in the
 * workstream. This runs the whole reconciliation over real books.
 *
 * It asserts the ARITHMETIC IDENTITY rather than a hardcoded figure. A figure
 * copied from an audit is a check tuned to reproduce that audit's number: it
 * passes when the number is wrong, and it breaks the day someone corrects the
 * books. The identity — control + explained + unexplained = subledger — is true
 * of every correct reconciliation and of no incorrect one.
 */
import { describe, it, expect, vi } from 'vitest';
import { als } from '@/lib/als';
import { isDbReachable } from '../../helpers/dbReachable';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { getPoolForTests, sql } from '@/lib/neon';
import { reconcileSubledger } from '@/modules/accounting/services/reconciliation/subledgerReconciliationService';
import type { SubledgerRole } from '@/modules/accounting/services/gl/controlAccountService';

type AlsCtx = Parameters<typeof als.run>[0];

async function withCompanies(run: (ids: string[]) => Promise<void>) {
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    await als.run(
      { client, userId: 'test', companyId: 'bootstrap', claims: {} } as unknown as AlsCtx,
      async () => {
        const rows = (await sql`
          SELECT DISTINCT company_id AS id FROM customer_invoices ORDER BY 1 LIMIT 5
        `) as Array<{ id: string }>;
        if (rows.length === 0) throw new Error('no company with customer invoices in isaflow_dev');
        await run(rows.map((r) => r.id));
      },
    );
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

describe('reconcile_subledger — real database', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('closes its own arithmetic on real AR and AP books', async () => {
    await withCompanies(async (companyIds) => {
      for (const companyId of companyIds) {
        for (const role of ['ar', 'ap'] as SubledgerRole[]) {
          const rec = await reconcileSubledger(companyId, role, '2026-09-03');

          if (rec.controlAccountBalance === null) {
            // No control account: the reconciliation must refuse, not invent one.
            expect(rec.difference).toBeNull();
            expect(rec.excludedRows.some((e) => e.reason === 'no_control_account')).toBe(true);
            continue;
          }

          // Assert on the NAMED items only. Including the residual would make
          // the identity true by construction — the residual is defined as
          // whatever closes it — and a tautology proves nothing about whether
          // the reconciliation actually explained anything.
          const named = rec.reconcilingItems
            .filter((i) => i.bridge === 'subledger_to_control' && i.type !== 'unexplained_difference')
            .reduce((s, i) => s + i.amount, 0);
          expect(rec.unexplainedDifference).toBeCloseTo(rec.difference! - named, 2);

          // The real claim: on THESE books every AR/AP difference is fully
          // decomposed into named items. A residual here is a reconciling
          // mechanism this endpoint does not yet know about, and it should
          // fail the build rather than be reported as a shrug.
          expect(rec.unexplainedDifference).toBe(0);

          // Every item that claims documents must actually name them.
          for (const item of rec.reconcilingItems) {
            if (item.type === 'unexplained_difference') continue;
            expect(item.documentIds.length).toBeGreaterThan(0);
            expect(item.amount).not.toBe(0);
          }
          // posted_through is a real ledger timestamp or absent — never now().
          if (rec.postedThrough !== null) {
            expect(rec.postedThrough <= new Date().toISOString()).toBe(true);
          }
        }
      }
    });
  }, 30000);

  it.skipIf(!reachable)(
    'closes its arithmetic at a date most documents are AFTER — the double-count case',
    async () => {
      // isaflow_dev holds nothing dated after today, so the case above cannot
      // reach the after-as-at path at all; on PRODUCTION it did, and reported
      // R5,836,396.24 of AR and R1,206,462.27 of AP as `unexplained_difference`
      // because the same future-dated documents were counted by both the
      // unposted-document scan and a separate `document_after_as_at` item.
      //
      // Rolling the reporting date BACK reproduces it on real dev data without
      // seeding: at 2024-06-30 most of these books are still in the future.
      await withCompanies(async (companyIds) => {
        let sawAfterAsAt = false;
        for (const companyId of companyIds) {
          for (const role of ['ar', 'ap'] as SubledgerRole[]) {
            const rec = await reconcileSubledger(companyId, role, '2024-06-30');
            if (rec.controlAccountBalance === null) continue;
            if (rec.reconcilingItems.some((i) => i.type === 'document_after_as_at')) {
              sawAfterAsAt = true;
            }
            expect(rec.unexplainedDifference).toBe(0);
            // No document may be named by two items: that IS the double count.
            const seen = new Set<string>();
            for (const item of rec.reconcilingItems) {
              if (item.bridge !== 'subledger_to_control') continue;
              for (const id of item.documentIds) {
                expect(seen.has(id)).toBe(false);
                seen.add(id);
              }
            }
          }
        }
        // Guard against the case going vacuous if dev data is ever re-dated.
        expect(sawAfterAsAt).toBe(true);
      });
    },
    30000,
  );

  it.skipIf(!reachable)('reports the GL side and a stated reason for a subledger it cannot compare', async () => {
    await withCompanies(async ([companyId]) => {
      for (const role of ['bank', 'vat', 'payroll', 'inventory'] as SubledgerRole[]) {
        const rec = await reconcileSubledger(companyId!, role, '2026-09-03');
        expect(rec.subledgerTotal).toBeNull();
        expect(rec.difference).toBeNull();
        expect(rec.subledgerUnavailable?.reason).toBe('no_subledger_source');
        expect(rec.reconcilingItems).toEqual([]);
      }
    });
  }, 30000);
});
