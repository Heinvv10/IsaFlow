/**
 * Paging arguments the MCP budget tools share: an `offset` (0 when absent or not a positive integer) and the page
 * of a write's listed cells under `list_offset` / `list_limit`, by PR 1's rule exactly (review round 2, M-1: the
 * MCP layer does not enforce the JSON schema): a limit that is not an integer (0.5, 2.5, "10") is the default, an
 * integer below 1 is 1 (never 0: an empty page with the same next_offset would loop an agent), the maximum caps it.
 */

export const offsetArg = (args: Record<string, unknown>, key = 'offset'): number =>
  (Number.isInteger(args[key]) && Number(args[key]) > 0 ? Number(args[key]) : 0);

/** The `list_offset` / `list_limit` page of a write's listed cells. */
export function listPage(args: Record<string, unknown>, fallback: number, max: number): { offset: number; limit: number } {
  const limit = Number.isInteger(args.list_limit) ? Number(args.list_limit) : fallback;
  return { offset: offsetArg(args, 'list_offset'), limit: Math.min(max, Math.max(1, limit)) };
}
