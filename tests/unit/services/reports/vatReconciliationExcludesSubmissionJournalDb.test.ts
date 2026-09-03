/**
 * getVatReconciliation must ignore the journals vatSubmissionService posts.
 *
 * V-05, the census. This service holds TWO period-bounded aggregations over the
 * VAT control accounts — the monthly GL figures (query 1) and the capital-goods
 * split (query 4) — and neither carried the exclusion that `vatReturnService`
 * and `vatControlMovement` already had. The clearing entry moves the whole
 * period's output and input tax back off the control accounts, so the monthly
 * GL net came out SIGN-INVERTED: on the demo company 2026-02 read
 * −R82,870.39 where the truth is +R42,549.38, i.e. a liability rendered as a
 * refund due from SARS. All six filed periods were inverted.
 *
 * The report's entire job is comparing the GL side against the invoice side and
 * the submitted return, so a contaminated GL side does not just mis-state a
 * number — it manufactures variances against two figures that were correct.
 *
 * This test WRITES, so it refuses to run against production. Every row goes
 * into a transaction that is always rolled back.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { als } from '@/lib/als';
import { isDbReachable } from '../../helpers/dbReachable';
import { assertNotProductionDb } from '../../../helpers/assertNotProductionDb';
import {
  ctxFor, inRolledBackTx, seedVatCompany, seedTradeVat, seedClearingEntry, postEntry,
} from '../../helpers/vatControlFixture';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getVatMultiYearSummary, getVatReconciliation } from '@/modules/accounting/services/reports/vatReconciliationService';

const PERIOD_START = '2026-01-01';
const PERIOD_END = '2026-02-28';

describe('getVatReconciliation — V-05 excludes the VAT submission clearing journal', () => {
  let dbUp = false;
  beforeAll(async () => {
    dbUp = await isDbReachable();
    if (dbUp) assertNotProductionDb('This test inserts companies, GL accounts and journal entries.');
  });

  it('ignores a clearing journal dated inside the reported period', async () => {
    if (!dbUp) return;
    await inRolledBackTx(async (client) => {
      const f = await seedVatCompany(client, 'recon inside');
      await seedTradeVat(client, f, '2026-01-15', '2026-01-20');
      // The pre-date-fix placement: on periodEnd, inside the window.
      await seedClearingEntry(client, f, PERIOD_END);

      const r = await als.run(ctxFor(client, f.companyId), () =>
        getVatReconciliation(f.companyId, PERIOD_START, PERIOD_END),
      );

      // Without the predicate the totals net to zero and February reads
      // −1000 / −300 — the production sign inversion in miniature.
      expect(r.totals.glOutputVat).toBeCloseTo(1000, 2);
      expect(r.totals.glInputVat).toBeCloseTo(300, 2);
      expect(r.totals.glNetVat).toBeCloseTo(700, 2);

      const feb = r.months.find((m) => m.month === '2026-02');
      expect(feb?.glNetVat ?? 0).toBeCloseTo(0, 2);
    });
  });

  it('ignores a clearing journal dated the first day of the reported period', async () => {
    if (!dbUp) return;
    await inRolledBackTx(async (client) => {
      const f = await seedVatCompany(client, 'recon day one');
      await seedTradeVat(client, f, '2026-01-15', '2026-01-20');
      // The post-date-fix placement seen from the FOLLOWING period: the previous
      // period's settlement lands on day 1 of this one. The date change alone
      // relocates the contamination, it does not remove it.
      await seedClearingEntry(client, f, PERIOD_START);

      const r = await als.run(ctxFor(client, f.companyId), () =>
        getVatReconciliation(f.companyId, PERIOD_START, PERIOD_END),
      );

      const jan = r.months.find((m) => m.month === '2026-01');
      expect(jan?.glOutputVat).toBeCloseTo(1000, 2);
      expect(jan?.glInputVat).toBeCloseTo(300, 2);
      expect(jan?.glNetVat).toBeCloseTo(700, 2);
    });
  });

  it('keeps the capital-goods split free of the clearing journal', async () => {
    if (!dbUp) return;
    await inRolledBackTx(async (client) => {
      const f = await seedVatCompany(client, 'recon capital split');
      await seedTradeVat(client, f, '2026-01-15', '2026-01-20');
      // The capital/other split keys off vat_type, and the clearing journal
      // ships vat_type NULL — which both arms of that CASE happen to drop. So
      // this query is excluded only BY LUCK today. Stamping the clearing lines
      // makes the latent exposure real: the split must exclude by SOURCE, so
      // that stamping vat_type on the clearing entry cannot re-open V-05.
      //
      // Dated INSIDE January, the month the trade VAT is in. The month list is
      // built from the monthly GL / invoice / vat_returns queries and never
      // from the split, so a split row for a month none of those three produced
      // is simply never read — dating this on periodEnd would leave the
      // assertion unable to see the contamination at all.
      await seedClearingEntry(client, f, '2026-01-31', { vatType: 'standard' });

      const r = await als.run(ctxFor(client, f.companyId), () =>
        getVatReconciliation(f.companyId, PERIOD_START, PERIOD_END),
      );

      const totalOther = r.months.reduce((s, m) => s + m.otherGoodsOutput, 0);
      const totalOtherIn = r.months.reduce((s, m) => s + m.otherGoodsInput, 0);
      expect(totalOther).toBeCloseTo(1000, 2);
      expect(totalOtherIn).toBeCloseTo(300, 2);
    });
  });

  it('keeps the multi-year summary free of the clearing journal', async () => {
    if (!dbUp) return;
    await inRolledBackTx(async (client) => {
      const f = await seedVatCompany(client, 'recon multi-year');
      await seedTradeVat(client, f, '2026-01-15', '2026-01-20');
      await seedClearingEntry(client, f, PERIOD_END);

      // A SEVENTH copy of the aggregation, found while mutation-testing this
      // file: getVatMultiYearSummary nets the same two control accounts over
      // whole calendar years, and every filed period's settlement lands inside
      // one of them — so each year netted itself away and the trend plotted the
      // settlement schedule rather than the trade.
      const years = await als.run(ctxFor(client, f.companyId), () =>
        getVatMultiYearSummary(f.companyId, 1),
      );

      const y = years.find((x) => x.year === 2026);
      expect(y?.totalOutputVat).toBeCloseTo(1000, 2);
      expect(y?.totalInputVat).toBeCloseTo(300, 2);
      expect(y?.netVat).toBeCloseTo(700, 2);
      // Revenue comes off the same WHERE clause and must not move.
      expect(y?.totalRevenue).toBeCloseTo(6666.67, 2);
    });
  });

  it('still counts auto_vat_adjustment, manual and NULL-source journals', async () => {
    if (!dbUp) return;
    await inRolledBackTx(async (client) => {
      const f = await seedVatCompany(client, 'recon other sources');
      await seedTradeVat(client, f, '2026-01-15', '2026-01-20');
      await seedClearingEntry(client, f, PERIOD_END);

      // 'auto_vat_adjustment' is a SEPARATE value in
      // gl_journal_entries_source_check. Its lines are shaped exactly like the
      // clearing entry's — same accounts, vat_type NULL — so only the source
      // tells them apart. This is the test that fails if anyone ever widens the
      // predicate to something like NOT LIKE 'auto_vat%'.
      await postEntry(client, f.companyId, 'auto_vat_adjustment', '2026-02-10', [
        { accountId: f.vatOutputId, debit: 0, credit: 50, vatType: null },
        { accountId: f.contraId,    debit: 50, credit: 0 },
      ]);
      await postEntry(client, f.companyId, 'manual', '2026-02-11', [
        { accountId: f.vatInputId, debit: 20, credit: 0, vatType: null },
        { accountId: f.contraId,   debit: 0, credit: 20 },
      ]);
      // source is a NULLABLE column — a plain `<>` yields NULL for this row and
      // would silently drop it, which is why the predicate is IS DISTINCT FROM.
      await postEntry(client, f.companyId, null, '2026-02-12', [
        { accountId: f.vatOutputId, debit: 0, credit: 5, vatType: null },
        { accountId: f.contraId,    debit: 5, credit: 0 },
      ]);

      const r = await als.run(ctxFor(client, f.companyId), () =>
        getVatReconciliation(f.companyId, PERIOD_START, PERIOD_END),
      );

      expect(r.totals.glOutputVat).toBeCloseTo(1055, 2);  // 1000 + 50 + 5
      expect(r.totals.glInputVat).toBeCloseTo(320, 2);    // 300 + 20
      expect(r.totals.glNetVat).toBeCloseTo(735, 2);
    });
  });

  it('leaves the revenue side of the same query untouched', async () => {
    if (!dbUp) return;
    await inRolledBackTx(async (client) => {
      const f = await seedVatCompany(client, 'recon revenue');
      await seedTradeVat(client, f, '2026-01-15', '2026-01-20');
      await seedClearingEntry(client, f, PERIOD_END);

      const r = await als.run(ctxFor(client, f.companyId), () =>
        getVatReconciliation(f.companyId, PERIOD_START, PERIOD_END),
      );

      // The predicate sits in the WHERE clause, which also governs the revenue
      // arm of the same query. The clearing journal posts no revenue line, so
      // GL revenue must be unchanged by the fix.
      expect(r.totals.glRevenue).toBeCloseTo(6666.67, 2);
    });
  });
});
