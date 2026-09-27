/**
 * cancelReconciliation against a real Postgres.
 *
 * The unit tests mock `sql`, so they prove the shape of the statements but not
 * that they run. These prove the actual effect on real rows: a matched
 * transaction goes back to 'imported' with its link cleared, an allocated one
 * keeps its status and its journal line, and the header is gone. Drop the
 * `status = 'matched'` filter from the revert and the allocated assertions go
 * red; drop the adjustment pre-check and the second case does.
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
import {
  cancelReconciliation,
  ReconciliationNotCancellableError,
} from '@/modules/accounting/services/bank/bankReconciliationCancelService';

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

/**
 * Two journal lines no bank transaction in the company is matched to yet.
 * `uq_bank_tx_matched_line` (migration 657) allows one transaction per
 * (company, journal line), so the matched and the allocated fixture rows need
 * a line each, and neither may be one a real row already holds.
 */
async function findFreeJournalLines(client: PoolClient, companyId: string): Promise<[string, string] | null> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT l.id FROM gl_journal_lines l
      WHERE l.company_id = $1
        AND NOT EXISTS (SELECT 1 FROM bank_transactions t
                         WHERE t.company_id = l.company_id AND t.matched_journal_line_id = l.id)
      ORDER BY l.id LIMIT 2`, [companyId],
  );
  return rows.length === 2 ? [rows[0]!.id, rows[1]!.id] : null;
}

describe('cancelReconciliation (real DB)', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('releases transactions and deletes the header', async (ctx) => {
    assertNotProductionDb();
    const client = await getPoolForTests().connect();
    try {
      const fixture = await findBankFixture(client);
      if (!fixture) { ctx.skip('no company with a bank + expense GL account'); return; }
      const lines = await findFreeJournalLines(client, fixture.companyId);
      if (!lines) { ctx.skip('no two unmatched journal lines for the fixture'); return; }
      const [matchedLineId, journalLineId] = lines;

      await client.query('BEGIN');
      const reconId = await insertRecon(client, fixture);
      const matchedTx = await insertTx(client, fixture, reconId, 'matched', matchedLineId);
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


  it.skipIf(!reachable)('refuses while a posted adjustment journal references it', async (ctx) => {
    assertNotProductionDb();
    const client = await getPoolForTests().connect();
    try {
      const fixture = await findBankFixture(client);
      if (!fixture) { ctx.skip('no company with a bank + expense GL account'); return; }

      await client.query('BEGIN');
      const reconId = await insertRecon(client, fixture);
      const txId = await insertTx(client, fixture, reconId, 'imported', null);
      // The link lives on source_record_id (migration 526) — source_document_id
      // FKs to captured_documents and would refuse this insert outright.
      await client.query(
        `INSERT INTO gl_journal_entries
           (company_id, entry_date, description, source, source_record_id, status, created_by)
         VALUES ($1, CURRENT_DATE, 'Bank recon adjustment: fixture', 'auto_bank_recon', $2, 'posted', $3)`,
        [fixture.companyId, reconId, USER_ID],
      );

      await expect(als.run(ctxFor(client, fixture.companyId), () =>
        cancelReconciliation(fixture.companyId, reconId, USER_ID)))
        .rejects.toBeInstanceOf(ReconciliationNotCancellableError);

      // Nothing released, header still there.
      const tx = await client.query<{ reconciliation_id: string | null }>(
        'SELECT reconciliation_id FROM bank_transactions WHERE id = $1', [txId]);
      expect(tx.rows[0]!.reconciliation_id).toBe(reconId);
      const header = await client.query('SELECT id FROM bank_reconciliations WHERE id = $1', [reconId]);
      expect(header.rowCount).toBe(1);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }, 30_000);

  it.skipIf(!reachable)('refuses while a DRAFT adjustment journal references it', async (ctx) => {
    // A draft is what createAdjustmentEntry leaves behind when the insert
    // succeeds and the post then fails. Cancelling under it would let that
    // draft be posted later against a reconciliation that no longer exists.
    assertNotProductionDb();
    const client = await getPoolForTests().connect();
    try {
      const fixture = await findBankFixture(client);
      if (!fixture) { ctx.skip('no company with a bank + expense GL account'); return; }

      await client.query('BEGIN');
      const reconId = await insertRecon(client, fixture);
      await client.query(
        `INSERT INTO gl_journal_entries
           (company_id, entry_date, description, source, source_record_id, status, created_by)
         VALUES ($1, CURRENT_DATE, 'Draft recon adjustment', 'auto_bank_recon', $2, 'draft', $3)`,
        [fixture.companyId, reconId, USER_ID],
      );

      // Assert the PRE-CHECK's wording, not just the error type: the DELETE's
      // own guard also refuses drafts, so a type-only assertion would pass even
      // with 'draft' dropped from the pre-check.
      await expect(als.run(ctxFor(client, fixture.companyId), () =>
        cancelReconciliation(fixture.companyId, reconId, USER_ID)))
        .rejects.toThrow(/reverse them first/);

      const header = await client.query('SELECT id FROM bank_reconciliations WHERE id = $1', [reconId]);
      expect(header.rowCount).toBe(1);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }, 30_000);

});
