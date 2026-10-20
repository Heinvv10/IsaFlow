/**
 * Whole-cent money validation, shared by the MCP tools and the services layer (which must not import from
 * `@/lib/mcp`). Moved verbatim from `mcp/tools/toolHelpers`, which re-exports it.
 */

/**
 * The largest magnitude a NUMERIC(15,2) column holds: 13 integer digits and 2
 * decimals. Anything beyond it is a numeric overflow (22003) at the INSERT.
 */
export const MAX_MONEY = 9999999999999.99;

/**
 * Is `amount` exactly representable as whole cents, and small enough to store?
 *
 * Money is NUMERIC(15,2). A third decimal would be rounded by Postgres, so the
 * agent's own arithmetic and the ledger's would disagree silently — but the
 * obvious guard, `Math.round(amount * 100) !== amount * 100`, is itself wrong:
 * `282543.34 * 100` is `28254334.000000004` in IEEE-754, so a real receipt of
 * R282,543.34 was refused as "more than two decimal places". That blocked a
 * production AR reload (Velocity Fibre, 2026-09-05).
 *
 * Comparing the two-decimal rendering back to the number is exact wherever
 * `toFixed` renders positional digits, where a fixed epsilon on `amount * 100`
 * is not: past 1e13 the spacing between doubles already exceeds a cent.
 *
 * The magnitude bound is not decoration. `toFixed` switches to EXPONENTIAL
 * notation at 1e21 (`(1e21).toFixed(2) === '1e+21'`), which parses back equal
 * and so passes the cents test; and a 14-digit amount is representable but
 * still overflows the column. Without the bound both reach Postgres and fail as
 * a raw 22003 mid-write, where the whole point of validating here is that every
 * refusal happens BEFORE the first write.
 */
export function hasWholeCents(amount: number): boolean {
  if (!Number.isFinite(amount) || Math.abs(amount) > MAX_MONEY) return false;
  return Number(amount.toFixed(2)) === amount;
}
