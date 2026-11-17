/**
 * Paging arguments the MCP budget tools share: an `offset` (0 when absent or not a positive integer) and a page
 * of listed items under `list_limit` / `limit` clamped to the tool's maximum (toolHelpers.clampLimit).
 */
import { clampLimit } from './toolHelpers';

export const offsetArg = (args: Record<string, unknown>, key = 'offset'): number =>
  (Number.isInteger(args[key]) && Number(args[key]) > 0 ? Number(args[key]) : 0);

/** The `list_offset` / `list_limit` page of a write's listed cells. */
export function listPage(args: Record<string, unknown>, fallback: number, max: number): { offset: number; limit: number } {
  return { offset: offsetArg(args, 'list_offset'), limit: clampLimit({ limit: args.list_limit }, fallback, max) };
}
