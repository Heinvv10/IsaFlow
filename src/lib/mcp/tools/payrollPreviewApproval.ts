/**
 * Preview-only companion to the payroll write tools.
 *
 * `payroll_run.post` is refused by the control kernel when the company's policy
 * demands an independent approval, so a preview that skipped the question told
 * the agent a run would post that the live call refuses. Both payroll previews
 * ask the kernel first.
 */
import { controlledOperationApprovalRequiredForPreview } from '@/modules/accounting/services/controls/approvalExecutionService';
import { requireControlTx } from '@/modules/accounting/services/controls/context';

export const PAYROLL_APPROVAL_REQUIRED_TEXT =
  'An independent approval is required before this pay run can post. Request one with '
  + 'request_operation_approval, then retry. Nothing was previewed.';

export async function payrollApprovalRequired(companyId: string, runId: string): Promise<boolean> {
  const ctx = requireControlTx();
  if (ctx.principal.companyId !== companyId) throw new Error('Payroll preview context does not match the tenant');
  return controlledOperationApprovalRequiredForPreview(ctx,
    { entityType: 'payroll_run', entityId: runId, operation: 'payroll_run.post' });
}
