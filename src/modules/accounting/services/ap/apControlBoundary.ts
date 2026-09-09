import { requireControlTx } from '../controls/context';
import { executeControlledOperation, type ControlledEffectPermit } from '../controls/approvalExecutionService';
import type { OperationRef } from '../controls/contracts';

export interface ApApprovalOptions { approvalId?: string }
export class ApApprovalRequiredError extends Error {
  readonly code = 'OPERATION_APPROVAL_REQUIRED';
  readonly statusCode = 409;
  constructor(readonly operation: OperationRef['operation'], readonly entityId: string) {
    super('Independent operation approval is required. Request approval for this operation before retrying.');
    this.name = 'ApApprovalRequiredError';
  }
}
export function requireApControl(companyId: string, userId: string) {
  const ctx = requireControlTx();
  if (ctx.principal.companyId !== companyId || ctx.principal.personId !== userId) throw new Error('Control transaction actor does not match AP operation');
  return ctx;
}
/** Transport supplies an approval reference only; material and authority are server-derived. */
export async function runApControlled<T>(companyId: string, userId: string, ref: OperationRef,
  opts: ApApprovalOptions | undefined, effect: (permit: ControlledEffectPermit) => Promise<T>): Promise<T> {
  const ctx = requireApControl(companyId, userId);
  try {
    return await executeControlledOperation(ctx, ref, opts?.approvalId ?? null, async permit => {
      // Match the existing JSON API representation, omitting optional undefined fields.
      return JSON.parse(JSON.stringify(await effect(permit))) as T;
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Independent operation approval is required') {
      throw new ApApprovalRequiredError(ref.operation, ref.entityId);
    }
    throw error;
  }
}
