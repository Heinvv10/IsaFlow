/**
 * The months an EMP501 reconciles and the EMP201 filed for each (wave 6 EFb, review #1568 H1-H3, L1). Read-only.
 *
 * A month needs a filed EMP201 when it has a FINAL pay run (payRunFinalSql) or a standalone directive payment (a lump
 * sum paid outside payroll, by its journal's entry date: PAYE no run line carries). A run that is not final is not in
 * the EMP501, so it blocks nothing; it is a warning.
 *
 * A month counts as filed when its CURRENT (non-superseded) EMP201 version is filed; a current version that is only
 * finalised (an amend not yet filed) leaves it unfiled. With no lifecycle version, a legacy submission covering the
 * month that is submitted or accepted counts, unless a lifecycle version names it (fileReturn.legacySubmissions' rule).
 * A month filed through the lifecycle is compared with the certificates: PAYE, UIF and SDL from the final run lines of
 * that month plus the standalone payments' PAYE must equal the filed EMP201's totalPAYE, totalUIF and totalSDL.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { listStandaloneDirectivePayments } from '@/modules/accounting/services/payroll/directivePaymentFiling';
import { payRunFinalSql } from '@/modules/accounting/services/payroll/payRunFinalSql';
import type { Emp501Period } from '@/modules/accounting/services/payroll/emp501Period';
import { mapVersion } from './returnVersionStore';
import type { ReturnVersion } from './returnVersionTypes';

export interface MonthTotals { paye: number; uif: number; sdl: number }

export type Emp201Filing =
  | { kind: 'version'; version: ReturnVersion }
  | { kind: 'legacy' }
  | { kind: 'unfiled' };

export interface Emp501Month { month: string; totals: MonthTotals; emp201: Emp201Filing }

const cents = (n: number): number => Math.round(n * 100) / 100;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** 'June 2025' for '2025-06'. */
export const monthName = (ym: string): string => `${MONTH_NAMES[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

/** YYYY-MM -> what the certificates carry for the month: final run lines, plus standalone directive PAYE. */
async function monthTotals(companyId: string, p: Emp501Period): Promise<Map<string, MonthTotals>> {
  const rows = (await sql`
    SELECT to_char(make_date(h.period_year, h.period_month, 1), 'YYYY-MM') AS month,
           COALESCE(SUM(l.paye), 0) AS paye, COALESCE(SUM(l.uif_employee + l.uif_employer), 0) AS uif, COALESCE(SUM(l.sdl), 0) AS sdl
    FROM payroll_run_headers h
    LEFT JOIN payroll_run_lines l ON l.run_id = h.id
    WHERE h.company_id = ${companyId}::UUID AND ${sql.unsafe(payRunFinalSql('h'))}
      AND make_date(h.period_year, h.period_month, 1) BETWEEN ${p.start}::DATE AND ${p.end}::DATE
    GROUP BY 1
  `) as DbRow[];
  const out = new Map<string, MonthTotals>(rows.map((r) => [String(r.month), { paye: Number(r.paye), uif: Number(r.uif), sdl: Number(r.sdl) }]));
  for (const pay of await listStandaloneDirectivePayments(companyId, { start: p.start, end: p.end })) {
    const m = pay.paymentDate.slice(0, 7);
    const t = out.get(m) ?? { paye: 0, uif: 0, sdl: 0 };
    out.set(m, { ...t, paye: t.paye + pay.paye });
  }
  for (const [m, t] of out) out.set(m, { paye: cents(t.paye), uif: cents(t.uif), sdl: cents(t.sdl) });
  return out;
}

/** YYYY-MM of every month with a live run that is not final (not in the EMP501), in order. */
export async function notFinalRunMonths(companyId: string, p: Emp501Period): Promise<string[]> {
  const rows = (await sql`
    SELECT DISTINCT to_char(make_date(h.period_year, h.period_month, 1), 'YYYY-MM') AS month
    FROM payroll_run_headers h
    WHERE h.company_id = ${companyId}::UUID AND h.status <> 'cancelled' AND NOT ${sql.unsafe(payRunFinalSql('h'))}
      AND make_date(h.period_year, h.period_month, 1) BETWEEN ${p.start}::DATE AND ${p.end}::DATE
    ORDER BY 1
  `) as DbRow[];
  return rows.map((r) => String(r.month));
}

/** Every month the EMP501 reconciles, in order, with its certificate totals and its EMP201 filing. */
export async function emp501Months(companyId: string, p: Emp501Period): Promise<Emp501Month[]> {
  const totals = await monthTotals(companyId, p);
  const months = [...totals.keys()].sort();
  if (months.length === 0) return [];
  const current = (await sql`
    SELECT DISTINCT ON (period_start) * FROM tax_return_versions
    WHERE company_id = ${companyId}::UUID AND form_type = 'EMP201' AND status <> 'superseded'
      AND period_start BETWEEN ${p.start}::DATE AND ${p.end}::DATE
    ORDER BY period_start, version_no DESC
  `) as DbRow[];
  const versions = new Map(current.map((r) => { const v = mapVersion(r); return [v.periodStart.slice(0, 7), v]; }));
  const legacy = (await sql`
    SELECT DISTINCT to_char(m.month, 'YYYY-MM') AS month
    FROM unnest(${months.map((m) => `${m}-01`)}::DATE[]) AS m(month)
    WHERE EXISTS (
      SELECT 1 FROM sars_submissions s
      WHERE s.company_id = ${companyId}::UUID AND s.form_type = 'EMP201' AND s.status IN ('submitted', 'accepted')
        AND s.period_start <= m.month AND s.period_end >= (m.month + INTERVAL '1 month' - INTERVAL '1 day')::DATE
        AND NOT EXISTS (SELECT 1 FROM tax_return_versions t WHERE t.company_id = s.company_id AND t.sars_submission_id = s.id))
  `) as DbRow[];
  const legacyMonths = new Set(legacy.map((r) => String(r.month)));
  return months.map((month) => {
    const v = versions.get(month);
    const emp201: Emp201Filing = v
      ? (v.status === 'filed' ? { kind: 'version', version: v } : { kind: 'unfiled' })
      : legacyMonths.has(month) ? { kind: 'legacy' } : { kind: 'unfiled' };
    return { month, totals: totals.get(month)!, emp201 };
  });
}

/** Where a filed EMP201's totals differ from the month's certificates: 'PAYE R4 000.00 filed, R9 000.00 on the certificates'. */
export function emp201Differences(m: Emp501Month): string[] {
  if (m.emp201.kind !== 'version') return [];
  const f = m.emp201.version.figures as { totalPAYE?: unknown; totalUIF?: unknown; totalSDL?: unknown };
  const pairs: Array<[string, unknown, number]> = [['PAYE', f.totalPAYE, m.totals.paye], ['UIF', f.totalUIF, m.totals.uif], ['SDL', f.totalSDL, m.totals.sdl]];
  return pairs
    .filter(([, filed, now]) => cents(Number(filed ?? 0)) !== now)
    .map(([name, filed, now]) => `${name} ${cents(Number(filed ?? 0)).toFixed(2)} filed, ${now.toFixed(2)} on the certificates`);
}
