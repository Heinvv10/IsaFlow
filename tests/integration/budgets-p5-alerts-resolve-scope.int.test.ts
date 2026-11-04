/**
 * Budgets P5-4: `evaluateOverspend` resolves the open alerts of the EVALUATED FISCAL YEAR's versions
 * (the primary, and a former primary whose alerts the evaluator never crosses again), in the evaluated
 * months. An alert on another fiscal year's version, inside the evaluated range (incl. its first
 * month), survives.
 * Seed: helpers/budgetAlertsFixture.ts (asOf 2026-04-20: FY2027 March and April are evaluated).
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { evaluateOverspend } from '@/modules/accounting/services/budgets/overspendAlerts';
import { resolveUncrossed } from '@/modules/accounting/services/budgets/overspendAlertsWrite';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { AS_OF, dropAlertFixture, inRequest, journal, seedAlertFixture, type AlertFixture } from './helpers/budgetAlertsFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: AlertFixture;

beforeAll(async () => { f = await seedAlertFixture(pool); }, 120_000);
afterAll(async () => {
  try { await dropAlertFixture(pool, f); } finally { await pool.end(); }
});

const extraVersion = async (c: PoolClient, fiscalYear: number, name: string): Promise<string> => String((await c.query(
  `INSERT INTO budget_versions (company_id, fiscal_year, name, kind, is_primary, created_by)
   VALUES ($1, $2, $3, 'scenario', false, $4) RETURNING id`, [f.a, fiscalYear, name, f.ownerA])).rows[0].id);
// threshold 90 is not a configured threshold: on the evaluated version it is uncrossed; elsewhere it is simply open.
const openAlert = async (c: PoolClient, versionId: string, month: string, company = f.a, account = f.acc.opex): Promise<string> => String((await c.query(
  `INSERT INTO budget_alerts (company_id, version_id, gl_account_id, month, threshold, budget, actual, committed, pct)
   VALUES ($1, $2, $3, $4::DATE, 90, 1000, 900, 0, 90) RETURNING id::TEXT AS id`, [company, versionId, account, month])).rows[0].id);

describe('evaluateOverspend: what a run resolves', () => {
  it('resolves the primary\'s uncrossed alert and a former primary\'s; another fiscal year\'s, a later month\'s and another company\'s stay open', async () => {
    let primary = '';
    let otherYearBoundary = '';
    let otherYearInRange = '';
    let formerPrimary = '';
    let laterMonth = '';
    let otherCompany = '';
    await inRequest(pool, f.a, f.ownerA, async ({ asSuper }) => {
      const out = await evaluateOverspend(f.a, { asOf: AS_OF });
      expect(out.versionId).toBe(f.vA);
      expect([...out.resolved].sort()).toEqual([primary, formerPrimary].sort());
      const ids = [primary, formerPrimary, otherYearBoundary, otherYearInRange, laterMonth, otherCompany];
      const rows = await asSuper((c) => c.query(
        'SELECT id::TEXT AS id, resolved_at FROM budget_alerts WHERE id = ANY($1::UUID[])', [ids]));
      const byId = new Map(rows.rows.map((r) => [String(r.id), r.resolved_at]));
      expect(byId.get(primary)).not.toBeNull();
      expect(byId.get(otherYearBoundary)).toBeNull();
      expect(byId.get(otherYearInRange)).toBeNull();
      expect(byId.get(formerPrimary)).not.toBeNull();
      expect(byId.get(laterMonth)).toBeNull(); // after asOf's month: outside the evaluated range
      expect(byId.get(otherCompany)).toBeNull(); // company B's same-year alert, same months
    }, async (c) => {
      await journal(c, f.a, '2026-04-10', f.ownerA, [[f.acc.opex, 1050, 0], [f.acc.bank, 0, 1050]]);
      primary = await openAlert(c, f.vA, '2026-04-01');
      const fy2026 = await extraVersion(c, 2026, 'FY2026 original');
      otherYearBoundary = await openAlert(c, fy2026, '2026-03-01'); // first month of the evaluated range
      otherYearInRange = await openAlert(c, fy2026, '2026-04-01');
      formerPrimary = await openAlert(c, await extraVersion(c, 2027, 'FY2027 former primary'), '2026-04-01');
      laterMonth = await openAlert(c, f.vA, '2026-05-01');
      otherCompany = await openAlert(c, f.vB, '2026-04-01', f.b, f.acc.bOpex);
    });
  });

  it('resolves nothing when the version is not of the stated fiscal year, or when there is no version', async () => {
    let primary = '';
    await inRequest(pool, f.a, f.ownerA, async ({ asSuper }) => {
      expect(await resolveUncrossed(f.a, 2026, f.vA, [], '2026-03-01', '2026-04-01')).toEqual([]);
      expect(await resolveUncrossed(f.a, 2027, null, [], '2026-03-01', '2026-04-01')).toEqual([]);
      const open = await asSuper((c) => c.query('SELECT resolved_at FROM budget_alerts WHERE id = $1', [primary]));
      expect(open.rows).toEqual([{ resolved_at: null }]);
      expect(await resolveUncrossed(f.a, 2027, f.vA, [], '2026-03-01', '2026-04-01')).toEqual([primary]);
    }, async (c) => { primary = await openAlert(c, f.vA, '2026-04-01'); });
  });
});
