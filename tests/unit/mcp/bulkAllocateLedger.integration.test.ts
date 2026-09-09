// Durable invocation lifecycle is exercised separately by registryInvocation and PostgreSQL suites.
vi.mock('@/lib/mcp/invocationBoundary', () => ({ withMcpInvocation: async (_name: string, _args: unknown, run: (mark: () => void) => Promise<unknown>) => run(() => undefined) }));
// Tool argument contracts are independently covered for every registered schema.
vi.mock('@/lib/mcp/inputValidation', () => ({ validateToolArguments: (_tool: unknown, args: unknown) => ({ ok: true, args }) }));
// Current authority is independently covered by forensic/currentToolAuthority and real PostgreSQL permission tests.
vi.mock('@/lib/mcp/currentToolAuthority', () => ({ assertCurrentToolAuthority: vi.fn(async () => undefined) }));
/**
 * bulk_allocate_bank_transactions against a REAL ledger.
 *
 * Every other test in this suite mocks `allocateTransaction`, so all of them
 * would still pass if the all-or-nothing guard did nothing at the database
 * level. This one posts real journals through the real service on isaflow_dev
 * and then asserts the ledger itself, because that is the only place the
 * property actually lives:
 *
 *   registry.call wraps a write tool in ONE withSavepoint, which rolls back
 *   only on a THROW. Swap the tool's rethrow for a `catch → toolError` and the
 *   savepoint RELEASES instead — the journals the earlier lines posted are
 *   real, committed rows. A mocked test cannot see that; a row count can.
 *
 * The whole test runs inside BEGIN … ROLLBACK on an ALS-bound client, exactly
 * as withAuth would, so nothing survives the run. That also means the savepoint
 * under test is a real one on a real connection, not a mock.
 *
 * DB-gated: skips (never fails) when no DB is reachable — see dbReachable.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { als } from '@/lib/als';
import { isDbReachable } from '../helpers/dbReachable';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getPoolForTests, sql, withSavepoint } from '@/lib/neon';
import { savepointNameFor } from '@/lib/mcp/registry';
import { bulkAllocateBankTransactionsTool } from '@/lib/mcp/tools/writeBankBulkAllocate';
import { BulkAllocationLineError } from '@/lib/mcp/bulkAllocationLineError';
import type { McpToolContext } from '@/lib/mcp/types';

type AlsCtx = Parameters<typeof als.run>[0];
function alsCtx(client: unknown, companyId: string, userId: string): AlsCtx {
  return { client, userId, companyId, claims: {} } as unknown as AlsCtx;
}

interface Fixture {
  companyId: string;
  userId: string;
  contraAccountId: string;
  txIds: string[];
}

/** A company that already has a bank account and an expense account to book to. */
async function loadFixtureIds(): Promise<Omit<Fixture, 'txIds'> & { bankAccountId: string }> {
  const rows = (await sql`
    SELECT bank.company_id, bank.id AS bank_account_id, expense.id AS contra_account_id
    FROM gl_accounts bank
    JOIN gl_accounts expense
      ON expense.company_id = bank.company_id AND expense.account_type = 'expense'
    WHERE bank.account_subtype = 'bank'
    ORDER BY bank.company_id, bank.account_code, expense.account_code
    LIMIT 1
  `) as Array<{ company_id: string; bank_account_id: string; contra_account_id: string }>;
  const row = rows[0];
  if (!row) throw new Error('no company in isaflow_dev has both a bank and an expense account');

  // created_by is NOT NULL on gl_journal_entries; reuse a user this company has
  // already posted as, so the id is guaranteed to satisfy whatever FK exists.
  const users = (await sql`
    SELECT created_by FROM gl_journal_entries
    WHERE company_id = ${row.company_id}::uuid AND created_by IS NOT NULL
    LIMIT 1
  `) as Array<{ created_by: string }>;
  const userId = users[0]?.created_by;
  if (!userId) throw new Error('no existing journal author to borrow for the fixture');

  return {
    companyId: row.company_id,
    userId,
    contraAccountId: row.contra_account_id,
    bankAccountId: row.bank_account_id,
  };
}

/**
 * EXPLICIT ids, not database-generated ones, and ordered so the third sorts
 * LAST.
 *
 * The tool posts in transaction-id order (a total order over the locked rows is
 * what stops two overlapping batches deadlocking), so with random v4 ids the
 * third fixture row posted FIRST in roughly a third of runs — and the
 * rollback test's `countJournals === before` was then vacuously true, because
 * no journal had been posted before the failure. Fixed ids make "lines 1 and 2
 * post REAL journals, then line 3 fails" the thing that actually happens every
 * run. They live inside a transaction that always rolls back, so they cannot
 * collide with anything that outlives the test.
 */
const FIXTURE_IDS = [
  '0a5af10a-0000-4000-8000-000000000001',
  '0a5af10a-0000-4000-8000-000000000002',
  // Lexically greatest of the three, so it is always posted LAST.
  'fa5af10a-0000-4000-8000-000000000003',
] as const;

/**
 * Three transactions. The third carries the fixture's variation: a status
 * allocation refuses, or an amount that makes the journal itself invalid.
 */
async function seedTransactions(
  companyId: string,
  bankAccountId: string,
  third: { status: string; amount?: number },
): Promise<string[]> {
  const ids: string[] = [];
  const rows3 = [
    { status: 'imported', amount: -100 },
    { status: 'imported', amount: -101 },
    { status: third.status, amount: third.amount ?? -102 },
  ];
  for (const [i, row] of rows3.entries()) {
    const rows = (await sql`
      INSERT INTO bank_transactions (id, company_id, bank_account_id, transaction_date, amount, description, status)
      VALUES (${FIXTURE_IDS[i]!}::uuid, ${companyId}::uuid, ${bankAccountId}::uuid, '2026-08-03'::date,
              ${row.amount}, ${`ISAFLOW BULK FIXTURE ${i}`}, ${row.status})
      RETURNING id
    `) as Array<{ id: string }>;
    ids.push(String(rows[0]!.id));
  }
  return ids;
}

/**
 * Journals THIS tool posted in THIS company since the test's transaction began.
 * A company-wide count races with other DB-gated test files committing
 * journals into the same fixture company in parallel workers; scoping by
 * posting_agent + tx start (now() is fixed for the transaction) does not.
 */
async function countJournals(companyId: string): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::INT AS n FROM gl_journal_entries
    WHERE company_id = ${companyId}::uuid
      AND posting_agent = ${'mcp:bulk_allocate_bank_transactions:v1'}
      AND created_at >= now()
  `) as Array<{ n: number }>;
  return rows[0]!.n;
}

async function statusesOf(txIds: string[]): Promise<string[]> {
  const rows = (await sql`
    SELECT status FROM bank_transactions WHERE id = ANY(${txIds}::uuid[]) ORDER BY description
  `) as Array<{ status: string }>;
  return rows.map((r) => r.status);
}

function toolCtx(f: { companyId: string; userId: string }): McpToolContext {
  return {
    companyId: f.companyId,
    userId: f.userId,
    scopes: ['write:bank-tx', 'write:post'],
    tokenJti: 'integration-test',
    oauthAppId: null,
  };
}

/** BEGIN → run → ROLLBACK on an ALS-bound client, exactly as withAuth does. */
async function inRequestTx(
  run: (f: Fixture & { bankAccountId: string }) => Promise<void>,
  third: { status: string; amount?: number },
): Promise<void> {
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    // The ALS ctx is bound before the fixture query so every statement — setup
    // and tool alike — runs on this one uncommitted connection.
    await als.run(alsCtx(client, 'bootstrap', 'bootstrap'), async () => {
      const base = await loadFixtureIds();
      const txIds = await seedTransactions(base.companyId, base.bankAccountId, third);
      await als.run(alsCtx(client, base.companyId, base.userId), () => run({ ...base, txIds }));
    });
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

describe('bulk_allocate_bank_transactions — real ledger', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('posts every line and records a reversible batch', async () => {
    await inRequestTx(async (f) => {
      const before = await countJournals(f.companyId);

      const res = await bulkAllocateBankTransactionsTool.handler(
        {
          allocations: [
            { transaction_id: f.txIds[0]!, contra_account_id: f.contraAccountId },
            { transaction_id: f.txIds[1]!, contra_account_id: f.contraAccountId },
          ],
          idempotency_key: 'integration-happy',
        },
        toolCtx(f),
      );

      expect(res.isError).toBeUndefined();
      const body = JSON.parse(res.content[0]!.text) as {
        batch_id: string; posted: number; journal_entry_ids: string[];
      };
      expect(body.posted).toBe(2);
      expect(await countJournals(f.companyId)).toBe(before + 2);

      // The journals are real and posted, not drafts.
      const posted = (await sql`
        SELECT status, posting_agent FROM gl_journal_entries
        WHERE company_id = ${f.companyId}::uuid AND id = ANY(${body.journal_entry_ids}::uuid[])
      `) as Array<{ status: string; posting_agent: string }>;
      expect(posted).toHaveLength(2);
      for (const je of posted) {
        expect(je.status).toBe('posted');
        expect(je.posting_agent).toBe('mcp:bulk_allocate_bank_transactions:v1');
      }

      // The batch is addressable and every line is recorded against it, which
      // is what reverse_bank_allocation_batch needs to undo the set.
      const batch = (await sql`
        SELECT line_count, tool FROM bank_allocation_batches
        WHERE id = ${body.batch_id}::uuid AND company_id = ${f.companyId}::uuid
      `) as Array<{ line_count: number; tool: string }>;
      expect(batch).toHaveLength(1);
      expect(batch[0]!.line_count).toBe(2);
      expect(batch[0]!.tool).toBe('bulk_allocate_bank_transactions');

      const lines = (await sql`
        SELECT bank_transaction_id, journal_entry_id FROM bank_allocation_batch_lines
        WHERE batch_id = ${body.batch_id}::uuid AND company_id = ${f.companyId}::uuid
      `) as Array<{ bank_transaction_id: string; journal_entry_id: string }>;
      expect(lines).toHaveLength(2);
      expect(lines.map((l) => l.journal_entry_id).sort()).toEqual([...body.journal_entry_ids].sort());

      const stamped = (await sql`
        SELECT status, allocation_batch_id FROM bank_transactions
        WHERE id = ANY(${[f.txIds[0]!, f.txIds[1]!]}::uuid[])
      `) as Array<{ status: string; allocation_batch_id: string | null }>;
      for (const tx of stamped) {
        expect(tx.status).toBe('allocated');
        expect(tx.allocation_batch_id).toBe(body.batch_id);
      }
    }, { status: 'imported' });
  });

  // A row the books already carry is the NORMAL case for a batch assembled off
  // a statement, and PRD §4 makes it a skip. Asserted against the real ledger
  // because the trap is a fixture: an allocated row carries a
  // matched_journal_line_id, and the only honest way to get one is to allocate
  // a row for real first.
  it.skipIf(!reachable)('skips a genuinely allocated row and posts the rest', async () => {
    await inRequestTx(async (f) => {
      const first = await bulkAllocateBankTransactionsTool.handler(
        {
          allocations: [{ transaction_id: f.txIds[0]!, contra_account_id: f.contraAccountId }],
          idempotency_key: 'integration-skip-seed',
        },
        toolCtx(f),
      );
      expect(first.isError).toBeUndefined();

      const allocated = (await sql`
        SELECT status, matched_journal_line_id FROM bank_transactions
        WHERE id = ${f.txIds[0]!}::uuid AND company_id = ${f.companyId}::uuid
      `) as Array<{ status: string; matched_journal_line_id: string | null }>;
      expect(allocated[0]!.status).toBe('allocated');
      // The column the partition reads. If this were null the test would be
      // asserting a status check, not the real row shape.
      expect(allocated[0]!.matched_journal_line_id).not.toBeNull();

      const before = await countJournals(f.companyId);

      // A dry run sees the same partition the live call will, which is the
      // whole point of deciding it BEFORE the write: an agent that checks
      // first must not be told a line will post and then find it skipped.
      const preview = await bulkAllocateBankTransactionsTool.handler(
        {
          allocations: [
            { transaction_id: f.txIds[0]!, contra_account_id: f.contraAccountId },
            { transaction_id: f.txIds[1]!, contra_account_id: f.contraAccountId },
          ],
          dry_run: true,
          idempotency_key: 'integration-skip-preview',
        },
        toolCtx(f),
      );
      const previewBody = JSON.parse(preview.content[0]!.text) as {
        would_post: number; skipped: Array<{ index: number; reason: string }>;
      };
      expect(previewBody.would_post).toBe(1);
      expect(previewBody.skipped).toEqual([
        { index: 0, transaction_id: f.txIds[0]!, reason: 'already allocated' },
      ]);
      expect(await countJournals(f.companyId)).toBe(before);

      // Same row again, alongside one that has not been allocated.
      const res = await bulkAllocateBankTransactionsTool.handler(
        {
          allocations: [
            { transaction_id: f.txIds[0]!, contra_account_id: f.contraAccountId },
            { transaction_id: f.txIds[1]!, contra_account_id: f.contraAccountId },
          ],
          idempotency_key: 'integration-skip',
        },
        toolCtx(f),
      );

      expect(res.isError).toBeUndefined();
      const body = JSON.parse(res.content[0]!.text) as {
        batch_id: string; posted: number;
        skipped: Array<{ index: number; transaction_id: string; reason: string }>;
      };
      expect(body.posted).toBe(1);
      expect(body.skipped).toEqual([
        { index: 0, transaction_id: f.txIds[0]!, reason: 'already allocated' },
      ]);
      // Exactly one NEW journal: the allocated row was never re-posted.
      expect(await countJournals(f.companyId)).toBe(before + 1);

      // The batch holds only what it posted, so reversing it cannot unwind the
      // journal the FIRST call made.
      const batch = (await sql`
        SELECT line_count FROM bank_allocation_batches
        WHERE id = ${body.batch_id}::uuid AND company_id = ${f.companyId}::uuid
      `) as Array<{ line_count: number }>;
      expect(batch[0]!.line_count).toBe(1);
      const lines = (await sql`
        SELECT bank_transaction_id FROM bank_allocation_batch_lines
        WHERE batch_id = ${body.batch_id}::uuid AND company_id = ${f.companyId}::uuid
      `) as Array<{ bank_transaction_id: string }>;
      expect(lines.map((l) => l.bank_transaction_id)).toEqual([f.txIds[1]!]);
    }, { status: 'imported' });
  });

  // The one that matters. Lines 1 and 2 post REAL journals before line 3 fails,
  // and the rollback has to take those two back out again.
  it.skipIf(!reachable)('leaves the ledger untouched when line 3 fails mid-batch', async () => {
    await inRequestTx(async (f) => {
      const before = await countJournals(f.companyId);

      // The assertion below is only worth anything if the failing line posts
      // LAST — otherwise "no journals survived" is true because none were ever
      // written. The tool posts in transaction-id order, so the fixture pins
      // that order rather than leaving it to a random v4 id.
      expect([...f.txIds].sort()).toEqual(f.txIds);

      // Exactly what registry.call() does for a write tool — the savepoint is
      // the whole mechanism, so the test must exercise the real one.
      const call = withSavepoint(
        savepointNameFor(bulkAllocateBankTransactionsTool.name),
        () => bulkAllocateBankTransactionsTool.handler(
          {
            allocations: f.txIds.map((id) => ({
              transaction_id: id, contra_account_id: f.contraAccountId,
            })),
            idempotency_key: 'integration-rollback',
          },
          toolCtx(f),
        ),
      );

      // Line 3 is a zero-amount transaction, so its journal has two zero lines
      // and `validateJournalEntry` refuses it — a GENUINE fault, reached only
      // after the pre-check passed the row as importable. (An already-allocated
      // row is no longer a fault at all; it is skipped, see the test above.)
      // The handler must let this reach the savepoint rather than dressing it
      // as a toolError — a returned envelope RELEASES the savepoint and keeps
      // the two journals lines 1-2 already posted.
      await expect(call).rejects.toThrow(BulkAllocationLineError);
      // And it must say WHICH line: an unlocatable failure is what forced the
      // pilot to bisect a 124-line batch by hand. Index 2 is also the proof
      // that the two lines before it had already posted when it blew up.
      await call.catch((err: unknown) => {
        expect((err as BulkAllocationLineError).index).toBe(2);
        expect((err as BulkAllocationLineError).transactionId).toBe(f.txIds[2]!);
        // The message the registry renders carries no SQL, whatever pg said.
        expect((err as BulkAllocationLineError).detail).not.toMatch(/relation|constraint|column/i);
      });

      expect(await countJournals(f.companyId)).toBe(before);
      expect(await statusesOf(f.txIds)).toEqual(['imported', 'imported', 'imported']);

      const batches = (await sql`
        SELECT COUNT(*)::INT AS n FROM bank_allocation_batches
        WHERE company_id = ${f.companyId}::uuid AND idempotency_key = 'integration-rollback'
      `) as Array<{ n: number }>;
      expect(batches[0]!.n).toBe(0);

      const stamped = (await sql`
        SELECT COUNT(*)::INT AS n FROM bank_transactions
        WHERE id = ANY(${f.txIds}::uuid[]) AND allocation_batch_id IS NOT NULL
      `) as Array<{ n: number }>;
      expect(stamped[0]!.n).toBe(0);
    }, { status: 'imported', amount: 0 });
  });
});
