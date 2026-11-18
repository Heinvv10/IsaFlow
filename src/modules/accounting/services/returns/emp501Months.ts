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
 * A filed month with figures (its version's, or a one-month legacy row's form_data) is compared with the month's
 * certificate totals: PAYE, UIF and SDL from the final run lines plus the PAYE of standalone payments to an employee
 * (a directive naming no employee is on no certificate, so it is left out) must equal totalPAYE, totalUIF and totalSDL.
 * A legacy row without stored totals cannot be compared: a warning, never a refusal (review #1568 round 2).
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
  /** totals: the legacy row's form_data totals when it is exactly this month and stored them; null for older rows. */
  | { kind: 'legacy'; totals: MonthTotals | null }
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
    if (pay.employeeId === null) continue; // no certificate carries it
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
    SELECT DISTINCT ON (m.month) to_char(m.month, 'YYYY-MM') AS month,
           (s.period_start = m.month AND s.period_end = (m.month + INTERVAL '1 month' - INTERVAL '1 day')::DATE) AS one_month,
           s.form_data->'totalPAYE' AS paye, s.form_data->'totalUIF' AS uif, s.form_data->'totalSDL' AS sdl
    FROM unnest(${months.map((m) => `${m}-01`)}::DATE[]) AS m(month)
    JOIN sars_submissions s
      ON s.company_id = ${companyId}::UUID AND s.form_type = 'EMP201' AND s.status IN ('submitted', 'accepted')
     AND s.period_start <= m.month AND s.period_end >= (m.month + INTERVAL '1 month' - INTERVAL '1 day')::DATE
     AND NOT EXISTS (SELECT 1 FROM tax_return_versions t WHERE t.company_id = s.company_id AND t.sars_submission_id = s.id)
    ORDER BY m.month, s.submitted_at DESC NULLS LAST, s.id
  `) as DbRow[];
  const num = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const legacyByMonth = new Map(legacy.map((r) => {
    const [paye, uif, sdl] = [num(r.paye), num(r.uif), num(r.sdl)];
    const totals = r.one_month === true && paye !== null && uif !== null && sdl !== null ? { paye, uif, sdl } : null;
    return [String(r.month), totals];
  }));
  return months.map((month) => {
    const v = versions.get(month);
    const emp201: Emp201Filing = v
      ? (v.status === 'filed' ? { kind: 'version', version: v } : { kind: 'unfiled' })
      : legacyByMonth.has(month) ? { kind: 'legacy', totals: legacyByMonth.get(month) ?? null } : { kind: 'unfiled' };
    return { month, totals: totals.get(month)!, emp201 };
  });
}

/** The filed EMP201's totals of a month, when it has them (a version's figures, or a one-month legacy row's). */
export function filedTotals(f: Emp201Filing): MonthTotals | null {
  if (f.kind === 'legacy') return f.totals;
  if (f.kind !== 'version') return null;
  const x = f.version.figures as { totalPAYE?: unknown; totalUIF?: unknown; totalSDL?: unknown };
  return { paye: cents(Number(x.totalPAYE ?? 0)), uif: cents(Number(x.totalUIF ?? 0)), sdl: cents(Number(x.totalSDL ?? 0)) };
}

/** Where a filed EMP201's totals differ from the month's certificates: 'PAYE 4000.00 filed, 9000.00 on the certificates'. */
export function emp201Differences(m: Emp501Month): string[] {
  const filed = filedTotals(m.emp201);
  if (!filed) return [];
  const pairs: Array<[string, number, number]> = [['PAYE', filed.paye, m.totals.paye], ['UIF', filed.uif, m.totals.uif], ['SDL', filed.sdl, m.totals.sdl]];
  return pairs
    .filter(([, was, now]) => cents(was) !== now)
    .map(([name, was, now]) => `${name} ${cents(was).toFixed(2)} filed, ${now.toFixed(2)} on the certificates`);
}

/**
 * The sum of the totals of every filed EMP201 of the period (current filed versions, and one-month legacy rows with
 * stored totals that no version names), whether or not the month is in the EMP501's month set: an EMP201 declaring PAYE
 * no certificate carries (a directive naming no employee, an employee with no certificate) shows here.
 */
export async function filedEmp201PeriodTotals(companyId: string, p: Emp501Period): Promise<MonthTotals> {
  const rows = (await sql`
    SELECT COALESCE(SUM((x.d->>'totalPAYE')::NUMERIC), 0) AS paye, COALESCE(SUM((x.d->>'totalUIF')::NUMERIC), 0) AS uif,
           COALESCE(SUM((x.d->>'totalSDL')::NUMERIC), 0) AS sdl
    FROM (
      SELECT DISTINCT ON (v.period_start) v.figures AS d, v.status FROM tax_return_versions v
      WHERE v.company_id = ${companyId}::UUID AND v.form_type = 'EMP201' AND v.status <> 'superseded'
        AND v.period_start BETWEEN ${p.start}::DATE AND ${p.end}::DATE
      ORDER BY v.period_start, v.version_no DESC
    ) x WHERE x.status = 'filed'
  `) as DbRow[];
  const legacy = (await sql`
    SELECT COALESCE(SUM((x.d->>'totalPAYE')::NUMERIC), 0) AS paye, COALESCE(SUM((x.d->>'totalUIF')::NUMERIC), 0) AS uif,
           COALESCE(SUM((x.d->>'totalSDL')::NUMERIC), 0) AS sdl
    FROM (
    SELECT DISTINCT ON (s.period_start) s.form_data AS d
    FROM sars_submissions s
    WHERE s.company_id = ${companyId}::UUID AND s.form_type = 'EMP201' AND s.status IN ('submitted', 'accepted')
      AND s.period_start BETWEEN ${p.start}::DATE AND ${p.end}::DATE
      AND s.period_end = (date_trunc('month', s.period_start) + INTERVAL '1 month' - INTERVAL '1 day')::DATE
      AND s.form_data ? 'totalPAYE'
      AND NOT EXISTS (SELECT 1 FROM tax_return_versions t WHERE t.company_id = s.company_id AND t.sars_submission_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM tax_return_versions t WHERE t.company_id = s.company_id AND t.form_type = 'EMP201'
        AND t.status <> 'superseded' AND t.period_start = s.period_start)
    ORDER BY s.period_start, s.submitted_at DESC NULLS LAST, s.id
    ) x
  `) as DbRow[];
  const v = rows[0] ?? {}, l = legacy[0] ?? {};
  return {
    paye: cents(Number(v.paye ?? 0) + Number(l.paye ?? 0)),
    uif: cents(Number(v.uif ?? 0) + Number(l.uif ?? 0)),
    sdl: cents(Number(v.sdl ?? 0) + Number(l.sdl ?? 0)),
  };
}
