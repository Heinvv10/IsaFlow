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

  /** A peer locks `l`, bulk-commit (2025+2026 statement, inflows: the sweep posts nothing) waits on it, then the
   *  peer allocates `l` (its 2025 number). */
  async function peerAllocatesDuringBulkCommit(c: CrossYear, l: string) {
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
      const peerPosted = (await sql`SELECT matched_journal_line_id IS NOT NULL AS posted FROM bank_transactions
        WHERE id = ${l}::UUID`) as { posted: boolean }[];
      return { rp, rr, before, after: await deadlocks(c), peerPosted: peerPosted[0]!.posted };
    } finally {
      go();
      await p.abandon();
      await r.abandon();
    }
  }

  async function fixture(prefix: string): Promise<CrossYear> {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    const c = await seedCrossYear(prefix, DATABASE_URL!);
    made.push(c);
    return c;
  }

  it('bulk-commit (statement 2025+2026, rules on) vs a single allocation of an existing rule line: not counted as held', async () => {
    const c = await fixture('BRK-G');
    const { rp, rr, before, after, peerPosted } = await peerAllocatesDuringBulkCommit(c,
      await line(c, '33333333', '2025-12-20', 'NRRULE g'));
    process.stdout.write(`G ${JSON.stringify({ rp: rp.ok ? 'ok' : rp, rr, deadlocks: { before, after } })}\n`);
    expect(rp.ok, JSON.stringify(rp)).toBe(true);
    expect(peerPosted, 'the peer allocated the line').toBe(true);
    const data = ((rr.ok ? rr.value.body : {}) as { data?: Record<string, unknown> }).data ?? {};
    expect(data.autoPostSkippedLocked, 'a line the peer allocated is not "held, retry"').toBe(0);
    expect(after, 'pg_stat_database.deadlocks moved').toBe(before);
  }, 90000);

  it('the same vs a single allocation of an existing line a SUGGESTION rule matches: no deadlock', async () => {
    const c = await fixture('BRK-GS');
    await sql`INSERT INTO bank_categorisation_rules (company_id, rule_name, match_field, match_type, match_pattern,
        gl_account_id, priority, auto_create_entry, vat_code)
      VALUES (${c.fx.companyId}::UUID, 'NUMRACE suggestion', 'description', 'contains', 'NRSUGG', ${c.expense}::UUID, 2,
        false, 'none')`;
    const { rp, rr, before, after, peerPosted } = await peerAllocatesDuringBulkCommit(c,
      await line(c, '33333333', '2025-12-20', 'NRSUGG s'));
    process.stdout.write(`GS ${JSON.stringify({ rp: rp.ok ? 'ok' : rp, rr, deadlocks: { before, after } })}\n`);
    expect(rp.ok, JSON.stringify(rp)).toBe(true);
    expect(peerPosted, 'the peer allocated the line').toBe(true);
    expect(rr.ok && rr.value.status, JSON.stringify(rr)).toBe(200);
    expect(after, 'pg_stat_database.deadlocks moved').toBe(before);
  }, 90000);

  it('the same vs a single allocation of an existing line the import transfer re-link claims: no deadlock', async () => {
    const c = await fixture('BRK-GT');
    // A posted transfer from another bank account whose leg on this one no bank line claims yet: the import's
    // relinkTransferCounterparts row-locks every imported line here that matches it (bank/bankTransferLinkPasses).
    const other = crypto.randomUUID(), je = crypto.randomUUID(), legA = crypto.randomUUID();
    await sql`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance)
      VALUES (${other}::UUID, ${c.fx.companyId}::UUID, 'NRTA', ${`NR other bank ${c.fx.tag}`}, 'asset', 'debit')`;
    await sql`INSERT INTO gl_journal_entries (id, company_id, entry_date, description, source, status, created_by)
      VALUES (${je}::UUID, ${c.fx.companyId}::UUID, '2025-12-20', 'NR transfer', 'manual', 'draft', ${c.fx.userId}::UUID)`;
    await sql`INSERT INTO gl_journal_lines (id, company_id, journal_entry_id, gl_account_id, debit, credit)
      VALUES (${legA}::UUID, ${c.fx.companyId}::UUID, ${je}::UUID, ${other}::UUID, 0, 37),
             (gen_random_uuid(), ${c.fx.companyId}::UUID, ${je}::UUID, ${c.fx.bankAccountId}::UUID, 37, 0)`;
    await sql`UPDATE gl_journal_entries SET status = 'posted', posted_at = NOW(), posted_by = ${c.fx.userId}::UUID
      WHERE id = ${je}::UUID`;
    await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status,
        matched_journal_line_id, allocation_type)
      VALUES (${c.fx.companyId}::UUID, ${other}::UUID, '2025-12-20', -37, 'NR transfer out', 'allocated', ${legA}::UUID,
        'transfer')`;
    const l = await line(c, '33333333', '2025-12-20', 'NR transfer in');
    await sql`UPDATE bank_transactions SET amount = 37 WHERE id = ${l}::UUID`;
    const { rp, rr, before, after, peerPosted } = await peerAllocatesDuringBulkCommit(c, l);
    process.stdout.write(`GT ${JSON.stringify({ rp: rp.ok ? 'ok' : rp, rr, deadlocks: { before, after } })}\n`);
    expect(rp.ok, JSON.stringify(rp)).toBe(true);
    expect(peerPosted, 'the peer allocated the line').toBe(true);
    expect(rr.ok && rr.value.status, JSON.stringify(rr)).toBe(200);
    expect(after, 'pg_stat_database.deadlocks moved').toBe(before);
  }, 90000);
});
