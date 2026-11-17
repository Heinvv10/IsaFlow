/**
 * The live-call checks every MCP budget write with a dry run shares (budget tools PR 1 and 3): the version_token
 * the dry run read, the plan_hash it returned (required when `hashRequired`), recomputed from the current state.
 * Each answers the refusal, or null to go on.
 */
import type { McpToolResult } from '../types';
import { PLAN_CHANGED } from './budgetToolArgs';
import { toolError } from './toolHelpers';

export const STALE_SINCE_DRY_RUN = 'The budget changed since your dry run (its version_token moved); nothing was written. Dry-run again and apply with the new plan_hash.';

export const staleRefusal = (versionToken: string | null, token: string): McpToolResult | null =>
  (versionToken !== null && versionToken !== token ? toolError(STALE_SINCE_DRY_RUN) : null);

/** `required` says why the hash is required, for the refusal ("for a write of more than one cell"). */
export function planHashRefusal(o: { tool: string; given: string | null; hash: string; required: boolean; why: string }): McpToolResult | null {
  if (o.required && o.given === null) return toolError(`plan_hash is required ${o.why}: call ${o.tool} with dry_run true, read the diff, then apply with the plan_hash it returns.`);
  return o.given !== null && o.given !== o.hash ? toolError(PLAN_CHANGED) : null;
}
