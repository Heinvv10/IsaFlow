/**
 * Cancelling an off-cycle run that is not final (wave 6 OC, UI review #1620 H): a draft or calculated bonus or
 * termination run that cannot be approved (its pay date passed, it pays nothing) is otherwise a dead end, and its
 * employees could join no other off-cycle run of the month. Cancel sets status 'cancelled' and deletes its lines; the
 * header and its payroll_off_cycle_employees rows stay as the record of what was cancelled.
 *
 * Why every reader then ignores it:
 *  - EMP201, the year to date, the payslip finality, the 13-week forecast and the journal readers read FINAL runs only
 *    (payRunFinalSql: approved or paid); the owner cash position reads draft, calculated and approved runs only; and the
 *    run has no lines left for any line reader.
 *  - The open-run check at create, the pay-order check and the month's basis read non-cancelled runs only.
 *  - Calculate-time rows keyed to a run: an off-cycle run takes no loan instalment (payrollRunService skips
 *    applyRunLoans), and regular-pay directive uses and severance claims are written at APPROVAL only
 *    (payrollRunDirectiveClaim). A run that ever carried a journal, a directive use, a claim or a loan payment is
 *    therefore one that was approved before, and it is refused (reopen keeps those records).
 *  - Garnishee deductions (wave 7 GT: a termination run takes them) are dropped (releaseCancelledRunGarnishees); a
 *    cancellable run's are never applied, so no balance moves.
 *  - Off-cycle runs never close a month's ETI (payrollRunCadence), so no regular run's ETI depends on it.
 * A pending R-035 approval request for the run is withdrawn (rejected by the canceller, with a 'declined' audit row on
 * the pay run) in the same transaction, so it leaves the approvers' list.
 * Owner or admin, never under Login-as (the route); refused with 409 before any write.
 */
import { withTransaction } from '@/lib/neon';
import type { DbRow, TxSql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { mapRunRow, type PayrollRunSummary } from './payrollRunHeaders';
import { OffCycleRunRefusedError } from './payrollOffCycleRun';
import { decideRequest } from '../gl/approvalService';
import { lockApprovalRequestForUpdate } from '../gl/approvalRequestLock';
import { GRANDFATHERED_PLAN_HASH, recordPayRunApprovalAudit } from './payRunApprovalAudit';
import { releaseCancelledRunGarnishees } from './payrollGarnisheeRun';

const refused = (m: string) => new OffCycleRunRefusedError(m, 409);
const WITHDRAWN = 'Withdrawn: the off-cycle run was cancelled.';

export async function cancelOffCycleRun(companyId: string, runId: string, userId: string): Promise<PayrollRunSummary | null> {
  await assertNotImpersonating(); // R-032 L5: first, before any read or write
  return withTransaction(async (tx) => {
    const run = ((await tx`
      SELECT h.*,
             (h.journal_entry_id IS NOT NULL
              OR EXISTS (SELECT 1 FROM payroll_run_directive_uses d WHERE d.run_id = h.id AND d.company_id = h.company_id)
              OR EXISTS (SELECT 1 FROM tax_directive_payments t WHERE t.payroll_run_id = h.id AND t.company_id = h.company_id)
              OR EXISTS (SELECT 1 FROM payroll_loan_payments p WHERE p.run_id = h.id)) AS ever_approved
        FROM payroll_run_headers h
       WHERE h.id = ${runId}::uuid AND h.company_id = ${companyId}::uuid
       FOR UPDATE OF h
    `) as DbRow[])[0];
    if (!run) return null;
    if (run.run_kind !== 'off_cycle') throw refused('Only an off-cycle run can be cancelled.');
    if (run.status !== 'draft' && run.status !== 'calculated') {
      throw refused(`This off-cycle run is ${String(run.status)}: only a draft or calculated off-cycle run can be cancelled.`);
    }
    if (run.ever_approved === true) {
      throw refused('This off-cycle run was approved before (it carries a journal, a directive or a loan payment), so it cannot be cancelled.');
    }
    await withdrawPendingPayRunRequest(tx, companyId, runId, userId, {
      note: WITHDRAWN, reason: 'off-cycle run cancelled', planHash: run.approval_plan_hash,
    });
    // Wave 7 GT (F12): a termination run's garnishee deductions go with its lines; no balance moved (never approved).
    const garnishees = await releaseCancelledRunGarnishees(tx, companyId, runId);
    await tx`DELETE FROM payroll_run_lines WHERE run_id = ${runId}::uuid`;
    const rows = (await tx`
      UPDATE payroll_run_headers
         SET status = 'cancelled', total_gross = 0, total_taxable = 0, total_paye = 0, total_uif = 0, total_sdl = 0,
             total_eti = 0, total_net = 0, employee_count = 0, approval_plan_hash = NULL,
             cancelled_by = ${userId}, cancelled_at = now()
       WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
       RETURNING *
    `) as DbRow[];
    log.info('Off-cycle payroll run cancelled', { companyId, runId, previousStatus: String(run.status), userId, garnishees }, 'payrollRunCancel');
    return mapRunRow(rows[0]!);
  });
}

/**
 * A pending R-035 request leaves the approvers' list (review #1620): withdrawn through the one decide path
 * (approval_request_decide, a rejection by the canceller), with the pay run's audit row, in the caller's transaction.
 * Locked (review L3 of 819c2861c0) in the route's order, the run header (the caller holds it) then its request
 * (approval-requests writes the header in preparePayRunApprovalRequest before decideRequest locks the request), through
 * the 872 definer lock (the app role holds no UPDATE, so no FOR UPDATE of its own), then read again: a decision in flight
 * is waited for, and a request it settled is not withdrawn, so decideRequest never meets a decided one. Shared by the
 * off-cycle and the regular cancel (wave 7 CX). Returns the withdrawn request's id, or null when none was pending.
 */
export async function withdrawPendingPayRunRequest(
  tx: TxSql, companyId: string, runId: string, userId: string,
  why: { note: string; reason: string; planHash: unknown },
): Promise<string | null> {
  const found = ((await tx`
    SELECT id FROM approval_requests
     WHERE company_id = ${companyId}::uuid AND document_type = 'pay_run' AND document_id = ${runId}::uuid AND status = 'pending'
  `) as DbRow[])[0];
  const requestId = found ? String(found.id) : null;
  if (requestId) await lockApprovalRequestForUpdate(companyId, requestId);
  const pending = requestId && ((await tx`
    SELECT id FROM approval_requests WHERE id = ${requestId}::uuid AND company_id = ${companyId}::uuid AND status = 'pending'
  `) as DbRow[])[0];
  if (!pending) return null;
  const withdrawn = await decideRequest(companyId, String(pending.id), 'rejected', userId, why.note);
  await recordPayRunApprovalAudit({
    companyId, runId, actorId: userId, event: 'declined',
    planHash: withdrawn.documentDigest ?? String(why.planHash ?? GRANDFATHERED_PLAN_HASH),
    metadata: { requestId: withdrawn.id, reason: why.reason },
  });
  return withdrawn.id;
}
