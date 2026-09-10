/**
 * Preview-only companion to the payroll write tools.
 *
 * `payroll_run.post` is refused by the control kernel when the company's policy
 * demands an independent approval, so a preview that skipped the question told
 * the agent a run would post that the live call refuses. Both payroll previews
 * ask the kernel first — and say which of the two things happened, because
 * "request an approval" is the wrong instruction for a run that could not be
 * materialised at all.
 */
import { controlledOperationApprovalRequiredForPreview } from '@/modules/accounting/services/controls/approvalExecutionService';
import { requireControlTx } from '@/modules/accounting/services/controls/context';
import { approvalRequiredReply } from '../approvalReply';

// Neither payroll tool accepts approval_id, so the reply must not send the agent
// to request one and retry.
export const PAYROLL_APPROVAL_REQUIRED_TEXT = approvalRequiredReply({ name: 'approve_pay_run', inputSchema: {} });
/** Deliberately NOT an approval instruction: the reason is something else. */
export const PAYROLL_PREVIEW_UNAVAILABLE_TEXT =
  'This pay run could not be previewed — its posting material could not be built (a missing '
  + 'calculation, fiscal period or ledger currency will do it). An approval may also be required. '
  + 'Fix the run and retry; payroll_status names what the run is missing.';

/** The refusal a preview owes, or null when it may go ahead. */
export async function payrollPreviewRefusal(companyId: string, runId: string): Promise<string | null> {
  const ctx = requireControlTx();
  if (ctx.principal.companyId !== companyId) throw new Error('Payroll preview context does not match the tenant');
  const answer = await controlledOperationApprovalRequiredForPreview(ctx,
    { entityType: 'payroll_run', entityId: runId, operation: 'payroll_run.post' });
  if (answer.kind === 'answered') return answer.required ? PAYROLL_APPROVAL_REQUIRED_TEXT : null;
  // Nothing to withhold when no policy binds this operation: let the preview
  // run and fail (or succeed) on its own terms.
  return answer.policiesExist ? PAYROLL_PREVIEW_UNAVAILABLE_TEXT : null;
}
