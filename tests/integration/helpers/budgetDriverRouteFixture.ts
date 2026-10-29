/**
 * Shared by the budget-drivers route suites (P4 PR-3): budgetGridSaveFixture's world (a March
 * company, its current registry year, revenue / expense / header / inactive accounts, CC1 / CC2 /
 * BU) plus a cost-of-sales account, and a caller for each budget-drivers route and the grid save,
 * as real members through withAuth (request transaction, CSRF, role gate). A write that names no
 * `expectedUpdatedAt` (in its body, or its query for DELETE) is sent the version's current token; a
 * test that names one (even `undefined`) sends exactly that. A state fingerprint
 * (cells with source, drivers, hires, audit rows, token) proves a refusal wrote nothing.
 * Real PostgreSQL; synthetic rows only.
 */
import type { Pool } from 'pg';
import driversRoute from '../../../pages/api/accounting/budget-drivers/index';
import overrideRoute from '../../../pages/api/accounting/budget-drivers/override';
import headcountRoute from '../../../pages/api/accounting/budget-drivers/headcount';
import hiresRoute from '../../../pages/api/accounting/budget-drivers/planned-hires';
import saveRoute from '../../../pages/api/accounting/budget-grid/save';
import gridRoute from '../../../pages/api/accounting/budget-grid/index';
import { budgetGridSaveFixture, TOKEN_SQL, type GridWorld } from './budgetGridSaveFixture';
import { budgetsRouteFixture, type RouteOut } from './budgetsRouteFixture';
import type { SetupUser } from './onboardingSetupFixture';

export interface DriverWorld extends GridWorld {
  /** GS-5100 Cost of sales (expense, subtype cost_of_sales). */
  cogs: string;
}

export function budgetDriverRouteFixture(pool: Pool) {
  const grid = budgetGridSaveFixture(pool, saveRoute, '/api/accounting/budget-grid/save');
  const caller = (route: unknown, url: string) => budgetsRouteFixture(pool, route, url);
  const routes = {
    drivers: caller(driversRoute, '/api/accounting/budget-drivers'),
    override: caller(overrideRoute, '/api/accounting/budget-drivers/override'),
    headcount: caller(headcountRoute, '/api/accounting/budget-drivers/headcount'),
    hires: caller(hiresRoute, '/api/accounting/budget-drivers/planned-hires'),
    grid: caller(gridRoute, '/api/accounting/budget-grid'),
  };

  async function world(): Promise<DriverWorld> {
    const w = await grid.world();
    const cogs = String((await pool.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, level, is_active)
       VALUES ($1, 'GS-5100', 'Cost of sales', 'expense', 'cost_of_sales', 'debit', 3, true) RETURNING id`,
      [w.u.homeCompanyId])).rows[0].id);
    return { ...w, cogs };
  }

  /** The current token for a write that names none. */
  async function tokened(method: string, body: unknown, query: Record<string, string>): Promise<[unknown, Record<string, string>]> {
    if (method === 'GET') return [body, query];
    const b = body as Record<string, unknown> | undefined;
    const withBody = b && typeof b.versionId === 'string' && !('expectedUpdatedAt' in b) ? { ...b, expectedUpdatedAt: await token(b.versionId) } : body;
    const withQuery = query.versionId && !('expectedUpdatedAt' in query) ? { ...query, expectedUpdatedAt: await token(query.versionId) } : query;
    return [withBody, withQuery];
  }
  const send = (r: { call: (u: SetupUser, m: string, b?: unknown, q?: Record<string, string>) => Promise<RouteOut> }) =>
    async (u: SetupUser, method: string, body?: unknown, query: Record<string, string> = {}) => {
      const [b, q] = await tokened(method, body, query);
      return r.call(u, method, b, q);
    };
  const call = {
    drivers: send(routes.drivers),
    override: (u: SetupUser, body: unknown) => send(routes.override)(u, 'POST', body),
    headcount: send(routes.headcount),
    hires: send(routes.hires),
    grid: (u: SetupUser, versionId: string) => routes.grid.call(u, 'GET', undefined, { version_id: versionId }),
    save: async (u: SetupUser, versionId: string, cells: unknown[]) =>
      grid.call(u, { versionId, expectedUpdatedAt: await grid.token(versionId), cells }),
  };

  /** The version's cells as `acct|cc1|cc2|bu|YYYY-MM=amount:source`, sorted. */
  async function cells(versionId: string): Promise<string[]> {
    const rows = (await pool.query(
      `SELECT gl_account_id || '|' || COALESCE(cc1_id::text, '') || '|' || COALESCE(cc2_id::text, '') || '|' || COALESCE(bu_id::text, '')
              || '|' || to_char(month, 'YYYY-MM') || '=' || amount::text || ':' || amount_source AS k
         FROM budget_month_amounts WHERE version_id = $1 ORDER BY 1`, [versionId])).rows;
    return rows.map((r) => String(r.k));
  }

  /** One account's cells by month: amount, source, and the row version (xmin) and updated_at. */
  async function row(versionId: string, acct: string): Promise<Map<string, { amount: string; source: string; xmin: string; updatedAt: string }>> {
    const rows = (await pool.query(
      `SELECT to_char(month, 'YYYY-MM') AS m, amount::text AS amount, amount_source, xmin::text AS xmin, updated_at::text AS u
         FROM budget_month_amounts WHERE version_id = $1 AND gl_account_id = $2 ORDER BY month`, [versionId, acct])).rows;
    return new Map(rows.map((r) => [String(r.m), { amount: String(r.amount), source: String(r.amount_source), xmin: String(r.xmin), updatedAt: String(r.u) }]));
  }

  /** Everything a driver write can change; equal before and after = nothing written. */
  async function state(versionId: string) {
    const drivers = (await pool.query(
      `SELECT gl_account_id, kind, from_month::text, to_month::text, amount::text, pct::text, xmin::text FROM budget_driver_lines
        WHERE version_id = $1 ORDER BY id`, [versionId])).rows;
    const hires = (await pool.query(
      `SELECT label, start_month::text, fte::text, xmin::text FROM budget_planned_hires WHERE version_id = $1 ORDER BY id`, [versionId])).rows;
    return { cells: await cells(versionId), drivers, hires, audits: (await grid.audits(versionId)).length, token: await grid.token(versionId) };
  }

  const token = async (versionId: string) =>
    String((await pool.query(`SELECT ${TOKEN_SQL} AS t FROM budget_versions WHERE id = $1`, [versionId])).rows[0].t);

  /** A version with Sales 1 000 in months 0-2 and COGS = 38% of Sales over the whole year (PUT through the route). */
  async function cogsOfSales(w: DriverWorld): Promise<{ v: string; put: RouteOut }> {
    const v = await grid.version(w);
    for (const m of w.months.slice(0, 3)) await grid.amount(w, v, w.sales, m, 1000);
    const put = await call.drivers(w.u, 'PUT', {
      versionId: v, glAccountId: w.cogs, kind: 'pct_of_line', pct: 38, fromMonth: w.months[0], toMonth: w.months[11],
      ref: { glAccountId: w.sales },
    });
    if (put.status !== 200) throw new Error(`cogsOfSales: ${put.status} ${JSON.stringify(put.body).slice(0, 300)}`);
    return { v, put };
  }

  return { ...grid, world, call, cells, row, state, token, cogsOfSales };
}

export type { RouteOut };
export const details = (r: RouteOut) => (r.body.error as { details?: Record<string, unknown> } | undefined)?.details ?? {};
export const dataOf = <T = Record<string, unknown>>(r: RouteOut) => r.body.data as T;
