/**
 * An MCP tool run as the bearer pipeline runs it (app_user, the token user's
 * claims with no session id, the company GUC, the caller's role), committed,
 * and THEN its after-commit work started — as bearerPipeline does — so an
 * automatic snapshot a tool queues actually runs.
 */
import type { Pool } from 'pg';
import { als, type RequestContext } from '../../src/lib/als';
import { drainAfterCommit } from '../../src/lib/afterCommit';
import { McpRegistry } from '../../src/lib/mcp/registry';
import type { McpTool } from '../../src/lib/mcp/types';

export async function mcpRun(pool: Pool, tools: McpTool[], user: string, c: string, role: string, name: string,
  args: Record<string, unknown>, scopes: string[]): Promise<{ isError?: boolean; content: { text: string }[] }> {
  const registry = new McpRegistry();
  for (const t of tools) registry.register(t);
  const client = await pool.connect();
  const claims = { sub: user, role: 'authenticated', company_id: c };
  const ctx = { client, userId: user, companyId: c, claims, afterCommit: [] } as unknown as RequestContext;
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [c]);
    const tool = tools.find((t) => t.name === name)!;
    const out = await als.run(ctx, () => registry.call(name, tool.write ? { idempotency_key: crypto.randomUUID(), ...args } : args,
      { userId: user, companyId: c, scopes, tokenJti: 'audit', oauthAppId: null, companyRole: role }));
    ctx.finished = true;
    await client.query('COMMIT');
    drainAfterCommit(ctx);
    return out as { isError?: boolean; content: { text: string }[] };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
}
