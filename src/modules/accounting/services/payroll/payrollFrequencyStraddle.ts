/**
 * A pay-frequency change at the boundary between two frequencies (wave 6 FQd, breaker #1622 M2; Hein ruling 2026-11-19:
 * REFUSE plus a once-off, no pro-rata engine; pro-rata is wave 7).
 *
 * An employee's first REGULAR run at a new frequency should start the day after the last day their old frequency paid
 * (the end of their last FINAL regular run at another frequency). It rarely does: a Monday-Sunday week straddles
 * 1 March, a calendar month never starts on a Monday. So, for each employee on the run:
 *   - the run starts on or before that day: the days from its start to it are paid twice (overlap);
 *   - the run starts more than a day after it: the days between are paid by nobody (gap).
 * Either is refused at calculate, in the MCP dry run (assertFrequencyCostable) and at approve (approval gate), 409
 * FREQUENCY_CHANGE_STRADDLE, naming the exact days and saying to settle them with a once-off adjustment, until an owner
 * or admin acknowledges them for that run and employee. The acknowledgement is one audit_log row (append-only for the
 * app; entity `payroll_run_frequency_change`, the run's id) carrying the exact days; it clears only those days, so a
 * changed period or a later old-frequency run needs a new one.
 * Not judged: an employee with no final run at another frequency, or already paid (finally) at this frequency after the
 * old one ended (the change happened on an earlier run); off-cycle runs.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { payRunFinalSql } from './payRunFinalSql';
import { dateColumnOf } from './payrollFrequency';
import { dayNumber, isoOfDay } from './payFrequencyPeriods';
import type { RunKindReason } from './payrollRunKindGuard';
import { formatDay, formatDayRange } from './payrollPayWeek';

/** An employee's name as the user reads it ("Wendy Weekly"), from a row with first_name and last_name. */
export function employeeName(r: DbRow): string {
  return [r.first_name, r.last_name].filter((p) => p != null && String(p).trim() !== '').map(String).join(' ') || 'This employee';
}

export const STRADDLE_ENTITY = 'payroll_run_frequency_change';

export interface FrequencyStraddle {
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  oldFrequency: string;
  /** The last day the old frequency paid. */
  oldEnd: string;
  /** This run's first day. */
  start: string;
  /** Days paid twice, inclusive; null when none. */
  overlap: { from: string; to: string } | null;
  /** Days paid by nobody, inclusive; null when none. */
  gap: { from: string; to: string } | null;
  acknowledged: boolean;
  /** What the user reads: the exact days, plain words, the once-off (straddleDetail). */
  message: string;
}

/** The run as the straddle reads it: its id (null in a preview with no run), frequency and dates. */
export interface StraddleRun { id: string | null; frequency: string; start: string; end: string }

/**
 * Every employee of `employeeIds` whose first run at `run.frequency` this is, and whose start is not the day after the
 * old frequency's last paid day. Read-only.
 */
export async function frequencyStraddles(companyId: string, run: StraddleRun, employeeIds: string[]): Promise<FrequencyStraddle[]> {
  if (employeeIds.length === 0) return [];
  const rows = (await sql`
    WITH last_old AS (
      SELECT DISTINCT ON (l.employee_id) l.employee_id, h.pay_frequency, h.period_end
        FROM payroll_run_lines l
        JOIN payroll_run_headers h ON h.id = l.run_id
       WHERE h.company_id = ${companyId}::uuid AND h.run_kind = 'regular' AND ${sql.unsafe(payRunFinalSql('h'))}
         AND h.pay_frequency <> ${run.frequency} AND h.period_start <= ${run.end}::date
         AND l.employee_id = ANY(${employeeIds}::uuid[])
       ORDER BY l.employee_id, h.period_end DESC
    )
    SELECT o.employee_id, e.employee_number, e.first_name, e.last_name, o.pay_frequency, to_char(o.period_end, 'YYYY-MM-DD') AS old_end
      FROM last_old o
      JOIN payroll_employees e ON e.id = o.employee_id AND e.company_id = ${companyId}::uuid
     WHERE NOT EXISTS (
       SELECT 1 FROM payroll_run_lines l2 JOIN payroll_run_headers h2 ON h2.id = l2.run_id
        WHERE h2.company_id = ${companyId}::uuid AND h2.run_kind = 'regular' AND ${sql.unsafe(payRunFinalSql('h2'))}
          AND h2.pay_frequency = ${run.frequency} AND l2.employee_id = o.employee_id
          AND h2.period_start > o.period_end AND h2.id IS DISTINCT FROM ${run.id}::uuid)
  `) as DbRow[];
  const acks = run.id === null ? [] : (await sql`
    SELECT changes FROM audit_log
     WHERE company_id = ${companyId}::uuid AND entity_type = ${STRADDLE_ENTITY} AND entity_id = ${run.id}::uuid
  `) as DbRow[];
  const start = dayNumber(run.start);
  const end = dayNumber(run.end);
  const out: FrequencyStraddle[] = [];
  for (const r of rows) {
    const oldEnd = String(dateColumnOf(r.old_end));
    const last = dayNumber(oldEnd);
    if (start === last + 1) continue;
    const overlap = start <= last ? { from: run.start, to: isoOfDay(Math.min(last, end)) } : null;
    const gap = start > last + 1 ? { from: isoOfDay(last + 1), to: isoOfDay(start - 1) } : null;
    const employeeId = String(r.employee_id);
    const acknowledged = acks.some((a) => {
      const c = ((a.changes as { metadata?: Record<string, unknown> } | null)?.metadata ?? {});
      return c.employeeId === employeeId && c.oldEnd === oldEnd && c.start === run.start && c.end === run.end;
    });
    const found = {
      employeeId, employeeNumber: String(r.employee_number), employeeName: employeeName(r), oldFrequency: String(r.pay_frequency),
      oldEnd, start: run.start, overlap, gap, acknowledged,
    };
    out.push({ ...found, message: straddleDetail(found, run.frequency) });
  }
  return out;
}

/** The sentence for one straddle (review #1622 UI M2): the name, the exact days in plain words, and what to do. */
export function straddleDetail(s: Omit<FrequencyStraddle, 'message'>, frequency: string): string {
  const d = s.overlap ?? s.gap!;
  const one = d.from === d.to;
  const what = `${formatDayRange(d.from, d.to)} would ${s.overlap ? 'be paid twice' : 'not be paid'}`;
  return `${s.employeeName} was last paid ${s.oldFrequency} up to ${formatDay(s.oldEnd)}, and this ${frequency} run starts on `
    + `${formatDay(s.start)}: ${what}. Settle ${one ? 'that day' : 'those days'} with a once-off adjustment, then acknowledge the `
    + 'change on this run (an owner or admin).';
}

/** The refusal's reasons for the unacknowledged straddles (none: nothing refused). */
export function straddleReasons(straddles: FrequencyStraddle[], frequency: string): RunKindReason[] {
  return straddles.filter((s) => !s.acknowledged)
    .map((s) => ({ clause: 'frequency_straddle' as const, detail: straddleDetail(s, frequency) }));
}

/**
 * At approval (runLinesRefusal): the run's line employees' unacknowledged straddles, as a journal-plan refusal; null
 * when none or not a regular run. Catches a run costed before the old frequency's last run was approved.
 */
export async function straddleRefusal(companyId: string, runId: string, employeeIds: string[]): Promise<{ code: string; detail: string } | null> {
  const head = ((await sql`
    SELECT pay_frequency, run_kind, to_char(period_start, 'YYYY-MM-DD') AS start, to_char(period_end, 'YYYY-MM-DD') AS stop
      FROM payroll_run_headers WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
  `) as DbRow[])[0];
  if (!head || head.run_kind !== 'regular' || head.start == null || head.stop == null) return null;
  const frequency = String(head.pay_frequency);
  const reasons = straddleReasons(
    await frequencyStraddles(companyId, { id: runId, frequency, start: String(head.start), end: String(head.stop) }, employeeIds), frequency);
  return reasons.length === 0 ? null : { code: 'frequency_change_straddle', detail: reasons.map((r) => r.detail).join(' ') };
}
