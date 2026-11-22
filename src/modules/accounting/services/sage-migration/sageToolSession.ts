/**
 * Calls MCP tools the way the bearer transport does (src/lib/auth/bearerPipeline.ts): one request transaction as app_user with
 * the member's claims and the company, the ALS context bound, the REAL registry (scope, role fence, company guard,
 * idempotency, the tool's savepoint, the audit row). The caller is a named member of the named company or nothing runs.
 *
 * `commit: true` is one committed request (a live batch); `commit: false` rolls the whole transaction back (the dry run:
 * everything the tools did, audit rows included, goes with it).
 */
import type { Pool } from 'pg';
import type { RequestContext } from '@/lib/als';
import { drainAfterCommit, runOwnedContext, settleAfterRollback } from '@/lib/afterCommit';
import { getCompanyMembership } from '@/lib/auth/companyMembership';
import { normalizeCompanyRole } from '@/lib/auth/companyRoles';
import { isActiveUserAccount } from '@/lib/auth/userAccountStatus';
import { mcpRegistry } from '@/lib/mcp/toolIndex';
import { rollbackFailed } from '@/lib/rollbackFailed';
import type { McpToolContext } from '@/lib/mcp/types';

export const MIGRATION_SCOPES = ['read:items', 'write:items', 'read:invoices', 'write:invoices', 'read:contacts'];

export interface ToolOutcome {
  isError: boolean;
  text: string;
  /** The parsed JSON of a successful call; null when the call was refused or the text is not JSON. */
  body: Record<string, unknown> | null;
}

export interface ToolSession {
  call(name: string, args: Record<string, unknown>): Promise<ToolOutcome>;
  readonly companyId: string;
}

export class NotAMemberError extends Error {}

const WRITE_TOOLS = new Set(mcpRegistry.listTools().filter((t) => t.write).map((t) => t.name));

function outcome(text: string, isError: boolean): ToolOutcome {
  let body: Record<string, unknown> | null = null;
  if (!isError) {
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = null; }
  }
  return { isError, text, body };
}

/**
 * Runs `fn` in one request transaction. Throws NotAMemberError when `userId` is not an active member of `companyId`.
 * A transaction the tools marked rollbackOnly, or whose COMMIT fails, is an error (`commit: true`), never a silent success.
 */
export async function withToolSession<T>(
  pool: Pool, companyId: string, userId: string, commit: boolean, fn: (s: ToolSession) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let committed = false;
  let owned: RequestContext | null = null;
  let unusable = false; // set when a ROLLBACK fails: the connection may still be inside its transaction
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    const claims = { sub: userId, role: 'authenticated', company_id: companyId };
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    await client.query(`SELECT set_config('app.current_company_id', $1, true)`, [companyId]);
    const membership = await getCompanyMembership(client, userId, companyId);
    const row = membership.rows[0];
    if (!row || row.account_user_id === null || !isActiveUserAccount(row)) {
      throw new NotAMemberError(`user ${userId} is not an active member of company ${companyId}`);
    }
    const ctx: McpToolContext = {
      userId, companyId, scopes: MIGRATION_SCOPES, tokenJti: 'sage-migration', oauthAppId: null,
      companyRole: normalizeCompanyRole(row.role), authMethod: 'pat',
    };
    const txCtx: RequestContext = { client, userId, companyId, claims, afterCommit: [], afterRollback: [] };
    owned = txCtx;
    const session: ToolSession = {
      companyId,
      call: async (name, args) => {
        // The registry's company guard: every write names the company it was told to write to.
        const sent = WRITE_TOOLS.has(name) ? { ...args, company_id: companyId } : args;
        const r = await mcpRegistry.call(name, sent, ctx);
        return outcome(r.content[0]?.text ?? '', r.isError === true);
      },
    };
    const result = await runOwnedContext(txCtx, () => fn(session));
    if (!commit) {
      unusable = await rollbackFailed(client, 'sage-migration');
      return result;
    }
    if (txCtx.rollbackOnly) throw new Error(`the request transaction was marked rollback-only: ${txCtx.rollbackOnly}`);
    await client.query('COMMIT');
    committed = true;
    drainAfterCommit(txCtx);
    return result;
  } catch (err) {
    unusable = await rollbackFailed(client, 'sage-migration');
    throw err;
  } finally {
    client.release(unusable);
    settleAfterRollback(owned, committed);
  }
}
