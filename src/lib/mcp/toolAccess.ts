/**
 * Whether a token may call a tool, decided from the tool's own metadata: the one rule `McpRegistry.call()` applies before a handler
 * runs (scope, write:post, requiresScope, then the role fence), and the one `token_info` lists by. Nothing else decides which tools a
 * token "opens", so the listing cannot drift from what a call is refused.
 *
 * `McpTool.admits` is the tool's OWN role predicate for a gate its handler applies (a read that is owner / admin / manager only, a
 * delete that is owner / admin): the registry does not enforce it (the handler answers its own refusal), `token_info` honours it.
 * A tool gated only for one option (an owner-only flag) declares none and is listed to anyone the fences admit.
 */
import { insufficientScopeMessage } from './scopeRemediation';
import { roleFenceRefusal } from './roleFence';
import type { McpTool, McpToolContext } from './types';

export const POST_REFUSAL = 'This operation posts irreversible entries and requires the write:post permission, which this connection was not granted.';

/** The registry's refusal text for a call to `tool` by `ctx`, or null when the fences let it reach the handler. */
export function accessRefusal(tool: McpTool, ctx: McpToolContext): string | null {
  if (tool.scope && !ctx.scopes.includes(tool.scope)) return insufficientScopeMessage(tool.scope);
  if (tool.requiresPost && !ctx.scopes.includes('write:post')) return POST_REFUSAL;
  if (tool.requiresScope && !ctx.scopes.includes(tool.requiresScope)) return insufficientScopeMessage(tool.requiresScope);
  return roleFenceRefusal(tool, ctx);
}

/** Can this token, in this role, call the tool: past the registry's fences and the tool's own role predicate. */
export function callableBy(tool: McpTool, ctx: McpToolContext): boolean {
  return accessRefusal(tool, ctx) === null && (tool.admits === undefined || tool.admits(ctx.companyRole));
}
