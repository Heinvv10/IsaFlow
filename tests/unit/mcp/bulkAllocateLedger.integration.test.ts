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

/** Three imported transactions; the third is left in a state allocation refuses. */
async function seedTransactions(
  companyId: string,
  bankAccountId: string,
  thirdStatus: string,
): Promise<string[]> {
  const ids: string[] = [];
  for (const [i, status] of ['imported', 'imported', thirdStatus].entries()) {
    const rows = (await sql`
      INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status)
      VALUES (${companyId}::uuid, ${bankAccountId}::uuid, '2026-08-03'::date,
              ${-100 - i}, ${`ISAFLOW BULK FIXTURE ${i}`}, ${status})
      RETURNING id
    `) as Array<{ id: string }>;
    ids.push(String(rows[0]!.id));
  }
  return ids;
}

async function countJournals(companyId: string): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::INT AS n FROM gl_journal_entries WHERE company_id = ${companyId}::uuid
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
  thirdStatus: string,
): Promise<void> {
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    // The ALS ctx is bound before the fixture query so every statement — setup
    // and tool alike — runs on this one uncommitted connection.
    await als.run(alsCtx(client, 'bootstrap', 'bootstrap'), async () => {
      const base = await loadFixtureIds();
      const txIds = await seedTransactions(base.companyId, base.bankAccountId, thirdStatus);
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
    }, 'imported');
  });

  // The one that matters. Lines 1 and 2 post REAL journals before line 3 fails.
  it.skipIf(!reachable)('leaves the ledger untouched when line 3 fails mid-batch', async () => {
    await inRequestTx(async (f) => {
      const before = await countJournals(f.companyId);

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

      // Line 3 is 'reconciled', which allocateTransaction refuses. The handler
      // must let that reach the savepoint rather than dressing it as a
      // toolError — a returned envelope RELEASES the savepoint and keeps the
      // two journals lines 1-2 already posted.
      await expect(call).rejects.toThrow(/cannot allocate/i);

      expect(await countJournals(f.companyId)).toBe(before);
      expect(await statusesOf(f.txIds)).toEqual(['imported', 'imported', 'reconciled']);

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
    }, 'reconciled');
  });
});
