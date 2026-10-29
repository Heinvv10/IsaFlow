/**
 * What the versions bar shows for a version (Budgets P4 spec §5, §6): "Rolled through <month> · N
 * closed since", "<month> reopened after the roll", and the actuals the forecast cannot place.
 * Read-only; nothing here is stored (no migration): every figure is recomputed from committed state.
 *
 * - staleMonths: closed months after rolled_through_month (a roll that did not run).
 * - reopenedMonths: months up to rolled_through_month that are no longer closed and still hold
 *   'actual' cells (the next roll makes them 'manual').
 * - unplaced: the closed months' untagged actuals (or actuals naming a member no budget cell may
 *   name) on accounts the version budgets by a dimension, per account and month, from P3's reader
 *   through `readClosedActuals` and the version's own grains, the planner's rule: an auto roll's
 *   unplaced amounts are visible here even when the roll changed no cell.
 */
import { sql, type DbRow } from '@/lib/neon';
import { versionYear } from '../budgetVersionScope';
import { fromCents } from '../grid/cents';
import { budgetMonthKeysInWindow } from '../../reports/budgetPeriodWindow';
import { closedMonthsOf, readClosedActuals, type ClosedActuals, type UnplacedActualLine } from './reforecastInputs';
import { rollingRow } from './rollingForecastService';

type Grain = 'company' | 'cc1' | 'cc2' | 'bu';

export interface RollingStatus {
  rolling: boolean;
  /** 'YYYY-MM' months. */
  rolledThroughMonth: string | null;
  latestClosedMonth: string | null;
  /** Closed months after rolledThroughMonth: closed since the last roll (a roll that did not run). */
  staleMonths: string[];
  /** Months up to rolledThroughMonth no longer closed that still hold 'actual' cells. */
  reopenedMonths: string[];
  /** Closed-month actuals the version cannot place, named, in rand. */
  unplaced: UnplacedActualLine[];
  lastRolledAt: string | null;
  lastError: string | null;
}

/** Each account's grain in the version: its cells, its drivers' rows and the rows they read (the planner's rows). */
async function versionGrains(companyId: string, versionId: string): Promise<Map<string, Grain>> {
  const rows = (await sql`
    SELECT gl_account_id::text AS a,
           CASE WHEN cc1_id IS NOT NULL THEN 'cc1' WHEN cc2_id IS NOT NULL THEN 'cc2' WHEN bu_id IS NOT NULL THEN 'bu' ELSE 'company' END AS g
      FROM budget_month_amounts WHERE company_id = ${companyId}::UUID AND version_id = ${versionId}::UUID
    UNION
    SELECT gl_account_id::text,
           CASE WHEN cc1_id IS NOT NULL THEN 'cc1' WHEN cc2_id IS NOT NULL THEN 'cc2' WHEN bu_id IS NOT NULL THEN 'bu' ELSE 'company' END
      FROM budget_driver_lines WHERE company_id = ${companyId}::UUID AND version_id = ${versionId}::UUID
    UNION
    SELECT ref_gl_account_id::text,
           CASE WHEN ref_cc1_id IS NOT NULL THEN 'cc1' WHEN ref_cc2_id IS NOT NULL THEN 'cc2' WHEN ref_bu_id IS NOT NULL THEN 'bu' ELSE 'company' END
      FROM budget_driver_lines
     WHERE company_id = ${companyId}::UUID AND version_id = ${versionId}::UUID AND ref_gl_account_id IS NOT NULL
  `) as DbRow[];
  return new Map(rows.map((r) => [String(r.a).toLowerCase(), String(r.g) as Grain]));
}

/** The planner's unplaced rule over `read`: untagged actuals at an account's dimension grain, non-zero net per account + month. */
export function unplacedAt(grains: ReadonlyMap<string, Grain>, read: ClosedActuals, closed: ReadonlySet<string>): UnplacedActualLine[] {
  const sums = new Map<string, number>();
  for (const level of ['cc1', 'cc2', 'bu'] as const) {
    for (const a of read.actuals[level]) {
      if (a.memberId !== null || !closed.has(a.month) || grains.get(a.accountId) !== level) continue;
      const key = `${a.accountId}|${a.month}`;
      sums.set(key, (sums.get(key) ?? 0) + a.amount);
    }
  }
  return [...sums.entries()].filter(([, cents]) => cents !== 0)
    .map(([key, cents]) => {
      const [accountId = '', month = ''] = key.split('|');
      const meta = read.accounts.get(accountId);
      return {
        accountId, accountCode: meta?.accountCode ?? '', accountName: meta?.accountName ?? '',
        level: grains.get(accountId) ?? 'company', month, amount: fromCents(cents),
      };
    })
    .sort((x, y) => (x.accountId < y.accountId ? -1 : x.accountId > y.accountId ? 1 : x.month < y.month ? -1 : x.month > y.month ? 1 : 0));
}

/** Another company's version is a 404. Sequential reads (withAuth binds one client). */
export async function rollingStatus(companyId: string, versionId: string): Promise<RollingStatus> {
  const id = versionId.toLowerCase();
  const year = await versionYear(companyId, id);
  const row = await rollingRow(companyId, id);
  const closed = await closedMonthsOf(companyId, year, budgetMonthKeysInWindow(year.startDate, year.endDate));
  const closedSet = new Set(closed);
  const through = row?.rolledThrough ?? null;
  const actualMonths = (await sql`
    SELECT DISTINCT to_char(month, 'YYYY-MM') AS m FROM budget_month_amounts
     WHERE company_id = ${companyId}::UUID AND version_id = ${id}::UUID AND amount_source = 'actual'
     ORDER BY 1
  `) as DbRow[];
  const unplaced = unplacedAt(await versionGrains(companyId, id), await readClosedActuals(companyId, year, closed), closedSet);
  return {
    rolling: row !== null,
    rolledThroughMonth: through,
    latestClosedMonth: closed.length > 0 ? closed[closed.length - 1]! : null,
    staleMonths: row ? closed.filter((m) => through === null || m > through) : [],
    reopenedMonths: through === null ? [] : actualMonths.map((r) => String(r.m)).filter((m) => m <= through && !closedSet.has(m)),
    unplaced,
    lastRolledAt: row?.lastRolledAt ?? null,
    lastError: row?.lastError ?? null,
  };
}
