/**
 * The natural-language query tables that hold one person's pay (#1656, round 6). A person without Payroll read (a manager whose Payroll
 * is unticked, or whose Approve is withheld) is not shown them in the prompt, and a generated query that touches one is refused 403 after
 * validation: the allowlist only says what the model may query, not who may read it.
 */
import type { SchemaTable } from './nlQueryService';

/** SCHEMA_TABLES that carry per-employee pay. */
export const PAYROLL_NL_TABLES: ReadonlySet<string> = new Set(['employees', 'payslips']);

export const withoutPayrollTables = (tables: SchemaTable[]): SchemaTable[] => tables.filter((t) => !PAYROLL_NL_TABLES.has(t.name));

/** Does this (validated) SQL name a payroll-detail table, as a word, in any clause? Over-matches on purpose: it only ever refuses. */
export function sqlTouchesPayrollTables(sql: string): boolean {
  return /\b(employees|payslips|payroll_[a-z_]+|irp5[a-z_]*|emp201[a-z_]*)\b/i.test(sql);
}
