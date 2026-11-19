/**
 * SDL as a month-to-date catch-up (wave 6 OC, review #1620 final breaker H; coordinator ruling replacing month
 * inheritance). SDLA s4(b) makes the levy due, or not, for the employer's month; the month's runs are paid one after
 * another, so each run settles the month to date, as UIF does:
 *
 *  1. Judge: liable when the month's estimate (estimateAnnualRemuneration: trailing history plus every run of the month
 *     to date, this one included) is over the threshold, OR an earlier final run of the month was already liable.
 *     The decision is monotonic within the month: once liable, every later run is liable.
 *  2. Charge: a liable run levies 1% of each of its own lines' leviable amount (rounded per line, as before), plus a
 *     catch-up: what the month's earlier FINAL runs would have levied had the month been liable when they ran, less what
 *     they did levy. So a run that tips the month into liability carries the earlier runs' share, split across its own
 *     lines by each line's leviable share (the largest remainder to the largest leviable, ties by employee id).
 *  3. Nothing is ever reopened for SDL: an earlier final run keeps what it levied, and the month's EMP201 SDL is the 1%
 *     of the month's leviable lines (each rounded to the cent).
 * An exempt run levies nothing and carries nothing; with no earlier final run, a run is costed exactly as before.
 * NAMED LIMIT: the catch-up sits on the lines of the run that tipped the month, so an employee's own 4142 (IRP5) can
 * carry another's share; the employer's EMP201 total is right. Scoped by company_id throughout.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { payRunFinalSql } from './payRunFinalSql';
import { runIsBeforeSql } from './payrollRunOrder';
import { SDL_RATE } from './sdlEngine';

/** The month's earlier final runs, as this run sees them. */
export interface MonthToDateSdl {
  /** An earlier final run of the month levied SDL (was liable). */
  earlierLiable: boolean;
  /** What the earlier final runs' lines would levy at 1% (each line rounded to the cent). */
  earlierDue: number;
  /** What they did levy. */
  earlierLevied: number;
}

export const NO_EARLIER_SDL: MonthToDateSdl = { earlierLiable: false, earlierDue: 0, earlierLevied: 0 };

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The month's final runs before `runId` in pay order (same company and month, any kind and frequency). */
export async function loadMonthToDateSdl(companyId: string, runId: string): Promise<MonthToDateSdl> {
  const rows = (await sql`
    SELECT COALESCE(bool_or(l.sdl_exempt = false), false) AS liable,
           COALESCE(SUM(ROUND(COALESCE(l.sdl_leviable, 0) * ${SDL_RATE}, 2)), 0)::float8 AS due,
           COALESCE(SUM(l.sdl), 0)::float8 AS levied
      FROM payroll_run_headers me
      JOIN payroll_run_headers o ON o.company_id = me.company_id AND o.period_year = me.period_year
       AND o.period_month = me.period_month AND o.id <> me.id
      JOIN payroll_run_lines l ON l.run_id = o.id
     WHERE me.id = ${runId}::uuid AND me.company_id = ${companyId}::uuid
       AND ${sql.unsafe(payRunFinalSql('o'))}
       AND ${runIsBeforeSql('o', companyId, runId)}
  `) as DbRow[];
  const r = rows[0];
  return r ? { earlierLiable: r.liable === true, earlierDue: Number(r.due) || 0, earlierLevied: Number(r.levied) || 0 } : NO_EARLIER_SDL;
}

/** Each line's share of `catchUp`, by its leviable amount; the cents left go to the largest leviable (ties: employee id). */
export function splitCatchUp(lines: Array<{ sdlLeviable: number; employeeId?: string }>, catchUp: number): number[] {
  const out = lines.map(() => 0);
  if (lines.length === 0 || round2(catchUp) === 0) return out;
  const order = lines.map((l, i) => i)
    .sort((a, b) => (lines[b]!.sdlLeviable - lines[a]!.sdlLeviable) || String(lines[a]!.employeeId ?? '').localeCompare(String(lines[b]!.employeeId ?? '')) || a - b);
  const total = lines.reduce((t, l) => t + Math.max(0, l.sdlLeviable), 0);
  if (total <= 0) {
    out[order[0]!] = round2(catchUp);
    return out;
  }
  let given = 0;
  for (const i of order) {
    out[i] = round2((catchUp * Math.max(0, lines[i]!.sdlLeviable)) / total);
    given = round2(given + out[i]!);
  }
  out[order[0]!] = round2(out[order[0]!]! + round2(catchUp - given));
  return out;
}
