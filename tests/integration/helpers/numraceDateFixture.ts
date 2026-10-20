/**
 * A seeded company (l1FifoFixture) with 2025 open and its 6000 expense account, for the ledger-date window tests
 * (numrace-date-window, numrace-journal-date).
 */
import { sql } from '@/lib/neon';
import type { McpToolContext } from '@/lib/mcp/types';
import { seedFixture, type Fixture } from './l1FifoFixture';
import { openYear } from './jenumFixture';

export interface DateFixture { fx: Fixture; expense: string }

export async function seedDateFixture(prefix: string, databaseUrl: string): Promise<DateFixture> {
  const fx = await seedFixture(prefix, databaseUrl);
  await openYear(fx, 2025);
  const expense = String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID
    AND account_code = '6000'`) as Record<string, unknown>[])[0]!.id);
  return { fx, expense };
}

export function toolCtx(c: DateFixture): McpToolContext {
  return { companyId: c.fx.companyId, userId: c.fx.userId, scopes: ['write:bank-tx', 'write:post'],
    companyRole: 'owner', tokenJti: 'numrace', oauthAppId: null };
}
