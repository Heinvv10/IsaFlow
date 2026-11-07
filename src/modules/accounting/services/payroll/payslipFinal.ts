/**
 * Whether a pay run's payslips are final (wave 4 PS, spec rule 6). ONLY the
 * R-035 finalisation guard decides: `assertPayRunApproved` resolving means final.
 * Never a status string: an `approved` row that R-035 has not cleared (and that
 * migration 951 did not grandfather) is a DRAFT payslip.
 *
 * Only the guard's own refusals are DRAFT: `PayRunNotApprovedError` (not found, not
 * approved, no reviewed plan) and `ApprovalRequiredError` (R-035 not cleared).
 * Anything else (a Postgres error, a dropped connection, a bug) is re-thrown, so a
 * failed read is a 500, never a slip that silently says DRAFT for the wrong reason.
 *
 * Known limit (wave 5): the guard judges against TODAY's enforcement and rules, so a
 * run paid while pay-run enforcement was off turns DRAFT once it is switched on
 * (pinned in tests/unit/services/payroll/payslipFinal.test.ts).
 */
import { ApprovalRequiredError } from '@/modules/accounting/services/gl/approvalGate';
import { assertPayRunApproved, PayRunNotApprovedError } from './payRunApprovalControl';

export async function isPayRunFinal(companyId: string, runId: string): Promise<boolean> {
  try {
    await assertPayRunApproved(companyId, runId);
    return true;
  } catch (err) {
    if (err instanceof PayRunNotApprovedError || err instanceof ApprovalRequiredError) return false;
    throw err;
  }
}
