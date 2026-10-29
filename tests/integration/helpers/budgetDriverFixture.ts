/**
 * Rows of migration 949's tables for the budget-drivers suites, on top of budgetVersionFixture's
 * companies (FY2027 = March 2026 - February 2027). Each writer is also available as `.sql(...)`,
 * the [text, params] pair, for `codeOf` probes. Synthetic rows only.
 */
import type { Pool, PoolClient, QueryResult } from 'pg';
import type { Co } from './budgetVersionFixture';

type Q = Pool | PoolClient;
type Stmt = [string, unknown[]];

export interface DriverOpts {
  kind?: 'fixed' | 'pct_of_line' | 'pct_of_section' | 'growth' | 'per_head';
  acct?: string; cc1?: string | null; cc2?: string | null; bu?: string | null;
  from?: string; to?: string; refAcct?: string; headcountCc?: string | null; base?: string;
}

function driverSql(c: Co, versionId: string, o: DriverOpts = {}): Stmt {
  const kind = o.kind ?? 'fixed';
  const amount = kind === 'fixed' || kind === 'per_head' ? 1000 : null;
  const pct = amount === null ? 2.5 : null;
  return [
    `INSERT INTO budget_driver_lines (company_id, version_id, gl_account_id, cc1_id, cc2_id, bu_id, kind, from_month, to_month,
       amount, pct, ref_gl_account_id, ref_section, ref_scope, base_month, headcount_cost_centre_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id`,
    [c.id, versionId, o.acct ?? c.acct, o.cc1 ?? null, o.cc2 ?? null, o.bu ?? null, kind, o.from ?? '2026-04-01', o.to ?? '2026-12-01',
      amount, pct, kind === 'pct_of_line' ? (o.refAcct ?? c.acct2) : null,
      kind === 'pct_of_section' ? 'operating_expense' : null, kind === 'pct_of_section' ? 'company' : null,
      kind === 'growth' ? (o.base ?? '2026-03-01') : null, kind === 'per_head' ? (o.headcountCc ?? null) : null, c.user],
  ];
}

function hireSql(c: Co, versionId: string, o: { cc?: string | null; start?: string } = {}): Stmt {
  return [
    `INSERT INTO budget_planned_hires (company_id, version_id, label, cost_centre_id, start_month, fte, created_by)
     VALUES ($1, $2, 'Sales rep', $3, $4, 1, $5) RETURNING id`,
    [c.id, versionId, o.cc ?? null, o.start ?? '2026-06-01', c.user],
  ];
}

function rollingSql(c: Co, versionId: string, o: { fy?: number } = {}): Stmt {
  return [
    `INSERT INTO budget_rolling_forecasts (company_id, fiscal_year, version_id, created_by)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [c.id, o.fy ?? 2027, versionId, c.user],
  ];
}

function runner<A extends unknown[]>(build: (...a: A) => Stmt) {
  const run = (q: Q, ...a: A): Promise<QueryResult> => {
    const [text, params] = build(...a);
    return q.query(text, params);
  };
  return Object.assign(run, { sql: build });
}

export function driverFixture() {
  return { driver: runner(driverSql), hire: runner(hireSql), rolling: runner(rollingSql) };
}
