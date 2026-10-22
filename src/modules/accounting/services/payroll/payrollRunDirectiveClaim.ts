/**
 * A run CLAIMS the severance directives its lines pay when it is approved, in
 * the directive's one tax_directive_payments row (UNIQUE (company_id,
 * tax_directive_id), migration 403; payroll_run_id, migration 901). Audit
 * 2026-10-18 P3. Calculation claims nothing, so a draft, recalculated or never
 * approved, leaves the directive free; a reopened run keeps its claim (its
 * journal is still in the ledger), and approving it again refreshes the claim
 * or, when the line has gone, releases it.
 *
 * The gate also refuses a run that pays a lump sum (39xx) under no directive
 * (`lump_sum_without_directive`): the calculator deducts no PAYE from one
 * (payeTreatment), and paragraph 9(3) of the Fourth Schedule requires the
 * directive before it is paid (SARS PAYE-GEN-01-G21 (2027) p. 22).
 *
 * Refused (PayrollApprovalRefusedError, nothing written) when a line's
 * directive is no longer approved, no longer carries the figures the line was
 * calculated with, or was paid by something else: the stand-alone payment
 * (taxDirectivePaymentService) or another run.
 *
 * LOCK ORDER. approvePayrollRun takes the company approval lock, the run
 * header, the linked journal's chain (payrollRunLock), and then this: the
 * directive rows FOR SHARE, then the payment row (the INSERT's unique-index
 * wait on a peer's uncommitted row). applyTaxDirective takes the directive row
 * FOR SHARE (compatible with this one), then the payment row, and then posts a
 * new journal, which touches no payroll header and no run journal, so the two
 * cannot wait on each other in a cycle: whichever inserts first wins, the
 * other waits on the row and is then refused. updateTaxDirective (a cancel)
 * takes the directive row FOR UPDATE and nothing after it, so it waits for a
 * claim in flight and is then refused, or a claim waits for it and then reads
 * the new status. calculatePayrollRun takes no directive row; it only DELETEs
 * stand-alone payment rows whose journal chain is undone
 * (releaseReversedStandalonePayment), under its own run header and after its
 * loan work, and takes nothing after that which an approval holds, so an
 * approval's claim of the same directive merely waits for it. All waits are
 * bounded at 5s (withBoundedLockWait, claimUnderLockTimeout). Race tests:
 * tests/integration/p3-severance-directive-race.int.test.ts,
 * tests/integration/p3fu-directive-cancel-guard.int.test.ts.
 */

import type { DbRow, TxSql } from '@/lib/neon';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { withBoundedLockWait } from './payrollRunLock';
import { PayrollApprovalRefusedError } from './payrollApprovalRefusal';
import type { PayrollJournalNote } from './payrollJournalBuilder';
import {
  directivePaye, findHandMadeLumpSumPaid, findSeveranceDirectiveForRun, SEVERANCE_DIRECTIVE_COMPONENT_ID,
} from './payrollSeveranceDirective';

interface DirectiveLine {
  employeeNumber: string;
  directiveId: string;
  gross: number;
  paye: number;
}

const cents = (n: number): number => Math.round(n * 100);

async function directiveLines(q: TxSql | typeof sql, companyId: string, runId: string): Promise<DirectiveLine[]> {
  const rows = (await q`
    SELECT e.employee_number, item->>'amount' AS gross, item->'directive'->>'id' AS directive_id,
           item->'directive'->>'paye' AS paye
    FROM payroll_run_lines l
    JOIN payroll_run_headers h ON h.id = l.run_id
    JOIN payroll_employees e ON e.id = l.employee_id AND e.company_id = h.company_id
    CROSS JOIN LATERAL jsonb_array_elements(l.component_breakdown) AS item
    WHERE h.id = ${runId}::uuid AND h.company_id = ${companyId}::uuid
      AND item->>'componentId' = ${SEVERANCE_DIRECTIVE_COMPONENT_ID}
    ORDER BY directive_id
  `) as DbRow[];
  return rows.map(r => ({
    employeeNumber: String(r.employee_number),
    directiveId: String(r.directive_id),
    gross: Number(r.gross),
    paye: Number(r.paye),
  }));
}

/** Why `line` cannot be paid by `runId`, or null. `dir` is the directive row with its payment, if any. */
function refusal(line: DirectiveLine, dir: DbRow | undefined, runId: string): string | null {
  const who = `the severance for ${line.employeeNumber}`;
  if (!dir || dir.status !== 'approved' || dir.directive_type !== 'severance') {
    return `${who}: its SARS directive is no longer approved. Recalculate the run; it then leaves the severance out.`;
  }
  if (dir.payment_id != null && (dir.payroll_run_id == null || String(dir.payroll_run_id) !== runId)) {
    return `${who}: its SARS directive ${dir.directive_number ?? line.directiveId} was already paid `
      + (dir.payroll_run_id == null ? 'outside payroll' : 'in another payroll run')
      + '. Recalculate the run; it then leaves the severance out.';
  }
  const paye = directivePaye(dir);
  if (cents(Number(dir.amount)) !== cents(line.gross) || paye == null || cents(paye) !== cents(line.paye)) {
    return `${who}: its SARS directive's figures changed after the run was calculated. Recalculate the run first.`;
  }
  return null;
}

async function readDirectives(q: TxSql | typeof sql, companyId: string, ids: string[], lock: boolean): Promise<Map<string, DbRow>> {
  const rows = (lock
    ? await q`
        SELECT d.*, tdp.id AS payment_id, tdp.payroll_run_id
        FROM tax_directives d
        LEFT JOIN tax_directive_payments tdp ON tdp.tax_directive_id = d.id AND tdp.company_id = d.company_id
        WHERE d.company_id = ${companyId}::uuid AND d.id = ANY(${ids}::uuid[])
        ORDER BY d.id
        FOR SHARE OF d`
    : await q`
        SELECT d.*, tdp.id AS payment_id, tdp.payroll_run_id
        FROM tax_directives d
        LEFT JOIN tax_directive_payments tdp ON tdp.tax_directive_id = d.id AND tdp.company_id = d.company_id
        WHERE d.company_id = ${companyId}::uuid AND d.id = ANY(${ids}::uuid[])`) as DbRow[];
  return new Map(rows.map(r => [String(r.id), r]));
}

/**
 * Employee numbers and codes of lump sums (39xx, income codes only) the run pays
 * with no directive, taxable flag or not — the same rule as the calculator's
 * LUMP_SUM_WITHOUT_DIRECTIVE and payrollRunTermination's hand-made check.
 */
async function lumpSumsWithoutDirective(companyId: string, runId: string): Promise<string[]> {
  const rows = (await sql`
    SELECT DISTINCT e.employee_number, regexp_replace(item->>'sarsSourceCode', '^[ \t\r\n]+|[ \t\r\n]+$', '', 'g') AS code
    FROM payroll_run_lines l
    JOIN payroll_run_headers h ON h.id = l.run_id
    JOIN payroll_employees e ON e.id = l.employee_id AND e.company_id = h.company_id
    CROSS JOIN LATERAL jsonb_array_elements(l.component_breakdown) AS item
    WHERE h.id = ${runId}::uuid AND h.company_id = ${companyId}::uuid
      AND regexp_replace(item->>'sarsSourceCode', '^[ \t\r\n]+|[ \t\r\n]+$', '', 'g') ~ '^39[0-9]{2}$'
      AND item->'directive' IS NULL
    ORDER BY 1, 2
  `) as DbRow[];
  return rows.map(r => `${String(r.employee_number)} (${String(r.code)})`);
}

/** The approval gate's blocker for the run's lump-sum and directive lines, or null. Read-only. */
export async function judgeRunDirectives(companyId: string, runId: string): Promise<PayrollJournalNote | null> {
  const undirected = await lumpSumsWithoutDirective(companyId, runId);
  if (undirected.length > 0) {
    return {
      code: 'lump_sum_without_directive',
      detail: `This run pays lump sums with no SARS tax directive, so no PAYE was deducted from them: ${undirected.join(', ')}. `
        + 'SARS requires the directive before a lump sum is paid. Remove the component, or pay it under an approved directive.',
    };
  }
  const lines = await directiveLines(sql, companyId, runId);
  if (lines.length === 0) return null;
  const dirs = await readDirectives(sql, companyId, lines.map(l => l.directiveId), false);
  const problems = lines.map(l => refusal(l, dirs.get(l.directiveId), runId)).filter((p): p is string => p != null);
  return problems.length === 0 ? null : { code: 'severance_directive_unavailable', detail: problems.join(' ') };
}

/**
 * Claim the run's severance directives, and release this run's claims on any
 * its lines no longer carry. Called by approvePayrollRun under its locks and
 * before its status write; in a savepoint, so a refusal leaves nothing behind.
 */
export async function claimRunSeveranceDirectives(companyId: string, runId: string, userId: string): Promise<void> {
  await withBoundedLockWait(runId, async (tx) => {
    const lines = await directiveLines(tx, companyId, runId);
    const ids = lines.map(l => l.directiveId);
    const dirs = await readDirectives(tx, companyId, ids, true);
    for (const l of lines) {
      const why = refusal(l, dirs.get(l.directiveId), runId);
      if (why) throw new PayrollApprovalRefusedError(`Cannot approve: ${why}`);
    }
    // Release this run's claims on directives its lines no longer carry. With
    // no lines, ANY of the empty array is false for every row, so NOT(...)
    // releases all of them.
    await tx`
      DELETE FROM tax_directive_payments
      WHERE company_id = ${companyId}::uuid AND payroll_run_id = ${runId}::uuid
        AND NOT (tax_directive_id = ANY(${ids}::uuid[]))
    `;
    for (const l of lines) {
      const claimed = (await tx`
        INSERT INTO tax_directive_payments (
          company_id, tax_directive_id, payment_date, gross_amount, paye_amount, net_amount, payroll_run_id, created_by
        )
        SELECT ${companyId}::uuid, ${l.directiveId}::uuid,
               (make_date(h.period_year, h.period_month, 1) + INTERVAL '1 month - 1 day')::date,
               ${l.gross}, ${l.paye}, ${Math.round((l.gross - l.paye) * 100) / 100}, h.id, ${userId}::uuid
        FROM payroll_run_headers h WHERE h.id = ${runId}::uuid AND h.company_id = ${companyId}::uuid
        ON CONFLICT (company_id, tax_directive_id) DO UPDATE
          SET payment_date = EXCLUDED.payment_date, gross_amount = EXCLUDED.gross_amount,
              paye_amount = EXCLUDED.paye_amount, net_amount = EXCLUDED.net_amount
          WHERE tax_directive_payments.payroll_run_id = EXCLUDED.payroll_run_id
        RETURNING id
      `) as DbRow[];
      if (!claimed[0]) {
        throw new PayrollApprovalRefusedError(
          `Cannot approve: the severance for ${l.employeeNumber} was paid under its SARS directive meanwhile. `
          + 'Recalculate the run; it then leaves the severance out.');
      }
    }
    if (lines.length > 0) log.info('Severance directives claimed by payroll run', { companyId, runId, directives: ids }, 'payrollRunDirectiveClaim');
  });
}

/**
 * Leavers from earlier periods with an approved severance directive this run
 * does NOT pay, and why — an advisory on the approval preview (non-blocking:
 * one stuck leaver must not stop every later payroll). Calculation skips such a
 * leaver, so no line carries a warning; this is where a person sees that the
 * directive needs correcting, or that severance was paid by hand already.
 */
export async function unpaidLeaverDirectiveNotes(companyId: string, runId: string): Promise<PayrollJournalNote[]> {
  const rows = (await sql`
    SELECT DISTINCT e.id, e.employee_number, h.period_year, h.period_month
    FROM payroll_run_headers h
    JOIN payroll_employees e ON e.company_id = h.company_id
    JOIN tax_directives d ON d.company_id = e.company_id AND d.employee_id = e.id
    WHERE h.id = ${runId}::uuid AND h.company_id = ${companyId}::uuid
      AND e.end_date < make_date(h.period_year, h.period_month, 1)
      AND d.directive_type = 'severance' AND d.status = 'approved'
      AND NOT EXISTS (SELECT 1 FROM tax_directive_payments p WHERE p.company_id = d.company_id AND p.tax_directive_id = d.id)
      AND NOT EXISTS (SELECT 1 FROM payroll_run_lines l WHERE l.run_id = h.id AND l.employee_id = e.id)
    ORDER BY e.employee_number
  `) as DbRow[];
  const notes: PayrollJournalNote[] = [];
  for (const r of rows) {
    const period = { year: Number(r.period_year), month: Number(r.period_month) };
    const { available, unpayable } = await findSeveranceDirectiveForRun(companyId, String(r.id), runId, period);
    const byHand = available ? await findHandMadeLumpSumPaid(companyId, String(r.id), runId) : null;
    if (byHand) {
      notes.push({
        code: 'severance_directive_not_paid',
        detail: `${String(r.employee_number)}: SARS directive ${available!.number ?? available!.id} is not paid, because severance `
          + `(${byHand.name}) was already paid by hand in the ${byHand.year}-${String(byHand.month).padStart(2, '0')} run. `
          + 'Correct that payment by hand if the directive replaces it.',
      });
    } else if (!available && unpayable) {
      notes.push({
        code: 'severance_directive_not_paid',
        detail: `${String(r.employee_number)}: SARS directive ${unpayable.number ?? unpayable.id} is not paid, because its tax figure `
          + 'is below nil or above the gross. Correct the directive.',
      });
    }
  }
  return notes;
}
