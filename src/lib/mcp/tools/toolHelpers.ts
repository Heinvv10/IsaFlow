/**
 * Shared helpers for MCP tool handlers. Keep tiny and dependency-free —
 * every tool file uses these to build results and sanitise inputs.
 */
import type { McpToolResult } from '../types';

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
