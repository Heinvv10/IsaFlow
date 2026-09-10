/**
 * What an agent is told when a company approval policy binds its operation.
 *
 * The reply must be something the agent can act on. "Request an approval and
 * retry" is only true for a tool that accepts `approval_id`; every other tool
 * cannot carry one, and telling its caller to retry sends it round a loop of
 * approvals it can never use. So the reply is per tool: how to pass the
 * approval where that is possible, the connector route that applies it where
 * one exists, and otherwise who has to handle it. No reply names a route the
 * caller cannot actually use.
 */
interface ToolShape { name: string; inputSchema: Record<string, unknown> }

// execute_bank_operation takes approval_id inside `instruction`
// (bankPreparedOperationSchema.ts) and applies it to any bank allocation or reversal.
const BANK_ROUTE = 'Complete it through the prepared bank route instead, one bank transaction at a time: prepare_bank_operation saves the '
  + 'instruction and returns its operation, request_operation_approval asks for the approval of that operation, '
  + 'and once it is decided call execute_bank_operation with the intent_id and approval_id inside instruction.';

// pages/api/accounting/year-end.ts, supplier-invoices-action.ts and -bulk-action.ts
// forward an approvalId, but no screen sends one: year-end/index.tsx,
// supplier-invoices/[invoiceId].tsx and BulkActionBar.tsx.
const NO_SCREEN = 'Neither this connector nor the IsaFlow app screens can apply an approval to this operation '
  + 'yet, so a company owner or admin must handle it.';

/** Where a tool that cannot carry an approval can have one applied, verified per tool. */
const ROUTE: Readonly<Record<string, string>> = {
  allocate_bank_transaction: BANK_ROUTE,
  bulk_allocate_bank_transactions: BANK_ROUTE,
  reverse_allocations: BANK_ROUTE,
  reverse_bank_allocation: BANK_ROUTE,
  reverse_bank_allocation_batch: BANK_ROUTE,
  year_end_close: NO_SCREEN,
  bulk_approve_supplier_invoices: NO_SCREEN,
};
const NO_ROUTE = 'No connector tool can apply that approval yet; ask a company owner or admin how they want it completed.';

/** The property path to `approval_id` at any depth, or null when the tool cannot carry one. */
function approvalPath(schema: unknown, path: readonly string[] = []): readonly string[] | null {
  if (typeof schema !== 'object' || schema === null) return null;
  const properties = (schema as { properties?: unknown }).properties;
  if (typeof properties !== 'object' || properties === null) return null;
  if ('approval_id' in properties) return path;
  for (const [key, child] of Object.entries(properties)) {
    const found = approvalPath(child, [...path, key]);
    if (found) return found;
  }
  return null;
}

/** The full reply, for a refusal that ends the call. */
export function approvalRequiredReply(tool: ToolShape): string {
  const lead = 'An independent approval is required for this operation under the company\'s approval policy. Nothing was posted. ';
  const path = approvalPath(tool.inputSchema);
  if (path) {
    const where = path.length ? ` inside ${path.join('.')}` : '';
    return `${lead}Request one with request_operation_approval, then call ${tool.name} again with its approval_id${where} once it is decided.`;
  }
  return `${lead}This tool cannot carry an approval. ${ROUTE[tool.name] ?? NO_ROUTE}`;
}

/** The short form, for one line of a bulk preview's skipped list. */
export function approvalRequiredReason(toolName: string): string {
  const route = ROUTE[toolName];
  return 'an independent approval is required under the company\'s approval policy, and this tool cannot carry one'
    + (route ? ` — ${route.charAt(0).toLowerCase()}${route.slice(1, -1)}` : '');
}
