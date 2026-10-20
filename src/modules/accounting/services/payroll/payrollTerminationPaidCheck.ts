/**
 * Has another run already paid an employee's termination pay-outs (leave,
 * notice, severance)? Read by calculatePayrollRun, which then leaves them out
 * (findPaidTerminationRun), and by the approval gate, which refuses a run still
 * carrying them (findTerminationsPaidElsewhere). Audit 2026-10-18 P4.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { readJournalChain } from './payrollJournalChain';

/**
 * A run line that carries a synthetic termination component (see LEAVE_PAY,
 * NOTICE_PAY, SEVERANCE_PAY). Severance paid under a SARS directive
 * (SEVERANCE_DIRECTIVE_COMPONENT_ID, audit 2026-10-18 P3) is deliberately not
 * one: its second payment is refused by the directive's own claim
 * (payrollRunDirectiveClaim), and counting it here would make the approved
 * severance-only run after a final pay strip the leave and notice pay from that
 * final run when it is reopened and recalculated.
 */
const TERMINATION_LINE = '$[*] ? (@.componentId starts with "synthetic:termination:")';

/**
 * Whether a run's pay is out: approved or paid (whose journal cannot be
 * reversed, payrollJournalReversalGuard), or reopened with a journal its
 * reversal chain leaves in the ledger. A link alone is not enough: a reversed
 * journal stays linked (payrollJournalChain). A linked journal this company
 * cannot read counts as paid, as the approval gate refuses it
 * (`posted_journal_not_live`): a broken link must not release a second
 * pay-out. `inForce` caches each journal's chain read for one call.
 */
export async function runHasPaid(
  companyId: string, status: string, journalId: unknown, inForce: Map<string, Promise<boolean>>,
): Promise<boolean> {
  if (status === 'approved' || status === 'paid') return true;
  if (journalId == null) return false;
  const id = String(journalId);
  const cached = inForce.get(id);
  if (cached) return cached;
  const read = readJournalChain(companyId, id).then(chain => chain == null || chain.state !== 'out');
  inForce.set(id, read);
  return read;
}

/**
 * The period of another run that already paid this employee's termination
 * components (runHasPaid), or null. An end date moved into a later month after
 * the final pay went out must not pay leave, notice and severance again.
 * Nothing reinstates or re-hires a terminated employee today; a re-hire path
 * would need this to ignore runs before the re-hire.
 */
export async function findPaidTerminationRun(
  companyId: string,
  employeeId: string,
  runId: string,
): Promise<{ year: number; month: number } | null> {
  const rows = (await sql`
    SELECT h.period_year, h.period_month, h.status, h.journal_entry_id
    FROM   payroll_run_lines   l
    JOIN   payroll_run_headers h ON h.id = l.run_id
    WHERE  h.company_id  = ${companyId}::uuid
      AND  l.employee_id = ${employeeId}::uuid
      AND  h.id         <> ${runId}::uuid
      AND  (h.status IN ('approved', 'paid') OR h.journal_entry_id IS NOT NULL)
      AND  jsonb_path_exists(l.component_breakdown, ${TERMINATION_LINE}::jsonpath)
    ORDER BY h.period_year, h.period_month
  `) as DbRow[];
  const inForce = new Map<string, Promise<boolean>>();
  for (const row of rows) {
    if (await runHasPaid(companyId, String(row.status), row.journal_entry_id, inForce)) {
      return { year: Number(row.period_year), month: Number(row.period_month) };
    }
  }
  return null;
}

/**
 * Lines of `runId` paying termination components that another run has already
 * paid (runHasPaid): two runs calculated before either was approved both
 * carry them, and the calculation-time check (findPaidTerminationRun) saw
 * neither. The approval gate refuses such a run until it is recalculated.
 */
export async function findTerminationsPaidElsewhere(
  companyId: string,
  runId: string,
): Promise<Array<{ employeeNumber: string; year: number; month: number }>> {
  const rows = (await sql`
    SELECT DISTINCT e.employee_number, h2.period_year, h2.period_month, h2.status, h2.journal_entry_id
    FROM   payroll_run_lines   l
    JOIN   payroll_run_headers h  ON h.id  = l.run_id
    JOIN   payroll_employees   e  ON e.id  = l.employee_id AND e.company_id = h.company_id
    JOIN   payroll_run_lines   l2 ON l2.employee_id = l.employee_id AND l2.run_id <> l.run_id
    JOIN   payroll_run_headers h2 ON h2.id = l2.run_id AND h2.company_id = h.company_id
    WHERE  h.id = ${runId}::uuid
      AND  h.company_id = ${companyId}::uuid
      AND  (h2.status IN ('approved', 'paid') OR h2.journal_entry_id IS NOT NULL)
      AND  jsonb_path_exists(l.component_breakdown,  ${TERMINATION_LINE}::jsonpath)
      AND  jsonb_path_exists(l2.component_breakdown, ${TERMINATION_LINE}::jsonpath)
    ORDER BY 1, 2, 3
  `) as DbRow[];
  const out: Array<{ employeeNumber: string; year: number; month: number }> = [];
  const inForce = new Map<string, Promise<boolean>>();
  for (const r of rows) {
    if (!await runHasPaid(companyId, String(r.status), r.journal_entry_id, inForce)) continue;
    const paid = { employeeNumber: String(r.employee_number), year: Number(r.period_year), month: Number(r.period_month) };
    if (!out.some(o => o.employeeNumber === paid.employeeNumber && o.year === paid.year && o.month === paid.month)) out.push(paid);
  }
  return out;
}
