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
  for (const key of spec.uuid ?? []) {
    const value = strArg(args, key);
    if (value !== undefined && !UUID_RE.test(value)) return toolError(`invalid ${key}`);
  }
  for (const key of spec.date ?? []) {
    const value = strArg(args, key);
    if (value !== undefined && !isRealCalendarDate(value)) return toolError(`invalid ${key}`);
  }
  return null;
}

/** Same guard for a list of ids (`transaction_ids`, journal line `account_id`s). */
export function guardUuidList(ids: readonly string[], argName: string): McpToolResult | null {
  return ids.every((id) => UUID_RE.test(id)) ? null : toolError(`invalid ${argName}`);
}

/**
 * Surface a service error's message ONLY when it is an application-level
 * validation error (a hand-thrown Error with no SQLSTATE `code`). pg / driver
 * errors always carry a `code` (e.g. '23505', '42703') and could leak schema
 * names — those return the generic fallback instead.
 */
export function safeErrorText(err: unknown, fallback: string): string {
  if (err instanceof Error && (err as { code?: unknown }).code === undefined) {
    return err.message;
  }
  return fallback;
}
