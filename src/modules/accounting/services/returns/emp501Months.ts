/**
 * The months an EMP501 reconciles and the EMP201s filed for its period (wave 6 EFb, review #1568 rounds 1-3). Read-only.
 *
 * A month needs a filed EMP201 when it has a FINAL pay run (payRunFinalSql) or a standalone directive payment to an
 * employee (by its journal's entry date). A run that is not final is not in the EMP501: a warning.
 *
 * A month is filed by its CURRENT (non-superseded) EMP201 version being filed (a finalised amend leaves it unfiled);
 * with no lifecycle version, by the latest submitted/accepted legacy submission covering it that no version names
 * (fileReturn.legacySubmissions' rule). Legacy rows exist that span several months, or stored no totals.
 *
 * Certificate totals per month (`monthTotals`): PAYE, UIF and SDL from the final run lines plus the PAYE of standalone
 * payments to an employee (a directive naming no employee is on no certificate). Compared with:
 *  - a filed version, or a one-month legacy row with stored totals: per month;
 *  - a multi-month legacy row with stored totals: once, against the sum of the months it covers;
 *  - a legacy row without stored totals: not compared (a warning naming why).
 * The period check (emp501Readiness.assertEmp501MatchesFiledEmp201s) sums every filed EMP201 of the period; a legacy
 * row without totals counts as its months' certificate totals, so it adds no difference and hides none.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { listStandaloneDirectivePayments } from '@/modules/accounting/services/payroll/directivePaymentFiling';
import { payRunFinalSql } from '@/modules/accounting/services/payroll/payRunFinalSql';
import type { Emp501Period } from '@/modules/accounting/services/payroll/emp501Period';
import { mapVersion } from './returnVersionStore';
import type { ReturnVersion } from './returnVersionTypes';

export interface MonthTotals { paye: number; uif: number; sdl: number }

/** A legacy EMP201 submission: the months (YYYY-MM) it covers inside the period, and its stored totals if any. */
export interface LegacyEmp201 {
  id: string;
  months: string[];
  /** Null when none were stored, or when the row also covers months outside this return or already filed again. */
  totals: MonthTotals | null;
  /** Its own span in months (period_start to period_end). */
  span: number;
  storedTotals: boolean;
}

export type Emp201Filing =
  | { kind: 'version'; version: ReturnVersion }
  | { kind: 'legacy'; row: LegacyEmp201 }
  | { kind: 'unfiled' };

export interface Emp501Month { month: string; totals: MonthTotals; emp201: Emp201Filing }

export interface Emp501Filings {
  /** The months the EMP501 reconciles, in order. */
  months: Emp501Month[];
  /** Every filed current version of the period (any month, in the month set or not). */
  filedVersions: ReturnVersion[];
  /** Every legacy row filing a period month that has no current version, once each. */
  legacyRows: LegacyEmp201[];
  /** Certificate totals per YYYY-MM. */
  certificates: Map<string, MonthTotals>;
}

const ZERO: MonthTotals = { paye: 0, uif: 0, sdl: 0 };
export const cents = (n: number): number => Math.round(n * 100) / 100;
const add = (a: MonthTotals, b: MonthTotals): MonthTotals => ({ paye: cents(a.paye + b.paye), uif: cents(a.uif + b.uif), sdl: cents(a.sdl + b.sdl) });
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** 'June 2025' for '2025-06'. */
export const monthName = (ym: string): string => `${MONTH_NAMES[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
/** 'March 2025' or 'March 2025 to April 2025'. */
export const monthsName = (ms: string[]): string => (ms.length <= 1 ? monthName(ms[0] ?? '') : `${monthName(ms[0]!)} to ${monthName(ms[ms.length - 1]!)}`);

/** YYYY-MM -> what the certificates carry for the month: final run lines, plus standalone directive PAYE to an employee. */
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
    out.set(m, add(out.get(m) ?? ZERO, { paye: pay.paye, uif: 0, sdl: 0 }));
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

const num = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** The months of the period, their certificate totals and the EMP201 filings of every month of the period. */
export async function emp501Filings(companyId: string, p: Emp501Period): Promise<Emp501Filings> {
  const certificates = await monthTotals(companyId, p);
  const current = (await sql`
    SELECT DISTINCT ON (period_start) * FROM tax_return_versions
    WHERE company_id = ${companyId}::UUID AND form_type = 'EMP201' AND status <> 'superseded'
      AND period_start BETWEEN ${p.start}::DATE AND ${p.end}::DATE
    ORDER BY period_start, version_no DESC
  `) as DbRow[];
  const versions = new Map(current.map((r) => { const v = mapVersion(r); return [v.periodStart.slice(0, 7), v]; }));
  // Per period month with no current version: the latest legacy row covering it (rows a version names are not legacy).
  const legacy = (await sql`
    SELECT DISTINCT ON (m.month) to_char(m.month, 'YYYY-MM') AS month, s.id, s.period_start::TEXT AS ps, s.period_end::TEXT AS pe,
           s.form_data->'totalPAYE' AS paye, s.form_data->'totalUIF' AS uif, s.form_data->'totalSDL' AS sdl
    FROM generate_series(${p.start}::DATE, ${p.end}::DATE, INTERVAL '1 month') AS m(month)
    JOIN sars_submissions s
      ON s.company_id = ${companyId}::UUID AND s.form_type = 'EMP201' AND s.status IN ('submitted', 'accepted')
     AND s.period_start <= m.month AND s.period_end >= (m.month + INTERVAL '1 month' - INTERVAL '1 day')::DATE
     AND NOT EXISTS (SELECT 1 FROM tax_return_versions t WHERE t.company_id = s.company_id AND t.sars_submission_id = s.id)
    ORDER BY m.month, s.submitted_at DESC NULLS LAST, s.id
  `) as DbRow[];
  const rows = new Map<string, LegacyEmp201>();
  const legacyByMonth = new Map<string, LegacyEmp201>();
  for (const r of legacy) {
    const month = String(r.month);
    if (versions.has(month)) continue; // the lifecycle version is the month's filing
    const id = String(r.id);
    let row = rows.get(id);
    if (!row) {
      const [paye, uif, sdl] = [num(r.paye), num(r.uif), num(r.sdl)];
      const stored = paye !== null && uif !== null && sdl !== null;
      const [ps, pe] = [String(r.ps), String(r.pe)];
      const span = (Number(pe.slice(0, 4)) - Number(ps.slice(0, 4))) * 12 + Number(pe.slice(5, 7)) - Number(ps.slice(5, 7)) + 1;
      row = { id, months: [], totals: stored ? { paye: cents(paye), uif: cents(uif), sdl: cents(sdl) } : null, span, storedTotals: stored };
      rows.set(id, row);
    }
    row.months.push(month);
    legacyByMonth.set(month, row);
  }
  // A row whose totals cover months this return does not reach as legacy (outside the period, or filed again through
  // the lifecycle) cannot be compared with the certificates of the months it does: its totals are not used.
  for (const row of rows.values()) if (row.months.length !== row.span) row.totals = null;
  const months = [...certificates.keys()].sort().map((month) => {
    const v = versions.get(month);
    const legacyRow = legacyByMonth.get(month);
    const emp201: Emp201Filing = v
      ? (v.status === 'filed' ? { kind: 'version', version: v } : { kind: 'unfiled' })
      : legacyRow ? { kind: 'legacy', row: legacyRow } : { kind: 'unfiled' };
    return { month, totals: certificates.get(month)!, emp201 };
  });
  return {
    months,
    filedVersions: [...versions.values()].filter((v) => v.status === 'filed'),
    legacyRows: [...rows.values()],
    certificates,
  };
}

/** A version's stored totals. */
export function versionTotals(v: ReturnVersion): MonthTotals {
  const x = v.figures as { totalPAYE?: unknown; totalUIF?: unknown; totalSDL?: unknown };
  return { paye: cents(Number(x.totalPAYE ?? 0)), uif: cents(Number(x.totalUIF ?? 0)), sdl: cents(Number(x.totalSDL ?? 0)) };
}

/** The certificate totals of the months a legacy row covers. */
export function certificateTotalsOf(f: Emp501Filings, months: string[]): MonthTotals {
  return months.reduce((t, m) => add(t, f.certificates.get(m) ?? ZERO), ZERO);
}

/** 'PAYE 4000.00 filed, 9000.00 on the certificates' for each total that differs (in cents). */
export function differences(filed: MonthTotals, certs: MonthTotals): string[] {
  return (['paye', 'uif', 'sdl'] as const)
    .filter((k) => cents(filed[k]) !== cents(certs[k]))
    .map((k) => `${k.toUpperCase()} ${cents(filed[k]).toFixed(2)} filed, ${cents(certs[k]).toFixed(2)} on the certificates`);
}

/**
 * Every comparison of a filed EMP201 with the certificates: 'March 2025: PAYE 4000.00 filed, 9000.00 on the certificates'.
 * Filed versions and one-month legacy rows per month; a multi-month legacy row once over the months it covers.
 */
export function emp201Mismatches(f: Emp501Filings): string[] {
  const out: string[] = [];
  for (const m of f.months) {
    if (m.emp201.kind !== 'version') continue;
    const d = differences(versionTotals(m.emp201.version), m.totals);
    if (d.length > 0) out.push(`${monthName(m.month)}: ${d.join(', ')}`);
  }
  for (const row of f.legacyRows) {
    if (!row.totals || !row.months.some((m) => f.certificates.has(m))) continue;
    const d = differences(row.totals, certificateTotalsOf(f, row.months));
    if (d.length > 0) out.push(`${monthsName(row.months)}${row.months.length > 1 ? ' (one EMP201)' : ''}: ${d.join(', ')}`);
  }
  return out;
}

/** Legacy rows the per-month check cannot judge as filed, and why. */
export function legacyWarnings(f: Emp501Filings): string[] {
  return f.legacyRows.filter((r) => r.months.some((m) => f.certificates.has(m))).flatMap((r) => {
    const span = r.span > 1 ? `spans ${r.span} months` : null;
    const what = `EMP201 for ${monthsName(r.months)}`;
    if (!r.storedTotals) return [`${what} was filed before figures were stored (no stored totals${span ? `; ${span}` : ''}); not cross-checked`];
    if (!r.totals) return [`${what} ${span ?? 'spans 1 month'}, some of them outside this return or filed again since; not cross-checked`];
    return span ? [`${what} ${span}; checked as one against those months' certificates`] : [];
  });
}

/**
 * The period's filed EMP201 totals: every filed current version, plus every legacy row at its stored totals, or, with
 * none stored, at its months' certificate totals (it adds no difference and hides none, review #1568 round 3).
 */
export function filedPeriodTotals(f: Emp501Filings): MonthTotals {
  const versions = f.filedVersions.reduce((t, v) => add(t, versionTotals(v)), ZERO);
  return f.legacyRows.reduce((t, r) => add(t, r.totals ?? certificateTotalsOf(f, r.months)), versions);
}
