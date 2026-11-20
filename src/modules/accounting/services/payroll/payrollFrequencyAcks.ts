/**
 * Every acknowledged pay-frequency change at one frequency (wave 6 FQd, breaker #1622 M-F; coordinator ruling): the
 * straddle and the create judge a run against ALL of an employee's acknowledgements, not only the first run's:
 *   (1) once a FINAL run at the new frequency holds an acknowledgement, no run at that frequency starting before it is
 *       created or calculated for that employee (its once-off settled those days already);
 *   (2) a run never pays the days ANY acknowledgement settled with a once-off.
 * An acknowledgement is an audit_log row (entity STRADDLE_ENTITY, the run's id; metadata employeeId, oldEnd, start, end).
 */
import { sql } from '@/lib/neon';
import type { DbRow, TxSql } from '@/lib/neon';
import { payRunFinalSql } from './payRunFinalSql';
import { dateColumnOf } from './payrollFrequency';
import { dayNumber, isoOfDay } from './payFrequencyPeriods';
import { formatDay, formatDayRange } from './payrollPayWeek';
import { employeeName, STRADDLE_ENTITY } from './payrollFrequencyStraddle';

export interface StraddleAck {
  runId: string;
  employeeId: string;
  employeeName: string;
  /** The acknowledged run's dates, and whether it is final (approved under the approval rule). */
  runStart: string;
  runEnd: string;
  final: boolean;
  /** As acknowledged: the old frequency's last paid day, and the run's dates then. */
  oldEnd: string;
  start: string;
  end: string;
}

/**
 * The acknowledgements on non-cancelled regular runs at `frequency`, for `employeeIds`, or (null) for every employee
 * paid at `frequency` now (a create, which has no lines yet). Read-only.
 */
export async function straddleAcks(db: TxSql, companyId: string, frequency: string, employeeIds: string[] | null): Promise<StraddleAck[]> {
  const ids = employeeIds ?? [];
  const rows = (await db`
    SELECT a.entity_id::text AS run_id, e.id::text AS employee_id, e.first_name, e.last_name,
           to_char(h.period_start, 'YYYY-MM-DD') AS run_start, to_char(h.period_end, 'YYYY-MM-DD') AS run_end,
           (${sql.unsafe(payRunFinalSql('h'))}) AS final,
           a.changes->'metadata'->>'oldEnd' AS old_end, a.changes->'metadata'->>'start' AS ack_start,
           a.changes->'metadata'->>'end' AS ack_end
      FROM audit_log a
      JOIN payroll_run_headers h ON h.id = a.entity_id AND h.company_id = ${companyId}::uuid
      JOIN payroll_employees e ON e.id::text = a.changes->'metadata'->>'employeeId' AND e.company_id = ${companyId}::uuid
     WHERE a.company_id = ${companyId}::uuid AND a.entity_type = ${STRADDLE_ENTITY}
       AND h.run_kind = 'regular' AND h.status <> 'cancelled' AND h.pay_frequency = ${frequency}
       AND ((${employeeIds === null}::boolean AND e.pay_frequency = ${frequency}) OR e.id = ANY(${ids}::uuid[]))
     ORDER BY h.period_start, a.entity_id
  `) as DbRow[];
  return rows.map((r) => ({
    runId: String(r.run_id), employeeId: String(r.employee_id), employeeName: employeeName(r),
    runStart: String(dateColumnOf(r.run_start)), runEnd: String(dateColumnOf(r.run_end)), final: r.final === true,
    oldEnd: String(r.old_end), start: String(r.ack_start), end: String(r.ack_end),
  }));
}

/** (1) The FINAL acknowledged run a run of these dates would come before, for the change it pays after; or none. */
export function acknowledgedLater(acks: StraddleAck[], start: string, end: string): StraddleAck | undefined {
  return acks.find((k) => k.final && k.runStart > start && end > k.oldEnd);
}

/** The days the acknowledgement's once-off settled, inclusive: the gap it left, or the days its run paid twice. */
export function settledDays(k: StraddleAck): { from: number; to: number } {
  const ackStart = dayNumber(k.start);
  const ackLast = dayNumber(k.oldEnd);
  return ackStart > ackLast + 1 ? { from: ackLast + 1, to: ackStart - 1 } : { from: ackStart, to: Math.min(ackLast, dayNumber(k.end)) };
}

/** (2) The first acknowledgement whose settled days these dates pay, with those days; or none. */
export function settledOverlap(acks: StraddleAck[], start: string, end: string): { ack: StraddleAck; from: string; to: string } | undefined {
  for (const ack of acks) {
    const s = settledDays(ack);
    const from = Math.max(s.from, dayNumber(start));
    const to = Math.min(s.to, dayNumber(end));
    if (from <= to) return { ack, from: isoOfDay(from), to: isoOfDay(to) };
  }
  return undefined;
}

/** The sentence for (1): the employee, the acknowledged run, and why this run cannot come before it. */
export function acknowledgedLaterDetail(k: StraddleAck, frequency: string, start: string): string {
  return `${k.employeeName}'s change to ${frequency} pay was acknowledged on the approved ${frequency} run for `
    + `${formatDayRange(k.runStart, k.runEnd)}, whose once-off settled the days before it. A ${frequency} run starting `
    + `${formatDay(start)} comes before that run and would pay those days again.`;
}
