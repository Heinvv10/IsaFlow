/**
 * Why a calculated regular run may NOT be cancelled (wave 7 CX, W28; coordinator ruling 2026-11-26). Cancelling a
 * regular run deletes its header (payrollRegularRunCancel), so it is allowed only for a run that never left the
 * preparer's hands: every source that could show it was ever approved, paid, posted, declared or shown to an employee
 * is read, not only the header's current state (a reopened run is calculated again and looks like a fresh one).
 *
 * Evidence read (each is a refusal on its own; the message names the first found):
 *   header      approved_at, approval_grandfathered_at, lines_confirmed_at (718: stamped by approval), reopened_at,
 *               a non-empty approval_history (925), paid_at (1053), journal_entry_id
 *   audit_log   a pay-run approval event other than prepared/requested/declined (authorised, executed, reopened,
 *               reversed: payRunApprovalAudit): a journal posted and reversed since leaves no id on the header. Read
 *               only to REFUSE (fail closed), never as proof that a run may go.
 *   requests    an R-035 approval request for the run that was approved (a rejection is not an approval)
 *   rows        payroll_run_directive_uses (979), tax_directive_payments.payroll_run_id (901), an applied garnishee
 *               deduction (999z balance_applied), any payroll_bank_files row incl. voided (999h), any payslip_deliveries
 *               row (999o), a line with a frozen payslip_snapshot (approval), an EMP201 tax_return_versions row whose
 *               figures name the run (draft, finalised or filed)
 *   later run   a regular run of the same frequency for a later period that is calculated or beyond (its loans and
 *               cadence were costed after this one)
 * The portal shows only final runs (employeePortalReads: payRunFinalSql), so a run with none of the above was never
 * exposed there. Read under the company approval lock and the header lock (the caller), before any write.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

const EVIDENCE: Array<[string, string]> = [
  ['approved', 'it was approved before'],
  ['reopened', 'it was reopened after an approval'],
  ['paid', 'it was marked paid'],
  ['journal', 'it carries a payroll journal'],
  ['request_approved', 'its approval request was approved'],
  ['audit', 'its audit trail records an approval, a posted journal or a reopen'],
  ['directive', 'it used or claimed a tax directive'],
  ['garnishee', 'a garnishee deduction was applied against an order balance'],
  ['bank_file', 'a salary bank file was made for it'],
  ['payslip', 'payslips were frozen or emailed for it'],
  ['emp201', 'an EMP201 return names it'],
  ['later_run', 'a later run of its pay frequency is already calculated'],
];

/** The reason the run cannot be cancelled, or null. `run` is the locked header row. */
export async function regularRunCancelRefusal(companyId: string, run: DbRow): Promise<string | null> {
  const runId = String(run.id);
  const rows = (await sql`
    SELECT
      (h.approved_at IS NOT NULL OR h.approval_grandfathered_at IS NOT NULL OR h.lines_confirmed_at IS NOT NULL) AS approved,
      (h.reopened_at IS NOT NULL OR (h.approval_history IS NOT NULL AND NOT isempty(h.approval_history))) AS reopened,
      (h.paid_at IS NOT NULL) AS paid,
      (h.journal_entry_id IS NOT NULL) AS journal,
      EXISTS (SELECT 1 FROM audit_log a
               WHERE a.company_id = h.company_id AND a.entity_type = 'payroll_run' AND a.entity_id = h.id
                 AND a.changes->'metadata'->>'event' IN ('authorised', 'executed', 'reopened', 'reversed')) AS audit,
      EXISTS (SELECT 1 FROM approval_requests r
               WHERE r.company_id = h.company_id AND r.document_type = 'pay_run' AND r.document_id = h.id
                 AND r.status = 'approved') AS request_approved,
      (EXISTS (SELECT 1 FROM payroll_run_directive_uses d WHERE d.run_id = h.id AND d.company_id = h.company_id)
       OR EXISTS (SELECT 1 FROM tax_directive_payments t WHERE t.payroll_run_id = h.id AND t.company_id = h.company_id)) AS directive,
      EXISTS (SELECT 1 FROM payroll_garnishee_deductions g
               WHERE g.run_id = h.id AND g.company_id = h.company_id AND g.balance_applied) AS garnishee,
      EXISTS (SELECT 1 FROM payroll_bank_files f WHERE f.run_id = h.id AND f.company_id = h.company_id) AS bank_file,
      (EXISTS (SELECT 1 FROM payslip_deliveries p WHERE p.run_id = h.id AND p.company_id = h.company_id)
       OR EXISTS (SELECT 1 FROM payroll_run_lines l WHERE l.run_id = h.id AND l.payslip_snapshot IS NOT NULL)) AS payslip,
      EXISTS (SELECT 1 FROM tax_return_versions v
               WHERE v.company_id = h.company_id AND v.form_type = 'EMP201'
                 AND strpos(v.figures::text, h.id::text) > 0) AS emp201,
      EXISTS (SELECT 1 FROM payroll_run_headers o
               WHERE o.company_id = h.company_id AND o.run_kind = 'regular' AND o.pay_frequency = h.pay_frequency
                 AND o.period_start > h.period_start AND o.status <> 'cancelled'
                 AND (o.status <> 'draft' OR o.calculated_at IS NOT NULL)) AS later_run
    FROM payroll_run_headers h
    WHERE h.id = ${runId}::uuid AND h.company_id = ${companyId}::uuid
  `) as DbRow[];
  const found = rows[0];
  if (!found) return 'it no longer exists';
  const hit = EVIDENCE.find(([key]) => found[key] === true);
  return hit ? hit[1] : null;
}
