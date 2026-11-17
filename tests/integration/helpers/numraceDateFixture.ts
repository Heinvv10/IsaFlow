/**
 * A seeded company (l1FifoFixture) with 2025 open and its 6000 expense account, for the ledger-date window tests
 * (numrace-date-window, numrace-journal-date).
 */
import { sql } from '@/lib/neon';
import type { McpToolContext } from '@/lib/mcp/types';
import { seedFixture, type Fixture } from './l1FifoFixture';
import { openYear } from './jenumFixture';

export interface DateFixture { fx: Fixture; expense: string }

/**
 * `extraYears`: calendar years the test dates lines in beyond the auto-create window (two years ahead, and a March year
 * end puts May 2028 in FY2029): a bank allocation or transfer posts only on a period that exists or can be created
 * (WP2 row 12), so a test dating a line in 2029 must open that year. Before, such a journal posted with no period.
 */
export async function seedDateFixture(prefix: string, databaseUrl: string, extraYears: readonly number[] = []): Promise<DateFixture> {
  const fx = await seedFixture(prefix, databaseUrl);
  await openYear(fx, 2025);
  for (const y of extraYears) await openYear(fx, y);
  const expense = String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID
    AND account_code = '6000'`) as Record<string, unknown>[])[0]!.id);
  return { fx, expense };
}

export function toolCtx(c: DateFixture): McpToolContext {
  return { companyId: c.fx.companyId, userId: c.fx.userId, scopes: ['write:bank-tx', 'write:post'],
    companyRole: 'owner', tokenJti: 'numrace', oauthAppId: null };
}
