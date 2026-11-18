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
 *  - a legacy row with stored totals: once, against the certificates over its WHOLE span, inside the return or not;
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
  /** Its submission reference, to name it. */
  reference: string | null;
  /** Its own period (YYYY-MM-DD), which may reach outside the return (a Feb-Mar row across the tax-year boundary). */
  start: string;
  end: string;
  /** The months of this return it files (no current version), YYYY-MM. */
  months: string[];
  /** Its own span in months (start to end). */
  span: number;
  /** The totals it stored (form_data totalPAYE/UIF/SDL), or null for an older row that stored none. */
  stored: MonthTotals | null;
  /** The certificate totals over its WHOLE span, inside the return or not (set when it stored totals). */
  spanCertificates: MonthTotals | null;
  /** Its months are all in this return and none was filed again: its stored totals are its share of the period sum. */
  whole: boolean;
  /** Some of its months are in this return but were filed again through the lifecycle. */
  filedAgain: boolean;
  /** Its span reaches outside this return (a Feb-Mar row across the tax-year boundary). */
  outside: boolean;
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
  /**
   * Months of the return (no current version) filed by more than one legacy row: 'March 2025 to April 2025 (reference
   * X) and April 2025 (reference Y) both file April 2025'. Which one SARS holds cannot be told, so this refuses.
   */
  conflicts: string[];
}

const ZERO: MonthTotals = { paye: 0, uif: 0, sdl: 0 };
export const cents = (n: number): number => Math.round(n * 100) / 100;
const add = (a: MonthTotals, b: MonthTotals): MonthTotals => ({ paye: cents(a.paye + b.paye), uif: cents(a.uif + b.uif), sdl: cents(a.sdl + b.sdl) });
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** 'June 2025' for '2025-06'. */
export const monthName = (ym: string): string => `${MONTH_NAMES[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
/** 'March 2025 to April 2025 (reference X)': a legacy row by its own span and reference. */
export function rowName(r: Pick<LegacyEmp201, 'start' | 'end' | 'reference'>): string {
  const span = [r.start.slice(0, 7), r.end.slice(0, 7)].filter((m, i, a) => a.indexOf(m) === i);
  return `${monthsName(span)} (reference ${r.reference ?? 'none'})`;
}

/** 'March 2025' or 'March 2025 to April 2025'. */
export const monthsName = (ms: string[]): string => (ms.length <= 1 ? monthName(ms[0] ?? '') : `${monthName(ms[0]!)} to ${monthName(ms[ms.length - 1]!)}`);

/** YYYY-MM -> what the certificates carry for the month: final run lines, plus standalone directive PAYE to an employee. */
async function monthTotals(companyId: string, p: { start: string; end: string }): Promise<Map<string, MonthTotals>> {
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
  // Every legacy row covering a period month (rows a version names are not legacy), newest first per month.
  const legacy = (await sql`
    SELECT to_char(m.month, 'YYYY-MM') AS month, s.id, s.period_start::TEXT AS ps, s.period_end::TEXT AS pe,
           s.submission_reference AS ref,
           s.form_data->'totalPAYE' AS paye, s.form_data->'totalUIF' AS uif, s.form_data->'totalSDL' AS sdl
    FROM generate_series(${p.start}::DATE, ${p.end}::DATE, INTERVAL '1 month') AS m(month)
    JOIN sars_submissions s
      ON s.company_id = ${companyId}::UUID AND s.form_type = 'EMP201' AND s.status IN ('submitted', 'accepted')
     AND s.period_start <= m.month AND s.period_end >= (m.month + INTERVAL '1 month' - INTERVAL '1 day')::DATE
     AND NOT EXISTS (SELECT 1 FROM tax_return_versions t WHERE t.company_id = s.company_id AND t.sars_submission_id = s.id)
    ORDER BY m.month, s.submitted_at DESC NULLS LAST, s.id
  `) as DbRow[];
  const rows = new Map<string, LegacyEmp201>();
  const byMonth = new Map<string, LegacyEmp201[]>();
  for (const r of legacy) {
    const month = String(r.month);
    if (versions.has(month)) continue; // the lifecycle version is the month's filing
    const id = String(r.id);
    let row = rows.get(id);
    if (!row) {
      const [paye, uif, sdl] = [num(r.paye), num(r.uif), num(r.sdl)];
      const [ps, pe] = [String(r.ps), String(r.pe)];
      const span = (Number(pe.slice(0, 4)) - Number(ps.slice(0, 4))) * 12 + Number(pe.slice(5, 7)) - Number(ps.slice(5, 7)) + 1;
      const stored = paye !== null && uif !== null && sdl !== null ? { paye: cents(paye), uif: cents(uif), sdl: cents(sdl) } : null;
      row = {
        id, reference: r.ref == null ? null : String(r.ref), start: ps, end: pe, months: [], span, stored, spanCertificates: null,
        whole: false, filedAgain: false, outside: ps < p.start || pe > p.end,
      };
      rows.set(id, row);
    }
    row.months.push(month);
    byMonth.set(month, [...(byMonth.get(month) ?? []), row]);
  }
  // A month two legacy rows file is a conflict (review #1568 round 5): refused, never resolved by picking one.
  const conflicts = [...byMonth.entries()].filter(([, rs]) => rs.length > 1).map(([month, rs]) =>
    `${[...rs].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end)).map(rowName).join(' and ')} both file ${monthName(month)}`);
  const legacyByMonth = new Map([...byMonth.entries()].map(([m, rs]) => [m, rs[0]!]));
  for (const row of rows.values()) {
    row.filedAgain = [...versions.keys()].some((m) => m >= row.start.slice(0, 7) && m <= row.end.slice(0, 7));
    row.whole = row.months.length === row.span;
    // Its stored totals are compared with the certificates over its whole span, inside this return or not (round 4):
    // a row reaching outside the return is never ignored.
    if (row.stored) row.spanCertificates = [...(await monthTotals(companyId, { start: row.start, end: row.end })).values()].reduce(add, ZERO);
  }
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
    conflicts,
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
    if (!row.stored || !row.spanCertificates) continue;
    const d = differences(row.stored, row.spanCertificates);
    const name = monthsName([row.start.slice(0, 7), row.end.slice(0, 7)].filter((m, i, a) => a.indexOf(m) === i));
    const label = [row.span > 1 ? 'one EMP201' : null, row.reference ? `reference ${row.reference}` : null].filter(Boolean).join(', ');
    if (d.length > 0) out.push(`${name}${label ? ` (${label})` : ''}: ${d.join(', ')}`);
  }
  return out;
}

/** Legacy rows the per-month check cannot judge as filed, and why. */
export function legacyWarnings(f: Emp501Filings): string[] {
  return f.legacyRows.filter((r) => r.months.some((m) => f.certificates.has(m))).flatMap((r) => {
    const span = r.span > 1 ? `spans ${r.span} months` : null;
    const what = `EMP201 for ${monthsName([r.start.slice(0, 7), r.end.slice(0, 7)].filter((m, i, a) => a.indexOf(m) === i))}`;
    if (!r.stored) return [`${what} was filed before figures were stored (no stored totals${span ? `; ${span}` : ''}); not cross-checked`];
    if (r.filedAgain) return [`${what} ${span ?? 'spans 1 month'}, some of them filed again since; checked as one against all its months' certificates`];
    // Only a span that truly reaches outside the return (never an in-return month another row shadows: a conflict).
    if (r.outside) return [`${what} ${span ?? 'spans 1 month'}, some of them outside this return; checked as one against all its months' certificates`];
    if (!r.whole) return [];
    return span ? [`${what} ${span}; checked as one against those months' certificates`] : [];
  });
}

/**
 * The period's filed EMP201 totals: every filed current version, plus every legacy row at its stored totals, or, with
 * none stored or a span reaching outside the return, at its months' certificate totals (review #1568 rounds 3-4).
 */
export function filedPeriodTotals(f: Emp501Filings): MonthTotals {
  const versions = f.filedVersions.reduce((t, v) => add(t, versionTotals(v)), ZERO);
  // A whole row at its stored totals; otherwise its months of this return at their certificates (a row reaching outside
  // the return is judged over its whole span by emp201Mismatches, so a difference there refuses before this sum).
  return f.legacyRows.reduce((t, r) => add(t, r.whole && r.stored ? r.stored : certificateTotalsOf(f, r.months)), versions);
}
