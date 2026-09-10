/**
 * What an agent is told when a company approval policy binds its operation.
 *
 * The reply must be something the agent can act on. "Request an approval and
 * retry" is only true for a tool that accepts `approval_id`; every other tool
 * cannot carry one, and telling its caller to retry sends it round a loop of
 * approvals it can never use. So the reply is per tool: how to pass the
 * approval where that is possible, and otherwise where the operation can be
 * completed — named only where the app route is verified to accept an approval.
 */
interface ToolShape { name: string; inputSchema: Record<string, unknown> }

/** App routes verified to accept an approval for the operation the tool performs. */
const APP_ROUTE: Readonly<Record<string, string>> = {
  // pages/api/accounting/year-end.ts forwards approvalId to closeFiscalYear.
  year_end_close: 'Complete it in the year-end close in the IsaFlow app, which accepts the approval once it is decided.',
  // pages/api/accounting/supplier-invoices-action.ts and -bulk-action.ts forward approvalId.
  bulk_approve_supplier_invoices: 'Approve the bill in the IsaFlow app, which accepts the approval once it is decided.',
};
const NO_ROUTE = 'No connector tool can apply that approval yet; ask a company owner or admin how they want it completed.';

function acceptsApproval(tool: ToolShape): boolean {
  const properties = tool.inputSchema.properties;
  return typeof properties === 'object' && properties !== null && 'approval_id' in properties;
}

/** The full reply, for a refusal that ends the call. */
export function approvalRequiredReply(tool: ToolShape): string {
  const lead = 'An independent approval is required for this operation under the company\'s approval policy. Nothing was posted. ';
  if (acceptsApproval(tool)) {
    return `${lead}Request one with request_operation_approval, then call ${tool.name} again with its approval_id once it is decided.`;
  }
  return `${lead}This tool cannot carry an approval. ${APP_ROUTE[tool.name] ?? NO_ROUTE}`;
}

/** The short form, for one line of a bulk preview's skipped list. */
export function approvalRequiredReason(toolName: string): string {
  return 'an independent approval is required under the company\'s approval policy, and this tool cannot carry one'
    + (APP_ROUTE[toolName] ? ` — ${APP_ROUTE[toolName]!.charAt(0).toLowerCase()}${APP_ROUTE[toolName]!.slice(1, -1)}` : '');
}
