/**
 * unmatch / exclude must not clobber a committed allocation — proven against a
 * real Postgres.
 *
 * The fixture is exactly the shape the old bare UPDATE broke: a bank
 * transaction that is `allocated` and carries `matched_journal_line_id`
 * pointing at a real posted journal line. Before the guard, `unmatchTransaction`
 * set it back to `imported` and NULLed the link, leaving the journal in the GL
 * with nothing referencing it — invisible in the bank UI, still in the trial
 * balance. Remove the refusal in `bankTxStatusMutations.lockForStatusWrite` and
 * these go red on `resolves`.
 */
import { describe, it, expect, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { isDbReachable } from '../helpers/dbReachable';
import { assertNotProductionDb, findBankFixture, type BankFixture } from '../helpers/bankDbFixture';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getPoolForTests } from '@/lib/neon';
import {
  unmatchTransaction,
  excludeTransaction,
  BankTransactionAllocatedError,
} from '@/modules/accounting/services/bank/bankTxStatusMutations';

type Ctx = Parameters<typeof als.run>[0];
const USER_ID = '00000000-0000-0000-0000-0000000000aa';

function ctxFor(client: PoolClient, companyId: string): Ctx {
  return { client, userId: USER_ID, companyId, claims: {} } as unknown as Ctx;
}

/** Any posted journal line belonging to this company — the thing that must not be orphaned. */
async function findJournalLine(client: PoolClient, companyId: string): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    'SELECT id FROM gl_journal_lines WHERE company_id = $1 LIMIT 1',
    [companyId],
  );
  return rows[0]?.id ?? null;
}

describe('status mutations refuse an allocated row', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('unmatch and exclude both refuse, leaving the journal linked', async (ctx) => {
    assertNotProductionDb();
    const pool = getPoolForTests();
    const client = await pool.connect();
    let fixture: BankFixture | null = null;
    try {
      fixture = await findBankFixture(client);
      if (!fixture) {
        ctx.skip('no company with both a bank and an expense GL account');
        return;
      }
      const journalLineId = await findJournalLine(client, fixture.companyId);
      if (!journalLineId) {
        ctx.skip('no posted journal line to hang the allocation off');
        return;
      }

      // Everything happens inside one transaction that is rolled back, so the
      // fixture never reaches another test (or a human looking at dev data).
      await client.query('BEGIN');
      const ins = await client.query<{ id: string }>(
        `INSERT INTO bank_transactions
           (company_id, bank_account_id, transaction_date, amount, description, status, matched_journal_line_id)
         VALUES ($1, $2, CURRENT_DATE, -202.00, 'status-guard fixture', 'allocated', $3)
         RETURNING id`,
        [fixture.companyId, fixture.bankAccountId, journalLineId],
      );
      const txId = ins.rows[0]!.id;

      await als.run(ctxFor(client, fixture.companyId), async () => {
        await expect(unmatchTransaction(fixture!.companyId, txId))
          .rejects.toBeInstanceOf(BankTransactionAllocatedError);
        await expect(excludeTransaction(fixture!.companyId, txId, 'dup'))
          .rejects.toBeInstanceOf(BankTransactionAllocatedError);
      });

      // Untouched: still allocated, still pointing at its journal line.
      const after = await client.query<{ status: string; matched_journal_line_id: string | null }>(
        'SELECT status, matched_journal_line_id FROM bank_transactions WHERE id = $1',
        [txId],
      );
      expect(after.rows[0]!.status).toBe('allocated');
      expect(after.rows[0]!.matched_journal_line_id).toBe(journalLineId);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }, 30_000);
});
