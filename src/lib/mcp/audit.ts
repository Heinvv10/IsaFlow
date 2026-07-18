/**
 * MCP tool-call audit + idempotency persistence (mcp_tool_calls, mig 507).
 *
 * Runs inside the request's app_user GUC context, so tenant RLS holds on
 * every read/write here. Audit rows are append-only.
 */
import { createHash } from 'crypto';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
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
        ${row.idempotencyKey},
        ${row.status},
        ${JSON.stringify(row.result ?? null)}::jsonb,
        ${row.durationMs}
      )
    `;
  } catch (err) {
    // Audit failure must not mask the tool result; the unique idem index can
    // also fire here on a concurrent duplicate write (bounded by the index).
    log.error(
      'MCP audit: recordToolCall failed',
      { tool: row.tool, err: err instanceof Error ? err.message : String(err) },
      'mcp',
    );
  }
}

export async function findIdempotentReplay(
  companyId: string,
  tool: string,
  key: string,
): Promise<McpToolResult | null> {
  const rows = (await sql`
    SELECT result FROM mcp_tool_calls
    WHERE company_id = ${companyId}::uuid
      AND tool = ${tool}
      AND idempotency_key = ${key}
      AND status = 'ok'
    LIMIT 1
  `) as Row[];
  if (rows.length === 0) return null;
  return rows[0]!.result as McpToolResult;
}
