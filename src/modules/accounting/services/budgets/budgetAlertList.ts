/**
 * The controls page's alert list (budgets P5 spec §4/§5): the company's OPEN overspend alerts and
 * those RESOLVED in the last `RESOLVED_DAYS` days, newest month first, each capped at
 * `ALERT_LIST_LIMIT`, plus when the alerts were last evaluated. Open alerts of an earlier financial
 * year stay open (the evaluator only looks at the current year): that year ended over budget.
 * Every query names the company.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { alertHref } from './overspendAlertsCore';
import { readLastEvaluated, type LastEvaluations } from './budgetAlertRuns';

export const ALERT_LIST_LIMIT = 200;
export const RESOLVED_DAYS = 30;

export interface BudgetAlertItem {
  id: string;
  versionId: string;
  glAccountId: string;
  accountCode: string;
  accountName: string;
  cc1Id: string | null;
  cc2Id: string | null;
  buId: string | null;
  sliceName: string | null;
  /** 'YYYY-MM'. */
  month: string;
  threshold: number;
  budget: number;
  actual: number;
  committed: number;
  /** Null: spend against a zero budget (no percentage). */
  pct: number | null;
  firedAt: string;
  resolvedAt: string | null;
  href: string;
}

export interface BudgetAlertList {
  open: BudgetAlertItem[];
  resolved: BudgetAlertItem[];
  lastEvaluated: LastEvaluations;
}

const text = (v: unknown): string | null => (v == null ? null : String(v));
const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

function mapItem(r: DbRow): BudgetAlertItem {
  const pct = Number(r.pct);
  const k = { month: String(r.month), cc1Id: text(r.cc1_id), cc2Id: text(r.cc2_id), buId: text(r.bu_id) };
  return {
    id: String(r.id), versionId: String(r.version_id), glAccountId: String(r.gl_account_id),
    accountCode: String(r.account_code), accountName: String(r.account_name), ...k, sliceName: text(r.slice_name),
    threshold: Number(r.threshold), budget: Number(r.budget), actual: Number(r.actual), committed: Number(r.committed),
    pct: Number.isFinite(pct) ? pct : null, firedAt: iso(r.fired_at) ?? '', resolvedAt: iso(r.resolved_at), href: alertHref(k),
  };
}

async function read(companyId: string, open: boolean): Promise<BudgetAlertItem[]> {
  const rows = (await sql`
    SELECT a.id::TEXT AS id, a.version_id::TEXT AS version_id, a.gl_account_id::TEXT AS gl_account_id,
           a.cc1_id::TEXT AS cc1_id, a.cc2_id::TEXT AS cc2_id, a.bu_id::TEXT AS bu_id, to_char(a.month, 'YYYY-MM') AS month,
           a.threshold::TEXT AS threshold, a.budget::TEXT AS budget, a.actual::TEXT AS actual, a.committed::TEXT AS committed,
           a.pct::TEXT AS pct, a.fired_at, a.resolved_at, ga.account_code, ga.account_name,
           COALESCE(cc.code || ' ' || cc.name, b.code || ' ' || b.name) AS slice_name
      FROM budget_alerts a
      JOIN gl_accounts ga ON ga.id = a.gl_account_id AND ga.company_id = a.company_id
      LEFT JOIN cost_centres cc ON cc.id = COALESCE(a.cc1_id, a.cc2_id) AND cc.company_id = a.company_id
      LEFT JOIN business_units b ON b.id = a.bu_id AND b.company_id = a.company_id
     WHERE a.company_id = ${companyId}::UUID
       AND (CASE WHEN ${open}::BOOLEAN THEN a.resolved_at IS NULL
                 ELSE a.resolved_at >= now() - make_interval(days => ${RESOLVED_DAYS}::INT) END)
     ORDER BY a.month DESC, ga.account_code, slice_name NULLS FIRST, a.threshold DESC, a.id
     LIMIT ${ALERT_LIST_LIMIT}
  `) as DbRow[];
  return rows.map(mapItem);
}

export async function listBudgetAlerts(companyId: string): Promise<BudgetAlertList> {
  const open = await read(companyId, true);
  const resolved = await read(companyId, false);
  return { open, resolved, lastEvaluated: await readLastEvaluated(companyId) };
}
