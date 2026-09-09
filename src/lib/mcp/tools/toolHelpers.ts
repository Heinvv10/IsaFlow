/**
 * Shared helpers for MCP tool handlers. Keep tiny and dependency-free —
 * every tool file uses these to build results and sanitise inputs.
 */
import type { McpToolResult } from '../types';
import { UUID_RE, isRealCalendarDate } from '@/lib/validation';

export function ok(data: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

/** Generic error result. NEVER include tenant hints or internals — a
 *  cross-tenant probe must read identically to a genuine miss. */
export function toolError(text: string): McpToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export const NOT_FOUND = 'Not found';

export function strArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export function clampLimit(args: Record<string, unknown>, fallback: number, max: number): number {
  const v = Number(args.limit);
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.min(Math.floor(v), max);
}

/**
 * Arguments that end up inside a SQL cast or a date comparison.
 *
 * An agent's id lands as `$n::UUID` and its date as `$n::DATE`, and being a
 * non-empty string is not enough: 'abc' throws 22P02, 'junk' and '2026-02-31'
 * throw 22008. A READ tool runs with NO savepoint (registry.ts), so either
 * aborts the whole request transaction — the registry's own refund and audit
 * writes then fail with 25P02 and the caller gets a 500 with the Flow debit
 * unrefunded. A WRITE tool has a savepoint, so the transaction survives, but
 * the reply degrades to a generic failure that tells the agent nothing about
 * which argument it got wrong.
 *
 * `format: date` in a JSON Schema is advisory — nothing in this server
 * enforces it — so these are the only checks standing between an agent's
 * typo and a cast.
 *
 * Note `isRealCalendarDate`, not `isValidDate`: Date.parse rolls '2026-02-31'
 * forward to 3 March and returns a timestamp, while Postgres throws on it.
 */
export interface CastableArgs {
  /** Checked against UUID_RE, in order. */
  uuid?: readonly string[];
  /** Checked against isRealCalendarDate, in order. */
  date?: readonly string[];
}

/**
 * Returns a `toolError('invalid <arg>')` for the FIRST argument that cannot
 * survive its cast, or null when everything is usable. Absent arguments pass —
 * requiredness is the caller's own check, and its message is more specific.
 *
 * Naming the argument leaks nothing: it is the agent's own input, and whether
 * a string is a well-formed UUID says nothing about whether a row exists.
 */
export function guardCastableArgs(
  args: Record<string, unknown>,
  spec: CastableArgs,
): McpToolResult | null {
  const message = castableArgError(args, spec);
  return message === null ? null : toolError(message);
}

/**
 * The same check as `guardCastableArgs`, as a bare message.
 *
 * A bulk tool validates one ELEMENT at a time and has to prefix the refusal
 * with that element's index before it becomes the reply, which it cannot do
 * once the message is sealed inside an `McpToolResult`.
 */
export function castableArgError(
  args: Record<string, unknown>,
  spec: CastableArgs,
): string | null {
  for (const key of spec.uuid ?? []) {
    const value = strArg(args, key);
    if (value !== undefined && !UUID_RE.test(value)) return `invalid ${key}`;
  }
  for (const key of spec.date ?? []) {
    const value = strArg(args, key);
    if (value !== undefined && !isRealCalendarDate(value)) return `invalid ${key}`;
  }
  return null;
}

/**
 * Same guard for a list of ids (`transaction_ids`, journal line `account_id`s).
 *
 * Names the offending ELEMENT, not the array: a 200-id batch rejected as
 * "invalid transaction_ids" tells an agent only that one of two hundred is
 * wrong, which it then has to bisect. `labelAt` builds the position — indices
 * must be those of the array the AGENT sent, so validate before any filtering.
 *
 * The value is echoed back because it is the agent's own input (nothing of
 * ours leaks through it), truncated so a pathological string cannot bloat the
 * reply.
 */
export function guardUuidList(
  values: readonly unknown[],
  labelAt: (index: number) => string,
): McpToolResult | null {
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (typeof value !== 'string' || !UUID_RE.test(value)) {
      return toolError(`invalid ${labelAt(i)}: ${JSON.stringify(truncateForMessage(value))}`);
    }
  }
  return null;
}

const MAX_ECHOED_CHARS = 48;

/** Echo an agent's bad value back readably without letting it bloat the reply. */
function truncateForMessage(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value);
  return text.length > MAX_ECHOED_CHARS ? `${text.slice(0, MAX_ECHOED_CHARS)}…` : text;
}

/**
 * A code this codebase's own refusal classes carry: SCREAMING_SNAKE, so it
 * always contains an underscore. A pg SQLSTATE is five upper-case
 * alphanumerics and never does, and neither does a Node system code (ENOENT,
 * ECONNRESET) — so "has an underscore" admits exactly the application refusals
 * and nothing whose text could carry schema or filesystem detail.
 */
const NAMED_CODE_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

/**
 * Surface a service error's message ONLY when it is an application-level
 * refusal. pg / driver errors always carry a SQLSTATE `code` and could leak
 * schema names — those return the generic fallback instead.
 *
 * "No `code` at all" is NOT the test, and used to be: the services now raise
 * their refusals as typed classes carrying a NAMED code
 * (`SUPPLIER_PAYMENT_REFUSED`, `BANK_ALLOCATION_REFUSED`, `RECEIPT_REFUSED`),
 * and the old predicate read every one of them as a driver error and replaced
 * the remedy with the fallback. An agent that is told "Could not apply this
 * payment." instead of "Invoice INV-9 is cancelled and cannot receive a
 * payment." retries the same call. So the SHAPE of the code decides, the way
 * `safeLineDetail` already decides it — tighter here, because this helper
 * returns the raw message rather than a capped one.
 */
export function safeErrorText(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback;
  const code = (err as { code?: unknown }).code;
  if (code === undefined) return err.message;
  return typeof code === 'string' && NAMED_CODE_RE.test(code) ? err.message : fallback;
}

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
