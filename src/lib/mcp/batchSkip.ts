/**
 * A tool call the batch loop (`pages/api/mcp/index.ts`) does not run because
 * an earlier call in the same batch waited out the company's role-write lock:
 * running it would wait another 5s on the request's one pooled connection.
 *
 * It is still a call the agent made, so it is on the audit trail like any
 * refused call — 'rejected', with NO idempotency key (the retry must run, not
 * replay this) — and nothing is debited: it never reaches the registry.
 */
import type { McpToolContext, McpToolResult } from './types';
import { hashArgs, recordToolCall } from './audit';
import type { JsonRpcRequest } from './jsonrpc';

export const SKIPPED_FOR_ROLE_LOCK = 'Not run: an earlier call in this batch found the chart of accounts being changed by another request, '
  + 'so the calls after it were skipped. Nothing was written or charged for this call — retry it in a moment.';

/** The skipped result for a well-formed `tools/call`; null for anything else (a ping, a call with no tool name), which is answered as usual. */
export async function skippedForRoleLock(rpc: JsonRpcRequest, ctx: McpToolContext): Promise<McpToolResult | null> {
  const tool = rpc?.method === 'tools/call' ? rpc.params?.name : undefined;
  if (typeof tool !== 'string' || !tool) return null;
  const args = (rpc.params?.arguments as Record<string, unknown> | undefined) ?? {};
  await recordToolCall({ ctx, tool, argsHash: hashArgs(args), idempotencyKey: null, status: 'rejected', result: null, durationMs: 0 });
  return { content: [{ type: 'text', text: SKIPPED_FOR_ROLE_LOCK }], isError: true };
}
