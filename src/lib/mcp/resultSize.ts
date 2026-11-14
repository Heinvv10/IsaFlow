/**
 * The safety net for READ tools whose answer outgrows what a client will take (about 90 KB of result text).
 *
 * A client that cannot take a result truncates it or drops it with no word to the agent, which then reasons from a
 * partial ledger. The registry is the one path every tool answers through, so it refuses here instead, in words that
 * name how to ask for less: only the levers THIS tool's schema has (`detail`, `group_by`, `fields`, `limit`,
 * `include_lines`, a date window). A refusal is audited as rejected and refunds the call's Flows, like any other
 * refused read.
 *
 * Writes are exempt (their answer is what was done, and a refusal after the write would hide it). A read that
 * returns a file by design opts out with `allowLargeResult` on its McpTool.
 */
import type { McpTool, McpToolResult } from './types';

export const MAX_READ_RESULT_BYTES = 90_000;

function resultBytes(result: McpToolResult): number {
  return result.content.reduce((n, part) => n + Buffer.byteLength(part.text, 'utf8'), 0);
}

function levers(tool: McpTool): string[] {
  const props = (tool.inputSchema.properties ?? {}) as Record<string, { enum?: unknown[] } | undefined>;
  const has = (k: string): boolean => k in props;
  const out: string[] = [];
  if (props.detail?.enum?.includes('summary')) out.push('detail:"summary" (totals only)');
  if (has('group_by')) out.push('group_by (totals per group)');
  if (props.fields?.enum?.includes('compact')) out.push('fields:"compact"');
  if (has('include_lines')) out.push('include_lines:false');
  if (has('limit')) out.push('a smaller limit (then page)');
  if (['from', 'from_date', 'date_from', 'period_start', 'date_to', 'to_date', 'as_at'].some(has)) {
    out.push('a narrower date window');
  }
  out.push('narrower filters');
  return out;
}

/** The refusal to return in place of an oversized read result, or null when the result may go out. */
export function oversizedReadRefusal(tool: McpTool, result: McpToolResult): McpToolResult | null {
  if (tool.write || tool.allowLargeResult === true || result.isError === true) return null;
  const bytes = resultBytes(result);
  if (bytes <= MAX_READ_RESULT_BYTES) return null;
  const kb = Math.round(bytes / 1024);
  const text = `${tool.name} would return about ${kb} KB, over the ${Math.round(MAX_READ_RESULT_BYTES / 1000)} KB a client can take, so nothing was returned. `
    + `Ask for less: ${levers(tool).join(', ')}.`;
  return { content: [{ type: 'text', text }], isError: true };
}
