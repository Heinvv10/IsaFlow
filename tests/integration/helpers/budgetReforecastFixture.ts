/**
 * Shared by the reforecast-from-actuals and rolling-forecast suites (Budgets P4 PR-4):
 * budgetDriverRouteFixture's world (a March company, its current registry year) plus a Salaries
 * expense account, a second CC1, the year's real fiscal periods (`fiscal_periods_generate`),
 * posted journals (balanced against the world's bank account; optionally CC1-tagged and with a
 * source, 'auto_payroll' for payroll's labour lines), and callers for the reforecast route and the
 * fiscal-period actions (the real closePeriod / reopenPeriod / closeYear through withAuth, so the
 * after-commit roll runs exactly as in production). Real PostgreSQL; synthetic rows only.
 */
import type { Pool } from 'pg';
import reforecastRoute from '../../../pages/api/accounting/budget-versions/[id]/reforecast';
import periodsRoute from '../../../pages/api/accounting/fiscal-periods-action';
import { budgetDriverRouteFixture, type DriverWorld } from './budgetDriverRouteFixture';
import { budgetsRouteFixture, type RouteOut } from './budgetsRouteFixture';
import type { SetupUser } from './onboardingSetupFixture';

export interface ReforecastWorld extends DriverWorld {
  /** GS-6500 Salaries (expense). */
  salaries: string;
  /** A second CC1 centre. */
  cc1b: string;
  /** Fiscal period id by month 'YYYY-MM'. */
  periods: Map<string, string>;
}

/** [account, debit, credit, tags]: the bank leg is added to balance. */
export type JournalLine = [string, number, number, { cc1?: string }?];

export function budgetReforecastFixture(pool: Pool) {
  const fx = budgetDriverRouteFixture(pool);
  const reforecast = budgetsRouteFixture(pool, reforecastRoute, '/api/accounting/budget-versions/[id]/reforecast');
  const periodsCall = budgetsRouteFixture(pool, periodsRoute, '/api/accounting/fiscal-periods-action');
  const companies: string[] = [];
  let n = 0;

  async function world(): Promise<ReforecastWorld> {
    const w = await fx.world();
    const c = w.u.homeCompanyId;
    companies.push(c);
    const salaries = String((await pool.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, is_active)
       VALUES ($1, 'GS-6500', 'Salaries', 'expense', 'debit', 3, true) RETURNING id`, [c])).rows[0].id);
    const cc1b = String((await pool.query(
      `INSERT INTO cost_centres (company_id, code, name, cc_type) VALUES ($1, 'GS-C1B', 'GS-C1B', 'cc1') RETURNING id`, [c])).rows[0].id);
    const year = String((await pool.query('SELECT id FROM fiscal_years WHERE company_id = $1 AND fiscal_year = $2', [c, w.label])).rows[0].id);
    await pool.query('SELECT public.fiscal_periods_generate($1)', [year]);
    const rows = (await pool.query(
      `SELECT id::text AS id, to_char(start_date, 'YYYY-MM') AS m FROM fiscal_periods WHERE company_id = $1 AND fiscal_year_id = $2`,
      [c, year])).rows;
    return { ...w, salaries, cc1b, periods: new Map(rows.map((r) => [String(r.m), String(r.id)])) };
  }

  /** A posted journal on `date`, balanced against the bank; `source` 'auto_payroll' marks payroll's labour journal. */
  async function journal(w: ReforecastWorld, date: string, lines: JournalLine[], opts: { source?: string; status?: string } = {}) {
    const c = w.u.homeCompanyId;
    n += 1;
    const eid = String((await pool.query(
      `INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, status, created_by, description, source, created_at)
       VALUES ($1, $2, $3::DATE, $4, $5, 'rf', $6, NOW()) RETURNING id`,
      [c, `RF-${n}-${crypto.randomUUID().slice(0, 6)}`, date, opts.status ?? 'posted', w.u.userId, opts.source ?? 'manual'])).rows[0].id);
    const net = lines.reduce((s, [, dr, cr]) => s + cr - dr, 0);
    const all: JournalLine[] = [...lines, net >= 0 ? [w.asset, net, 0] : [w.asset, 0, -net]];
    for (const [acct, dr, cr, t] of all) {
      await pool.query(
        `INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit, cc1_id, description)
         VALUES ($1, $2, $3, $4, $5, $6, 'rf')`, [eid, c, acct, dr, cr, t?.cc1 ?? null]);
    }
  }

  const call = {
    ...fx.call,
    /** The reforecast route on `versionId`; a write naming no `expectedUpdatedAt` is sent none (the route requires one where it must). */
    reforecast: (u: SetupUser, versionId: string, method: string, body?: unknown) => reforecast.call(u, method, body, { id: versionId }),
    period: (u: SetupUser, body: Record<string, unknown>) => periodsCall.call(u, 'POST', body),
  };

  /** Closes the months in order through the real route (the after-commit roll runs). */
  async function close(w: ReforecastWorld, months: string[]): Promise<void> {
    for (const m of months) {
      const r = await call.period(w.u, { action: 'close', id: w.periods.get(m) });
      if (r.status !== 200) throw new Error(`close ${m}: ${r.status} ${JSON.stringify(r.body)}`);
    }
  }

  /** Polls until `probe` answers true (20 s at most). */
  async function until(probe: () => Promise<boolean>, what: string): Promise<void> {
    const end = Date.now() + 20_000;
    while (Date.now() < end) {
      if (await probe()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  const rollingRow = async (versionId: string) => (await pool.query(
    `SELECT to_char(rolled_through_month, 'YYYY-MM') AS through, last_error, last_rolled_at::text AS rolled_at
       FROM budget_rolling_forecasts WHERE version_id = $1`, [versionId])).rows[0] as
    { through: string | null; last_error: string | null; rolled_at: string | null } | undefined;

  /** Every cell of the version with amount, source, xmin and updated_at, keyed `acct|cc1|month`. */
  async function snapshot(versionId: string): Promise<Map<string, string>> {
    const rows = (await pool.query(
      `SELECT gl_account_id || '|' || COALESCE(cc1_id::text, '') || '|' || to_char(month, 'YYYY-MM') AS k,
              amount::text || ':' || amount_source || ':' || xmin::text || ':' || updated_at::text AS v
         FROM budget_month_amounts WHERE version_id = $1`, [versionId])).rows;
    return new Map(rows.map((r) => [String(r.k), String(r.v)]));
  }

  /** One account's cells (optionally one CC1) by month as `amount:source`. */
  async function cellsOf(versionId: string, acct: string, cc1: string | null = null): Promise<Map<string, string>> {
    const rows = (await pool.query(
      `SELECT to_char(month, 'YYYY-MM') AS m, amount::text || ':' || amount_source AS v FROM budget_month_amounts
        WHERE version_id = $1 AND gl_account_id = $2 AND cc1_id IS NOT DISTINCT FROM $3::UUID ORDER BY month`,
      [versionId, acct, cc1])).rows;
    return new Map(rows.map((r) => [String(r.m), String(r.v)]));
  }

  async function cleanup(): Promise<void> {
    const client = await pool.connect();
    try {
      // Posted journals and closed periods refuse deletes by trigger: bypassed for the cleanup only.
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      // The lock trigger is ENABLE ALWAYS: a locked version is unlocked first, as the fixture's own cleanup does.
      await client.query(
        `UPDATE budget_versions SET status = 'approved', unlocked_by = locked_by, unlocked_at = clock_timestamp(), unlock_reason = 'test cleanup'
          WHERE company_id = ANY($1::UUID[]) AND status = 'locked'`, [companies]);
      await client.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = ANY($1::UUID[]))', [companies]);
      for (const t of ['gl_journal_lines', 'gl_journal_entries', 'budget_rolling_forecasts', 'budget_driver_lines', 'budget_planned_hires', 'fiscal_periods']) {
        await client.query(`DELETE FROM ${t} WHERE company_id = ANY($1::UUID[])`, [companies]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    await fx.cleanup();
  }

  return { ...fx, world, journal, call, close, until, rollingRow, snapshot, cellsOf, cleanup };
}

export type { RouteOut };
