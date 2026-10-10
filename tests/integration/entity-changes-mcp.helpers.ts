/**
 * An MCP tool run as the bearer pipeline runs it (app_user, the token user's
 * claims with no session id, the company GUC, the caller's role from the
 * membership check), committed — for the entity-change-history suites.
 */
import type { Pool } from 'pg';
import { als } from '../../src/lib/als';
import { McpRegistry } from '../../src/lib/mcp/registry';
import { entityHistoryTool } from '../../src/lib/mcp/tools/entityHistory';
import { updateSupplierTool } from '../../src/lib/mcp/tools/writeContacts';

const registry = new McpRegistry();
for (const tool of [entityHistoryTool, updateSupplierTool]) registry.register(tool);

export async function mcpCall(pool: Pool, user: string, c: string, role: string, name: string, args: Record<string, unknown>,
  scopes: string[] = ['read:reports', 'write:contacts']): Promise<{ isError?: boolean; content: { text: string }[] }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    const claims = { sub: user, role: 'authenticated', company_id: c };
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [c]);
    const write = name !== 'entity_history';
    const out = await als.run({ client, userId: user, companyId: c, claims, afterCommit: [] } as never, () => registry.call(name,
      write ? { idempotency_key: crypto.randomUUID(), ...args } : args,
      { userId: user, companyId: c, scopes, tokenJti: 'ech', oauthAppId: null, companyRole: role }));
    await client.query('COMMIT');
    return out as { isError?: boolean; content: { text: string }[] };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
}
