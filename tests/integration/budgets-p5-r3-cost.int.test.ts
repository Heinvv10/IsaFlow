/**
 * Budgets P5-6 r3 (blind M3): the cost of migration 955's slice rule on a large grid save. A holder of
 * 84 CC1 slices saves 5 000 cells inside them (insert, update, delete), through the real route; the
 * statement-level check (transition tables, one check per account and slice per statement) must keep
 * each save within a generous bound. The timings are printed (stderr) for the record.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips outside the CI gate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import saveRoute from '../../pages/api/accounting/budget-grid/save';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { IN_INTEGRATION_GATE } from '../helpers/integrationGate';
import { budgetHoldersFixture, type GridWorld } from './helpers/budgetHoldersFixture';
import type { SetupUser } from './helpers/onboardingSetupFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetHoldersFixture(pool, saveRoute);
let w: GridWorld;
let holder: SetupUser;
const CELLS = 5000;
/** The bound: measured ~1-2 s per save on velo-server at load ~10-20 (see the PR); 15 s catches a regression, not noise. */
const BOUND_MS = 15_000;

beforeAll(async () => {
  w = await fx.world();
  holder = await fx.member(w.u.homeCompanyId, 'manager');
}, 120_000);
afterAll(async () => {
  try {
    await pool.query(`DELETE FROM budget_slice_reviews WHERE company_id = $1`, [w.u.homeCompanyId]);
    await pool.query(`DELETE FROM budget_holders WHERE company_id = $1`, [w.u.homeCompanyId]);
    await pool.query(`DELETE FROM budget_month_amounts WHERE company_id = $1`, [w.u.homeCompanyId]);
    await pool.query(`DELETE FROM cost_centres WHERE company_id = $1 AND code LIKE 'PK%'`, [w.u.homeCompanyId]);
    await pool.query(`DELETE FROM gl_accounts WHERE company_id = $1 AND account_code LIKE 'PK-%'`, [w.u.homeCompanyId]);
    await fx.cleanup();
  } finally { await pool.end(); }
}, 120_000);

describe('the slice rule on a large save', () => {
  // ci-integration-skip: the wall-clock bound is not asserted inside the CI gate (six shards on a shared box time the machine); the correctness checks run there, the bound when run by hand.
  it(`a holder saves ${CELLS} cells of their slices (insert, update, delete), each within ${BOUND_MS} ms`, async () => {
    const members = (await pool.query(
      `INSERT INTO cost_centres (company_id, code, name, cc_type, is_active)
       SELECT $1, 'PK' || lpad(g::text, 3, '0'), 'PK ' || g, 'cc1', true FROM generate_series(1, 84) g RETURNING id`, [w.u.homeCompanyId])).rows.map((r) => String(r.id));
    const v = await fx.version(w);
    for (const m of members) await fx.hold(w, v, holder.userId, { cc1: m });
    const extra = (await pool.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, is_active)
       SELECT $1, 'PK-' || g, 'Cost ' || g, 'expense', 'debit', 3, true FROM generate_series(1, 2) g RETURNING id`, [w.u.homeCompanyId])).rows.map((r) => String(r.id));
    const accts = [w.sales, w.rent, w.child1, w.child2, ...extra];
    const cells = (amount: number | null) => {
      const out: unknown[] = [];
      for (const a of accts) {
        for (const m of members) for (const month of w.months) {
          if (out.length < CELLS) out.push({ glAccountId: a, cc1Id: m, cc2Id: null, buId: null, month, amount, ...(amount === null ? { clear: true } : {}) });
        }
      }
      return out;
    };
    const took: Record<string, number> = {};
    for (const [label, amount, rows] of [['insert', 12.34, CELLS], ['update', 56.78, CELLS], ['delete', null, 0]] as const) {
      const t0 = Date.now();
      const r = await fx.call(saveRoute, holder, 'POST', { body: { versionId: v, expectedUpdatedAt: await fx.token(v), cells: cells(amount) } });
      took[label] = Date.now() - t0;
      expect(r.status, `${label}: ${JSON.stringify(r.body).slice(0, 300)}`).toBe(200);
      expect((await pool.query('SELECT COUNT(*)::int n FROM budget_month_amounts WHERE version_id = $1', [v])).rows[0].n, label).toBe(rows);
    }
    process.stderr.write(`[p5-6 slice-rule cost] ${CELLS}-cell holder saves, ms ${JSON.stringify(took)}\n`);
    if (!IN_INTEGRATION_GATE) for (const [label, ms] of Object.entries(took)) expect(ms, label).toBeLessThanOrEqual(BOUND_MS);
  }, 600_000);
});
