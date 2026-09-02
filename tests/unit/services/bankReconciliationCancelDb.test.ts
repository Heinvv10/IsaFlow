/**
 * cancelReconciliation against a real Postgres.
 *
 * The unit tests mock `sql`, so they prove the shape of the statements but not
 * that they run. These prove the actual effect on real rows: a matched
 * transaction goes back to 'imported' with its link cleared, an allocated one
 * keeps its status and its journal line, and the header is gone. Drop the
 * `status = 'matched'` filter from the revert and the allocated assertions go
 * red.
 *
 * Everything runs inside one transaction that is rolled back.
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
import { cancelReconciliation } from '@/modules/accounting/services/bank/bankReconciliationCancelService';

type Ctx = Parameters<typeof als.run>[0];
const USER_ID = '00000000-0000-0000-0000-0000000000aa';

function ctxFor(client: PoolClient, companyId: string): Ctx {
  return { client, userId: USER_ID, companyId, claims: {} } as unknown as Ctx;
}

async function insertRecon(client: PoolClient, f: BankFixture): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO bank_reconciliations
       (company_id, bank_account_id, statement_date, statement_balance, gl_balance, started_by)
     VALUES ($1, $2, CURRENT_DATE, 0, 0, $3) RETURNING id`,
    [f.companyId, f.bankAccountId, USER_ID],
  );
  return rows[0]!.id;
}

async function insertTx(
  client: PoolClient, f: BankFixture, reconId: string,
  status: string, journalLineId: string | null,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO bank_transactions
       (company_id, bank_account_id, transaction_date, amount, description, status,
        matched_journal_line_id, reconciliation_id)
     VALUES ($1, $2, CURRENT_DATE, -303.00, 'cancel-recon fixture', $3, $4, $5)
     RETURNING id`,
    [f.companyId, f.bankAccountId, status, journalLineId, reconId],
  );
  return rows[0]!.id;
}

async function findJournalLine(client: PoolClient, companyId: string): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    'SELECT id FROM gl_journal_lines WHERE company_id = $1 LIMIT 1', [companyId],
  );
  return rows[0]?.id ?? null;
}

describe('cancelReconciliation (real DB)', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('releases transactions and deletes the header', async (ctx) => {
    assertNotProductionDb();
    const client = await getPoolForTests().connect();
    try {
      const fixture = await findBankFixture(client);
      if (!fixture) { ctx.skip('no company with a bank + expense GL account'); return; }
      const journalLineId = await findJournalLine(client, fixture.companyId);
      if (!journalLineId) { ctx.skip('no posted journal line for the allocation fixture'); return; }

      await client.query('BEGIN');
      const reconId = await insertRecon(client, fixture);
      const matchedTx = await insertTx(client, fixture, reconId, 'matched', journalLineId);
      const allocatedTx = await insertTx(client, fixture, reconId, 'allocated', journalLineId);
      const importedTx = await insertTx(client, fixture, reconId, 'imported', null);

      const result = await als.run(ctxFor(client, fixture.companyId), () =>
        cancelReconciliation(fixture.companyId, reconId, USER_ID));

      expect(result).toEqual({ revertedMatches: 1, releasedTransactions: 3 });

      const { rows } = await client.query<{
        id: string; status: string; matched_journal_line_id: string | null;
        reconciliation_id: string | null;
      }>(
        `SELECT id, status, matched_journal_line_id, reconciliation_id
         FROM bank_transactions WHERE id = ANY($1::UUID[])`,
        [[matchedTx, allocatedTx, importedTx]],
      );
      const byId = new Map(rows.map(r => [r.id, r]));
      expect(byId.get(matchedTx)).toMatchObject({
        status: 'imported', matched_journal_line_id: null, reconciliation_id: null,
      });
      // The allocation has a posted journal behind it — cancelling the session
      // detaches it, it does not undo it.
      expect(byId.get(allocatedTx)).toMatchObject({
        status: 'allocated', matched_journal_line_id: journalLineId, reconciliation_id: null,
      });
      expect(byId.get(importedTx)).toMatchObject({ status: 'imported', reconciliation_id: null });

      const header = await client.query('SELECT id FROM bank_reconciliations WHERE id = $1', [reconId]);
      expect(header.rowCount).toBe(0);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }, 30_000);

});
