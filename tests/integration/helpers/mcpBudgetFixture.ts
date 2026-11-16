/**
 * The MCP budget tool suites' harness: a call goes through the REAL registry (mcpRegistry: scope, role fence,
 * idempotency, the tool's savepoint, the audit row) inside a request transaction opened exactly as the bearer
 * pipeline opens one (src/lib/auth/bearerPipeline.ts): SET LOCAL ROLE app_user, the token user's claims and
 * the company as transaction-local settings, the ALS context bound. Committed on return, rolled back on a throw.
 * Plus direct reads of what a call left: cells, token, audit rows, snapshots, mcp_tool_calls.
 */
import type { Pool } from 'pg';
import { als } from '@/lib/als';
import { mcpRegistry } from '@/lib/mcp/toolIndex';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';
import type { SetupUser } from './onboardingSetupFixture';

export interface McpOpts { role?: string; scopes?: string[]; jti?: string }

export const FULL_SCOPES = ['read:reports', 'write:budgets'];

export async function mcp(pool: Pool, u: SetupUser, name: string, args: Record<string, unknown>, opts: McpOpts = {}): Promise<McpToolResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    const claims = { sub: u.userId, role: 'authenticated', company_id: u.homeCompanyId };
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    await client.query(`SELECT set_config('app.current_company_id', $1, true)`, [u.homeCompanyId]);
    const ctx: McpToolContext = {
      userId: u.userId, companyId: u.homeCompanyId, scopes: opts.scopes ?? FULL_SCOPES, tokenJti: opts.jti ?? 'jti-mcp-budget',
      oauthAppId: null, companyRole: opts.role ?? 'owner', authMethod: 'pat',
    };
    const out = await als.run({ client, userId: u.userId, companyId: u.homeCompanyId, claims } as never, () => mcpRegistry.call(name, args, ctx));
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export const text = (r: McpToolResult): string => r.content[0]!.text;
export const body = (r: McpToolResult): Record<string, unknown> => {
  if (r.isError) throw new Error(`tool refused: ${text(r).slice(0, 400)}`);
  return JSON.parse(text(r)) as Record<string, unknown>;
};

export function mcpReads(pool: Pool) {
  const snapshots = async (versionId: string) => (await pool.query(
    `SELECT id, tool, token_jti, token_before, token_after, cells, created_by, restored_at, restored_by
       FROM budget_write_snapshots WHERE version_id = $1 ORDER BY created_at`, [versionId])).rows as Array<{
      id: string; tool: string; token_jti: string; token_before: string; token_after: string; cells: Array<Record<string, unknown>>;
      created_by: string; restored_at: Date | null; restored_by: string | null;
    }>;
  const toolCalls = async (companyId: string, tool: string) => (await pool.query(
    `SELECT status, idempotency_key FROM mcp_tool_calls WHERE company_id = $1 AND tool = $2 ORDER BY created_at`, [companyId, tool])).rows as
    Array<{ status: string; idempotency_key: string | null }>;
  const status = async (versionId: string) => String((await pool.query('SELECT status FROM budget_versions WHERE id = $1', [versionId])).rows[0]?.status);
  return { snapshots, toolCalls, status };
}
