/**
 * What the caller is told when a tool handler THROWS.
 *
 * Split from registry.ts, which owns the fences and the transaction: this file
 * owns the reply. A handler error is generic by default — no stack, no SQL —
 * and each exception below is a refusal whose text is safe and actionable.
 */
import type { McpTool, McpToolResult } from './types';
import { BulkAllocationLineError, bulkAllocationLineErrorText } from './bulkAllocationLineError';
import { BankLineDirectionError, bankLineDirectionErrorText } from './bankLineDirectionError';
import { MissingSystemAccountError, missingSystemAccountText } from '@/modules/accounting/services/gl/systemAccountKeys';
import { EffectivePermissionError } from '@/lib/auth/effectivePermissions';
import { permissionRefusalMessage } from './scopeRemediation';
import { approvalRequiredReply } from './approvalReply';
import { isSuppliedApprovalRefusal, suppliedApprovalRefusalText } from '@/modules/accounting/services/controls/suppliedApprovalRefusal';

export const GENERIC_FAILURE = 'The operation failed. Please try again or contact support.';

const errorResult = (text: string): McpToolResult => ({ content: [{ type: 'text', text }], isError: true });

export function handlerErrorReply(tool: Pick<McpTool, 'name' | 'inputSchema'>, err: unknown): McpToolResult {
  // A line-specific refusal contains only safe caller-owned input.
  if (err instanceof BulkAllocationLineError) return errorResult(bulkAllocationLineErrorText(tool.name, err));
  // Missing system-account errors are already safe and actionable.
  if (err instanceof MissingSystemAccountError) return errorResult(missingSystemAccountText(tool.name, err));
  // A line whose sign contradicts the invoice it names: the refusal has to say
  // WHICH way to go, because "the operation failed" on a payload the agent
  // believes is routine invites the retry that keeps failing.
  if (err instanceof BankLineDirectionError) return errorResult(bankLineDirectionErrorText(tool.name, err));
  // Every approval-required refusal carries this code — the kernel's own and the
  // AP/AR boundary wrappers alike. The reply depends on whether THIS tool can
  // carry an approval at all.
  if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'OPERATION_APPROVAL_REQUIRED') {
    return errorResult(approvalRequiredReply(tool));
  }
  // A caller-supplied approval that cannot be used is the caller's to fix, and
  // the refusal text is written by the control kernel, never by pg. Anything
  // else in that region (a stored-approval integrity trip, a programming fault)
  // stays generic on purpose.
  if (isSuppliedApprovalRefusal(err)) {
    return errorResult(`The approval supplied with this call cannot be used: ${suppliedApprovalRefusalText(err)}. `
      + 'Nothing was posted. Request an approval for this exact operation with request_operation_approval and retry with its approval_id.');
  }
  // A domain permission refusal names the grant, worded by what blocks the caller.
  if (err instanceof EffectivePermissionError && err.permission) {
    return errorResult(permissionRefusalMessage(err.permission, err.reason));
  }
  return errorResult(GENERIC_FAILURE);
}
