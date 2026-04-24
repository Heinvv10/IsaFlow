/**
 * Employee change-log writer + reader (mig 452).
 *
 * recordEmployeeChange is a no-op when old === new (including null === null),
 * so callers can invoke it unconditionally from UPDATE paths without
 * producing spurious audit rows. The DB also carries a
 * CHECK (old_value IS DISTINCT FROM new_value) as a belt-and-braces.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export interface RecordChangeInput {
  companyId: string;
  employeeId: string;
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
  userId: string;
  effectiveFrom?: string;
  changeReason?: string;
}

export interface EmployeeHistoryEntry {
  id: string;
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
  effectiveFrom: string;
  changeReason: string | null;
  changedBy: string | null;
  changedByName: string | null;
  createdAt: Date;
}

export async function recordEmployeeChange(input: RecordChangeInput): Promise<void> {
  if (input.oldValue === input.newValue) return;

  await sql`
    INSERT INTO payroll_employee_history
      (company_id, employee_id, field_name, old_value, new_value, effective_from, change_reason, changed_by)
    VALUES (
      ${input.companyId}::uuid,
      ${input.employeeId}::uuid,
      ${input.fieldName},
      ${input.oldValue},
      ${input.newValue},
      COALESCE(${input.effectiveFrom ?? null}::date, CURRENT_DATE),
      ${input.changeReason ?? null},
      ${input.userId}
    )
  `;
}

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

function asDateString(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

export async function listEmployeeHistory(
  companyId: string,
  employeeId: string,
): Promise<EmployeeHistoryEntry[]> {
  const rows = (await sql`
    SELECT h.id,
           h.field_name,
           h.old_value,
           h.new_value,
           h.effective_from,
           h.change_reason,
           h.changed_by,
           u.first_name || ' ' || u.last_name AS changed_by_name,
           h.created_at
      FROM payroll_employee_history h
      LEFT JOIN users u ON u.id = h.changed_by
     WHERE h.company_id = ${companyId}::uuid
       AND h.employee_id = ${employeeId}::uuid
     ORDER BY h.effective_from DESC, h.created_at DESC
  `) as DbRow[];

  return rows.map(r => ({
    id: String(r.id),
    fieldName: String(r.field_name),
    oldValue: r.old_value == null ? null : String(r.old_value),
    newValue: r.new_value == null ? null : String(r.new_value),
    effectiveFrom: asDateString(r.effective_from),
    changeReason: r.change_reason == null ? null : String(r.change_reason),
    changedBy: r.changed_by == null ? null : String(r.changed_by),
    changedByName: r.changed_by_name == null ? null : String(r.changed_by_name),
    createdAt: toDate(r.created_at),
  }));
}
