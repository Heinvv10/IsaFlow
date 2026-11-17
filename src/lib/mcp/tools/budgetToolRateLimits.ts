/**
 * The MCP budget tools' own per-user buckets (budget tools PR 3, review L3), mirroring the limits of the app routes
 * they stand for, so a token cannot amplify past what the app admits a person (the app's buckets stay the app's):
 * driver changes 120 a minute counted PER CHANGE (budget-drivers routes, one change a request), three-way runs 60
 * (GET budget-three-way, derive) and saves 120 (PUT assumptions), remaining previews 120 (POST budgets/remaining),
 * slice moves 60 (POST slices/[id]/[action]). A dry run counts: it runs the same services. A refusal comes before
 * any service and writes nothing (the key stays free). Literal keys and options, as the app's limits are written.
 */
import { checkRateLimit } from '@/lib/rateLimit';
import type { McpToolContext, McpToolResult } from '../types';
import { toolError } from './toolHelpers';

const WAIT = 'wait a minute and try again.';

export async function driverChangesLimit(ctx: McpToolContext, changes: number): Promise<McpToolResult | null> {
  return (await checkRateLimit(`mcp-budget-driver:${ctx.userId}`, { max: 120, windowSecs: 60, cost: changes })) ? null : toolError(`Too many budget driver changes; ${WAIT}`);
}

export async function threeWayRunLimit(ctx: McpToolContext): Promise<McpToolResult | null> {
  return (await checkRateLimit(`mcp-budget-three-way:${ctx.userId}`, { max: 60, windowSecs: 60 })) ? null : toolError(`Too many budget requests; ${WAIT}`);
}

export async function threeWaySaveLimit(ctx: McpToolContext): Promise<McpToolResult | null> {
  return (await checkRateLimit(`mcp-budget-three-way-save:${ctx.userId}`, { max: 120, windowSecs: 60 })) ? null : toolError(`Too many budget requests; ${WAIT}`);
}

export async function remainingLimit(ctx: McpToolContext): Promise<McpToolResult | null> {
  return (await checkRateLimit(`mcp-budget-remaining:${ctx.userId}`, { max: 120, windowSecs: 60 })) ? null : toolError(`Too many budget previews; ${WAIT}`);
}

export async function sliceLimit(ctx: McpToolContext): Promise<McpToolResult | null> {
  return (await checkRateLimit(`mcp-budget-slice:${ctx.userId}`, { max: 60, windowSecs: 60 })) ? null : toolError(`Too many budget slice changes; ${WAIT}`);
}
