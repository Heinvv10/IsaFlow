/**
 * EMP501 legacy-EMP201 naming and the conflict scan outside the return (wave 6 EFb, review #1568 rounds 5-6). Split
 * out of emp501Months.ts (file size); emp501Months re-exports the names.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { Emp501Period } from '@/modules/accounting/services/payroll/emp501Period';
import type { LegacyEmp201 } from './emp501Months';

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

/**
 * Conflicts in the months a loaded legacy row covers OUTSIDE the return (review #1568 round 6): its full span is
 * compared with the certificates, so a month there that another submitted/accepted legacy row, or a lifecycle EMP201
 * version, also files is the same conflict as one inside the return. Range: the union of the loaded rows' spans.
 */
export async function conflictsOutsideReturn(companyId: string, p: Emp501Period, loaded: LegacyEmp201[]): Promise<string[]> {
  if (loaded.length === 0) return [];
  const lo = loaded.map((r) => r.start).sort()[0]!;
  const hi = loaded.map((r) => r.end).sort().at(-1)!;
  if (lo >= p.start && hi <= p.end) return [];
  const legacy = (await sql`
    SELECT to_char(m.month, 'YYYY-MM') AS month, s.id, s.period_start::TEXT AS ps, s.period_end::TEXT AS pe, s.submission_reference AS ref
    FROM generate_series(date_trunc('month', ${lo}::DATE), ${hi}::DATE, INTERVAL '1 month') AS m(month)
    JOIN sars_submissions s
      ON s.company_id = ${companyId}::UUID AND s.form_type = 'EMP201' AND s.status IN ('submitted', 'accepted')
     AND s.period_start <= m.month AND s.period_end >= (m.month + INTERVAL '1 month' - INTERVAL '1 day')::DATE
     AND NOT EXISTS (SELECT 1 FROM tax_return_versions t WHERE t.company_id = s.company_id AND t.sars_submission_id = s.id)
    WHERE m.month < ${p.start}::DATE OR m.month > ${p.end}::DATE
    ORDER BY m.month, s.period_start, s.period_end, s.id
  `) as DbRow[];
  const versions = (await sql`
    SELECT DISTINCT ON (period_start) to_char(period_start, 'YYYY-MM') AS month, version_no, status FROM tax_return_versions
    WHERE company_id = ${companyId}::UUID AND form_type = 'EMP201' AND status <> 'superseded'
      AND period_start BETWEEN date_trunc('month', ${lo}::DATE) AND ${hi}::DATE
      AND (period_start < ${p.start}::DATE OR period_start > ${p.end}::DATE)
    ORDER BY period_start, version_no DESC
  `) as DbRow[];
  const ids = new Set(loaded.map((r) => r.id));
  const byMonth = new Map<string, DbRow[]>();
  for (const r of legacy) byMonth.set(String(r.month), [...(byMonth.get(String(r.month)) ?? []), r]);
  const version = new Map(versions.map((v) => [String(v.month), v]));
  const out: string[] = [];
  for (const month of [...new Set([...byMonth.keys(), ...version.keys()])].sort()) {
    const rs = byMonth.get(month) ?? [];
    if (!rs.some((r) => ids.has(String(r.id)))) continue; // only a month a row reaching into the return files
    const v = version.get(month);
    const names = rs.map((r) => rowName({ start: String(r.ps), end: String(r.pe), reference: r.ref == null ? null : String(r.ref) }));
    if (v) names.push(`the return-lifecycle EMP201 version ${Number(v.version_no)} (${String(v.status)})`);
    if (names.length > 1) out.push(`${names.join(' and ')} both file ${monthName(month)}`);
  }
  return out;
}

