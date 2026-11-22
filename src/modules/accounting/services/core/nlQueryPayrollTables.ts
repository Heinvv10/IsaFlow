/**
 * The natural-language query tables that hold one person's pay (#1656, round 6). A person without Payroll read (a manager whose Payroll
 * is unticked, or whose Approve is withheld) is not shown them in the prompt, and a generated query that touches one is refused 403 after
 * validation: the allowlist only says what the model may query, not who may read it.
 */
import type { SchemaTable } from './nlQueryService';

/**
 * Every table on the NL allowlist (nlQueryValidationService ALLOWED_TABLES) that carries one person's pay or HR data: employees, their
 * payslips and leave, the payroll runs, and project_time_entries (a row per payroll EMPLOYEE with the rate typed for that person's hour:
 * hourly_rate, billable_amount; it may equal their cost rate).
 *
 * NOT here, by evidence (round 8): `time_entries`. Its `rate` is the price the logger TYPES for the hour billed (timeTrackingService: "the
 * logger TYPES the rate, which sets the price"), `applied_rate` / `line_total` come from the practice's rate tables, and the row names a
 * user, not a payroll employee: a charge-out price list, not pay. The MCP `list_time_entries` and the practice routes return the same
 * columns to Accounts readers by design. Likewise ACCEPTED (round 9): its status 'leave' rows and `notes` are the practice's own timesheet.
 * Decided by TABLE, never by column: a `*`, a whole-row reference (`SELECT t FROM ...`), `row_to_json(t)` or `to_jsonb(t)` returns
 * every column whatever the query names, so a column match would miss them. Anyone adding an allowlisted table that holds a rate, a
 * salary or an employee's details adds it here (tests/unit/services/core/nlQueryPayrollTables.test.ts pins every allowlisted table
 * to a decision).
 */
export const PAYROLL_NL_TABLES: ReadonlySet<string> = new Set([
  'employees', 'payslips', 'payroll_runs', 'leave_balances', 'leave_applications', 'project_time_entries',
]);

export const withoutPayrollTables = (tables: SchemaTable[]): SchemaTable[] => tables.filter((t) => !PAYROLL_NL_TABLES.has(t.name));

/** Tables named by a prefix (payroll_*, irp5*, emp201*): not on the allowlist today, refused should one ever be. */
const PAYROLL_NL_PATTERN = new RegExp(`\\b(?:${[...PAYROLL_NL_TABLES].join('|')}|payroll_[a-z_]+|irp5[a-z_]*|emp201[a-z_]*)\\b`, 'i');

/**
 * Does this (validated) SQL name a table that carries employee pay or HR data, as a word, in any clause (a schema prefix, quotes, an
 * alias, a CTE, a subquery included)? Over-matches on purpose: it only ever refuses.
 */
export function sqlTouchesPayrollTables(sql: string): boolean {
  return PAYROLL_NL_PATTERN.test(sql);
}
