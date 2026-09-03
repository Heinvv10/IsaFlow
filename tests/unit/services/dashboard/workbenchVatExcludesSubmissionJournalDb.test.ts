/**
 * The workbench "VAT estimate" tile must ignore the VAT submission journals.
 *
 * V-05, the census. `getVatEstimateCurrentPeriod` nets the two control accounts
 * over the OPEN fiscal period containing today, and had no exclusion — so on
 * the demo company the tile read −R42,856.25 for 2026-08 where the truth is
 * +R50,266.28: a payable rendered as a refund on the accountant's landing page.
 *
 * The date change shipped with the first half of V-05 makes this worse here
 * than anywhere else. The clearing journal for period P now lands on day 1 of
 * P+1, so the CURRENT period's tile is polluted by the PREVIOUS period's
 * settlement, every period, permanently — the exact failure mode the earlier
 * fix's own comment named.
 *
 * This test WRITES, so it refuses to run against production. Every row goes
 * into a transaction that is always rolled back.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { isDbReachable } from '../../helpers/dbReachable';
import { assertNotProductionDb } from '../../../helpers/assertNotProductionDb';
import {
  ctxFor, inRolledBackTx, seedVatCompany, seedTradeVat, seedClearingEntry,
  seedFiscalPeriod, postEntry, type VatFixture,
} from '../../helpers/vatControlFixture';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getWorkbenchMetrics } from '@/modules/accounting/services/dashboard/workbenchService';

/**
 * The service selects the open period around Postgres's CURRENT_DATE, so the
 * fixture takes its dates from the server too — a JS-side date would drift
 * against the server's timezone at a month boundary.
 */
async function seedCurrentPeriod(
  client: PoolClient, f: VatFixture,
): Promise<{ today: string }> {
  const { rows } = await client.query<{ today: string; start: string; end: string; yr: number }>(
    `SELECT CURRENT_DATE::TEXT AS today,
            DATE_TRUNC('month', CURRENT_DATE)::DATE::TEXT AS start,
            (DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month - 1 day')::DATE::TEXT AS end,
            EXTRACT(YEAR FROM CURRENT_DATE)::INT AS yr`,
  );
  const p = rows[0]!;
  await seedFiscalPeriod(client, f.companyId, p.start, p.end, 1, p.yr);
  return { today: p.today };
}

describe('workbench VAT estimate — V-05 excludes the VAT submission clearing journal', () => {
  let dbUp = false;
  beforeAll(async () => {
    dbUp = await isDbReachable();
    if (dbUp) assertNotProductionDb('This test inserts companies, fiscal periods and journal entries.');
  });

  it('nets only trade VAT when a clearing journal falls in the current period', async () => {
    if (!dbUp) return;
    await inRolledBackTx(async (client) => {
      const f = await seedVatCompany(client, 'workbench tile');
      const { today } = await seedCurrentPeriod(client, f);
      await seedTradeVat(client, f, today, today);
      // Day 1 of the current period is where the shipped date change puts the
      // PREVIOUS period's settlement; dating it today is the same window.
      await seedClearingEntry(client, f, today);

      const m = await als.run(ctxFor(client, f.companyId), () =>
        getWorkbenchMetrics(f.companyId),
      );

      // Without the predicate the settlement cancels the trade VAT and the tile
      // reads 0 — or, with any real prior-period ledger behind it, negative.
      expect(m.vatEstimateCurrentPeriod).toBeCloseTo(700, 2);
    });
  });

  it('reports a payable as a payable, not a refund', async () => {
    if (!dbUp) return;
    await inRolledBackTx(async (client) => {
      const f = await seedVatCompany(client, 'workbench sign');
      const { today } = await seedCurrentPeriod(client, f);
      // A settlement LARGER than this period's trade VAT — the production shape,
      // where the clearing entry carries the prior period's much bigger totals.
      await postEntry(client, f.companyId, 'auto_invoice', today, [
        { accountId: f.vatOutputId, debit: 0, credit: 400, vatType: 'standard' },
        { accountId: f.contraId,    debit: 400, credit: 0 },
      ]);
      await seedClearingEntry(client, f, today);

      const m = await als.run(ctxFor(client, f.companyId), () =>
        getWorkbenchMetrics(f.companyId),
      );

      // Unfixed this is 400 − 1000 + 300 = −300: a refund due from SARS that the
      // company does not have. The sign is the whole defect.
      expect(m.vatEstimateCurrentPeriod).toBeCloseTo(400, 2);
      expect(m.vatEstimateCurrentPeriod).toBeGreaterThan(0);
    });
  });

  it('still counts auto_vat_adjustment, manual and NULL-source journals', async () => {
    if (!dbUp) return;
    await inRolledBackTx(async (client) => {
      const f = await seedVatCompany(client, 'workbench other sources');
      const { today } = await seedCurrentPeriod(client, f);
      await seedTradeVat(client, f, today, today);
      await seedClearingEntry(client, f, today);

      // Same accounts, same NULL vat_type as the clearing entry — only the
      // source differs. Fails if the predicate is ever widened.
      await postEntry(client, f.companyId, 'auto_vat_adjustment', today, [
        { accountId: f.vatOutputId, debit: 0, credit: 50, vatType: null },
        { accountId: f.contraId,    debit: 50, credit: 0 },
      ]);
      await postEntry(client, f.companyId, 'manual', today, [
        { accountId: f.vatInputId, debit: 20, credit: 0, vatType: null },
        { accountId: f.contraId,   debit: 0, credit: 20 },
      ]);
      // NULLABLE source: a plain `<>` would drop this row entirely.
      await postEntry(client, f.companyId, null, today, [
        { accountId: f.vatOutputId, debit: 0, credit: 5, vatType: null },
        { accountId: f.contraId,    debit: 5, credit: 0 },
      ]);

      // (1000 + 50 + 5) − (300 + 20) = 735
      const m = await als.run(ctxFor(client, f.companyId), () =>
        getWorkbenchMetrics(f.companyId),
      );

      expect(m.vatEstimateCurrentPeriod).toBeCloseTo(735, 2);
    });
  });
});
