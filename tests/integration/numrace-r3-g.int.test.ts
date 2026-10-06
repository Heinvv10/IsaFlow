/**
 * NUMRACE round 3 (brk-numrace round 2, G — the misreport half): a rule-pass line that a peer allocated while the pass
 * waited for it is reported as RACED, never as `autoPostSkippedLocked` ("held, retry"): a retry would find nothing to
 * do — and the two do not deadlock (bulk-commit claims the existing rule candidates before any key: bank/
 * bulkCommitRulePass), deadlock counter flat.
 * Derived from agents/brk-numrace/brk-r2-route.int.test.ts.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest } from 'next';
import { sql } from '@/lib/neon';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { response } from './mfa-impersonation-postgres.helpers';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { dropFixture } from './helpers/l1FifoFixture';
import { settle, waitBlockedBy } from './helpers/numraceGate';
import { deadlocks, dropCrossYear, line, seedCrossYear, txn, type CrossYear } from './helpers/numraceCrossYear';

vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true) }));
vi.mock('@/lib/billing/getCompanyPlan', () => ({ getCompanyPlan: vi.fn(async () => null) }));

const DATABASE_URL = process.env.DATABASE_URL;
const made: CrossYear[] = [];

async function bulkCommit(c: CrossYear, csvContent: string) {
  const handler = (await import('../../pages/api/accounting/bank-transactions-bulk-commit')).default as
    (req: NextApiRequest, res: unknown) => Promise<unknown>;
  const result = response();
  await handler({
    method: 'POST', query: {}, companyId: c.fx.companyId, user: { id: c.fx.userId },
    body: {
      bankAccountId: c.fx.bankAccountId, bulkImportId: crypto.randomUUID(), bulkSequence: 1, filename: 'g.csv',
      fileType: 'csv', statementDate: '2026-01-31', csvContent, bankFormat: 'generic', applyBankRules: true,
    },
  } as unknown as NextApiRequest, result.res);
  return { status: result.state.statusCode, body: result.state.body as Record<string, unknown> };
}

describe.skipIf(!DATABASE_URL)('NUMRACE r3: a line a peer allocated is reported raced, not held', () => {
  afterAll(async () => {
    for (const c of made) {
      await sql`UPDATE bank_transactions SET import_batch_id = NULL WHERE company_id = ${c.fx.companyId}::UUID`;
      await sql`DELETE FROM bank_import_batches WHERE company_id = ${c.fx.companyId}::UUID`;
      await dropCrossYear(c).catch(() => undefined);
      await dropFixture(c.fx).catch(() => undefined);
    }
  }, 60000);

  it('bulk-commit (statement 2025+2026, rules on) vs a single allocation of an existing rule line: not counted as held', async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    const c = await seedCrossYear('BRK-G', DATABASE_URL!);
    made.push(c);
    const l = await line(c, '33333333', '2025-12-20', 'NRRULE g');
    // Inflows: the import's sweep posts outflows only, so nothing posts before the rule pass.
    const csv = ['Date,Description,Amount', `2025-12-30,stmt a ${c.fx.tag},10.00`, `2026-01-02,stmt b ${c.fx.tag},11.00`]
      .join('\n');
    const before = await deadlocks(c);
    const p = await txn(c);
    const r = await txn(c);
    let go!: () => void, locked!: () => void;
    const goP = new Promise<void>((res) => { go = res; });
    const lockedP = new Promise<void>((res) => { locked = res; });
    try {
      const pP = settle(p.run(async () => {
        await sql`SELECT id FROM bank_transactions WHERE id = ${l}::UUID FOR UPDATE`;
        locked();
        await goP;
        return allocateTransaction(c.fx.companyId, l, c.expense, c.fx.userId, undefined, 'account', undefined,
          undefined);
      }));
      await lockedP;
      const pR = settle(r.run(() => bulkCommit(c, csv)));
      await waitBlockedBy(c.fx.pool, p.pid);
      go();
      const [rp, rr] = [await pP, await pR];
      await new Promise((res) => setTimeout(res, 1500));
      const after = await deadlocks(c);
      const imported = (await sql`SELECT COUNT(*)::int AS n FROM bank_transactions WHERE company_id = ${c.fx.companyId}::UUID
        AND description LIKE 'stmt %'`) as { n: number }[];
      process.stdout.write(`G ${JSON.stringify({ rp: rp.ok ? 'ok' : rp, rr, deadlocks: { before, after }, imported })}\n`);
      const peerPosted = (await sql`SELECT matched_journal_line_id IS NOT NULL AS posted FROM bank_transactions
        WHERE id = ${l}::UUID`) as { posted: boolean }[];
      expect(rp.ok, JSON.stringify(rp)).toBe(true);
      expect(peerPosted[0]!.posted, 'the peer allocated the line').toBe(true);
      const data = ((rr.ok ? rr.value.body : {}) as { data?: Record<string, unknown> }).data ?? {};
      expect(data.autoPostSkippedLocked, 'a line the peer allocated is not "held, retry"').toBe(0);
      expect(after, 'pg_stat_database.deadlocks moved').toBe(before);
    } finally {
      go();
      await p.abandon();
      await r.abandon();
    }
  }, 90000);
});
