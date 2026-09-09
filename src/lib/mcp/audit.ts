/** Tenant invocation history and separately retained financial replay receipts. */
import { createHash } from 'crypto';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { storeIdempotentResult } from './idempotencyStore';
import type { McpToolContext, McpToolResult } from './types';

type Row = Record<string, unknown>;

/** Recursively key-sorted JSON — same args always hash identically. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function hashArgs(args: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(args))).digest('hex');
}

/**
 * Serialise concurrent same-key write calls. The idempotency replay-check is
 * check-then-act: without a lock, two concurrent calls with the same key both
 * see "no prior call" (neither has committed) and both execute the write — a
 * double-post that ON CONFLICT DO NOTHING then hides in the audit trail. A
 * transaction-scoped advisory lock (auto-released on COMMIT/ROLLBACK) makes the
 * second caller block until the first commits, so its replay-check then finds
 * the committed row. Runs on the request's ALS-bound app_user tx.
 */
export async function acquireIdempotencyLock(
  companyId: string,
  tool: string,
  key: string,
): Promise<void> {
  const lockKey = `mcp:${companyId}:${tool}:${key}`;
  await sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`;
}

export async function recordToolCall(row: {
  ctx: McpToolContext;
  tool: string;
  argsHash: string;
  idempotencyKey: string | null;
  status: 'ok' | 'error' | 'rejected';
  result: unknown;
  durationMs: number;
}): Promise<void> {
  try {
    if (row.status === 'ok' && row.idempotencyKey !== null) {
      await storeIdempotentResult(row.ctx.companyId, row.tool, row.idempotencyKey, row.argsHash, row.result);
    }
    // Invocation history retention is independent of the immutable effect receipt.
    await sql`
      INSERT INTO mcp_tool_calls (
        company_id, user_id, token_jti, oauth_app_id,
        tool, args_hash, idempotency_key, status, result, duration_ms
      )
      VALUES (
        ${row.ctx.companyId}::uuid,
        ${row.ctx.userId},
        ${row.ctx.tokenJti},
        ${row.ctx.oauthAppId},
        ${row.tool},
        ${row.argsHash},
        ${null},
        ${row.status},
        ${null}::jsonb,
        ${row.durationMs}
      )
    `;
  } catch (err) {
    log.error(
      'MCP audit: recordToolCall failed',
      { tool: row.tool, err: err instanceof Error ? err.message : String(err) },
      'mcp',
    );
    // A successful keyed write must roll back when its durable receipt fails.
    if (row.status === 'ok' && row.idempotencyKey !== null) throw err;
  }
}

export type IdempotencyLookup =
  | { status: 'none' }
  | { status: 'match'; result: McpToolResult }
  | { status: 'conflict' };

/**
 * Look up a prior successful call for (company, tool, key). The args_hash is
 * compared: a reused key with DIFFERENT arguments returns 'conflict' (never the
 * stale result) so the caller can surface an explicit error instead of silently
 * reporting the first call's outcome for the second call's inputs.
 */
export async function findIdempotentReplay(
  companyId: string,
  tool: string,
  key: string,
  argsHash: string,
): Promise<IdempotencyLookup> {
  const rows = (await sql`
    SELECT result, args_hash FROM mcp_idempotency_results
    WHERE company_id = ${companyId}::uuid
      AND tool = ${tool}
      AND idempotency_key = ${key}
    LIMIT 1
  `) as Row[];
  if (rows.length === 0) return { status: 'none' };
  if (rows[0]!.args_hash !== argsHash) return { status: 'conflict' };
  return { status: 'match', result: rows[0]!.result as McpToolResult };
}
