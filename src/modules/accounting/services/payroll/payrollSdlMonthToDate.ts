/**
 * SDL as a month-to-date catch-up (wave 6 OC, review #1620 final breaker H; coordinator ruling replacing month
 * inheritance). SDLA s4(b) makes the levy due, or not, for the employer's month; the month's runs are paid one after
 * another, so each run settles the month to date, as UIF does:
 *
 *  1. Judge: liable when the month's estimate (estimateAnnualRemuneration: trailing history plus every run of the month
 *     to date, this one included) is over the threshold, OR an earlier FINAL run of the month was liable. Monotonic
 *     over FINAL runs only, so two runs that are not final never keep each other liable.
 *  2. Charge, at month level (FQd's breaker rulings, shared with FQd #1622): this run's SDL =
 *       liable ? 1% x (the FINAL runs' leviable + this run's leviable), rounded to the cent - the SDL the FINAL runs
 *       charged : 0,
 *     which may be NEGATIVE (a within-month refund: the floor is the month's, never the run's),
 *     split across this run's lines by leviable share (the cents left to the largest leviable, ties by employee id).
 *     So a run that tips the month carries the earlier runs' share, and a run recalculated after a reopen charges the
 *     month's remainder once, never twice.
 *  3. Nothing is ever reopened for SDL: an earlier final run keeps what it levied, and the month's EMP201 SDL is 1% of
 *     the month's leviable pay when the month is liable (each run settling the month to date).
 * An exempt run levies nothing.
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
  /** An earlier final run of the month was liable. */
  earlierLiable: boolean;
  /** The earlier final runs' leviable remuneration. */
  earlierLeviable: number;
  /** The SDL they charged. */
  earlierLevied: number;
}

export const NO_EARLIER_SDL: MonthToDateSdl = { earlierLiable: false, earlierLeviable: 0, earlierLevied: 0 };

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The month's final runs before `runId` in pay order (same company and month, any kind and frequency). */
export async function loadMonthToDateSdl(companyId: string, runId: string): Promise<MonthToDateSdl> {
  const rows = (await sql`
    SELECT COALESCE(bool_or(l.sdl_exempt = false), false) AS liable,
           COALESCE(SUM(COALESCE(l.sdl_leviable, 0)), 0)::float8 AS leviable,
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
  return r ? { earlierLiable: r.liable === true, earlierLeviable: Number(r.leviable) || 0, earlierLevied: Number(r.levied) || 0 } : NO_EARLIER_SDL;
}

/**
 * This run's SDL, at month level: liable ? round(1% x (earlier final + this run's leviable)) - earlier final SDL : 0.
 * The floor is the MONTH's, not the run's (FQd delta 2): the result may be negative, a within-month refund when a run
 * the month was caught up on is corrected down, and the month's total stays exactly 1% of its leviable pay (>= 0).
 */
export function runSdlForMonth(liable: boolean, thisLeviable: number, m: MonthToDateSdl): number {
  if (!liable) return 0;
  return round2(round2((m.earlierLeviable + thisLeviable) * SDL_RATE) - m.earlierLevied);
}

/** Each line's share of `amount`, by its leviable amount; the cents left go to the largest leviable (ties: employee id). */
export function splitByLeviable(lines: Array<{ sdlLeviable: number; employeeId?: string }>, catchUp: number): number[] {
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
