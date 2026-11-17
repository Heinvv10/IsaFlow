/**
 * What is left to settle when a pre-reopen salary file was confirmed (the bank paid it) and the run was approved again
 * with other figures (review #1524 D-3/E-5). Per EMPLOYEE, never netted across employees: each employee's current
 * approved net less what the file paid them (payroll_bank_file_items). An employee new to the run is owed in full; one
 * no longer on it was overpaid in full. Owed and overpaid are reported apart, so an employee who is owed money is never
 * hidden behind another's overpayment. Read-only.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export interface SettlementEntry {
  employeeNumber: string;
  name: string;
  cents: number;
}

export interface FileSettlement {
  /** Sum still to pay, and to whom (each positive). */
  owedCents: number;
  owedTo: SettlementEntry[];
  /** Sum overpaid, and by whom (each positive). */
  overpaidCents: number;
  overpaidBy: SettlementEntry[];
}

export async function fileSettlement(companyId: string, runId: string, fileId: string): Promise<FileSettlement> {
  const rows = (await sql`
    WITH cur AS (
      SELECT l.employee_id, round(l.net_pay * 100)::bigint AS cents
        FROM payroll_run_lines l JOIN payroll_run_headers h ON h.id = l.run_id AND h.company_id = ${companyId}::uuid
       WHERE l.run_id = ${runId}::uuid
    ), paid AS (
      SELECT i.employee_id, i.amount_cents AS cents FROM payroll_bank_file_items i
       WHERE i.file_id = ${fileId}::uuid AND i.company_id = ${companyId}::uuid
    )
    SELECT e.employee_number, e.first_name, e.last_name, (COALESCE(cur.cents, 0) - COALESCE(paid.cents, 0))::text AS diff
      FROM cur FULL JOIN paid ON paid.employee_id = cur.employee_id
      JOIN payroll_employees e ON e.id = COALESCE(cur.employee_id, paid.employee_id) AND e.company_id = ${companyId}::uuid
     WHERE COALESCE(cur.cents, 0) <> COALESCE(paid.cents, 0)
     ORDER BY e.employee_number
  `) as DbRow[];
  const out: FileSettlement = { owedCents: 0, owedTo: [], overpaidCents: 0, overpaidBy: [] };
  for (const r of rows) {
    const diff = Number(r.diff);
    const entry = { employeeNumber: String(r.employee_number), name: `${String(r.first_name)} ${String(r.last_name)}`, cents: Math.abs(diff) };
    if (diff > 0) { out.owedCents += diff; out.owedTo.push(entry); } else { out.overpaidCents -= diff; out.overpaidBy.push(entry); }
  }
  return out;
}
