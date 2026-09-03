/**
 * submitVATReturn must refuse a clearing date that has no fiscal period.
 *
 * P2-11. The V-05 fix moved the clearing entry from periodEnd to periodEnd + 1
 * day. `createJournalEntry` resolves the covering fiscal period and, when it
 * finds none it cannot create, INSERTs `fiscal_period_id = NULL` —
 * `postJournalEntry` guards its closed-period check behind
 * `if (entry.fiscalPeriodId)`, so the entry POSTS and is then invisible to every
 * period-scoped report while still sitting in the ledger. Migration 501 names
 * what that already cost once: Britech's R267,109.70 salary understatement.
 *
 * A VAT settlement is the worst possible journal to lose that way — it is the
 * entry that clears the control accounts, so an invisible one leaves the VAT
 * liability standing on the balance sheet forever with no trace of the filing.
 *
 * The guard refuses ONLY the silent-NULL case: no covering period AND a year
 * outside `fiscalPeriodAutoCreate`'s window. Inside the window the write path
 * creates the year itself and, if it cannot, throws loudly on its own — so the
 * guard must not pre-empt it. The third test is what holds that line.
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
  ctxFor, inRolledBackTx, seedVatCompany, seedTradeVat, seedFiscalPeriod,
  FIXTURE_USER_ID, type VatFixture,
} from '../../helpers/vatControlFixture';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { submitVATReturn } from '@/modules/accounting/services/reports/vatSubmissionService';

async function countWrites(client: PoolClient, f: VatFixture): Promise<{ jes: number; returns: number }> {
  const je = await client.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM gl_journal_entries
      WHERE company_id = $1 AND source = 'auto_vat_submission'`, [f.companyId]);
  const vr = await client.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM vat_returns WHERE company_id = $1`, [f.companyId]);
  return { jes: Number(je.rows[0]!.n), returns: Number(vr.rows[0]!.n) };
}

async function clearingEntry(client: PoolClient, f: VatFixture) {
  const { rows } = await client.query<{ entry_date: string; fiscal_period_id: string | null }>(
    `SELECT entry_date::TEXT AS entry_date, fiscal_period_id, status
       FROM gl_journal_entries
      WHERE company_id = $1 AND source = 'auto_vat_submission'`, [f.companyId]);
  return rows;
}

describe('submitVATReturn — P2-11 refuses a clearing date with no fiscal period', () => {
  let dbUp = false;
  beforeAll(async () => {
    dbUp = await isDbReachable();
    if (dbUp) assertNotProductionDb('This test inserts companies, fiscal periods and journal entries.');
  });

  it('refuses before any write when the clearing year is outside the auto-create window', async () => {
    if (!dbUp) return;
    await inRolledBackTx(async (client) => {
      const f = await seedVatCompany(client, 'submit no period');
      // 2010 is more than AUTO_CREATE_YEARS_BACK behind today, so nothing will
      // create a period for 2011-01-01 and the entry would post with a NULL one.
      await seedTradeVat(client, f, '2010-11-15', '2010-11-20');

      await expect(
        als.run(ctxFor(client, f.companyId), () =>
          submitVATReturn(f.companyId, { periodStart: '2010-11-01', periodEnd: '2010-12-31' }, FIXTURE_USER_ID),
        ),
      ).rejects.toThrow(/fiscal period/i);

      // Refusal BEFORE the write is the whole point: a 4xx after a partial
      // write still COMMITs in this codebase.
      expect(await countWrites(client, f)).toEqual({ jes: 0, returns: 0 });
    });
  });

  it('names the date and the reason', async () => {
    if (!dbUp) return;
    await inRolledBackTx(async (client) => {
      const f = await seedVatCompany(client, 'submit message');
      await seedTradeVat(client, f, '2010-11-15', '2010-11-20');

      await expect(
        als.run(ctxFor(client, f.companyId), () =>
          submitVATReturn(f.companyId, { periodStart: '2010-11-01', periodEnd: '2010-12-31' }, FIXTURE_USER_ID),
        ),
      ).rejects.toThrow(/2011-01-01/);
    });
  });

  it('posts normally when the clearing date already has a fiscal period', async () => {
    if (!dbUp) return;
    await inRolledBackTx(async (client) => {
      const f = await seedVatCompany(client, 'submit has period');
      await seedFiscalPeriod(client, f.companyId, '2026-01-01', '2026-02-28', 1, 2026);
      await seedFiscalPeriod(client, f.companyId, '2026-03-01', '2026-03-31', 2, 2026);
      await seedTradeVat(client, f, '2026-01-15', '2026-01-20');

      await als.run(ctxFor(client, f.companyId), () =>
        submitVATReturn(f.companyId, { periodStart: '2026-01-01', periodEnd: '2026-02-28' }, FIXTURE_USER_ID),
      );

      const rows = await clearingEntry(client, f);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.entry_date).toBe('2026-03-01');
      // The invisible-journal condition itself, asserted directly.
      expect(rows[0]!.fiscal_period_id).not.toBeNull();
    });
  });

  it('does NOT refuse when the year is inside the auto-create window', async () => {
    if (!dbUp) return;
    await inRolledBackTx(async (client) => {
      const f = await seedVatCompany(client, 'submit autocreate');
      // Deliberately NO fiscal periods at all: a brand-new company's shape, and
      // the case ensureFiscalPeriodForDate exists to serve.
      await seedTradeVat(client, f, '2027-05-15', '2027-05-20');

      // No period covers 2027-07-01, but 2027 is inside the window, so the
      // write path creates the year itself. A guard that refused here would
      // break a filing that works today — which is why it checks the window,
      // not just the lookup.
      await als.run(ctxFor(client, f.companyId), () =>
        submitVATReturn(f.companyId, { periodStart: '2027-05-01', periodEnd: '2027-06-30' }, FIXTURE_USER_ID),
      );

      const rows = await clearingEntry(client, f);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.entry_date).toBe('2027-07-01');
      expect(rows[0]!.fiscal_period_id).not.toBeNull();
    });
  });

  it('throws — and writes nothing — when the year exists but has a GAP', async () => {
    if (!dbUp) return;
    await inRolledBackTx(async (client) => {
      const f = await seedVatCompany(client, 'submit gap year');
      // A year that exists but does not cover the clearing date. Not
      // hypothetical: the demo company's fiscal periods jump straight from
      // 2023-12 to 2024-02. createFiscalYear refuses to rebuild an existing
      // year, so ensureFiscalPeriodForDate rethrows instead of returning NULL —
      // this case was already loud, and must stay that way.
      await seedFiscalPeriod(client, f.companyId, '2027-05-01', '2027-06-30', 1, 2027);
      await seedTradeVat(client, f, '2027-05-15', '2027-05-20');

      await expect(
        als.run(ctxFor(client, f.companyId), () =>
          submitVATReturn(f.companyId, { periodStart: '2027-05-01', periodEnd: '2027-06-30' }, FIXTURE_USER_ID),
        ),
      ).rejects.toThrow();

      expect(await countWrites(client, f)).toEqual({ jes: 0, returns: 0 });
    });
  });
});
