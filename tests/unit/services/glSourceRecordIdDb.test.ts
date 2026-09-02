/**
 * The FK fix, proven against a real Postgres.
 *
 * `gl_journal_entries.source_document_id` FKs to captured_documents
 * (fk_gl_je_source_document, migration 409). This asserts both halves of the
 * split: an arbitrary record id is accepted on `source_record_id` (migration
 * 526) and REFUSED on `source_document_id` — which is exactly what
 * createAdjustmentEntry and applyDRCVat were hitting before they were moved
 * over. Everything runs inside a rolled-back transaction.
 */
import { describe, it, expect, vi } from 'vitest';
import { isDbReachable } from '../helpers/dbReachable';
import { assertNotProductionDb, findBankFixture } from '../helpers/bankDbFixture';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getPoolForTests } from '@/lib/neon';

const USER_ID = '00000000-0000-0000-0000-0000000000aa';

describe('gl_journal_entries source columns (real DB)', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('takes a reconciliation id on source_record_id and refuses it on source_document_id', async (ctx) => {
    assertNotProductionDb();
    const client = await getPoolForTests().connect();
    try {
      const fixture = await findBankFixture(client);
      if (!fixture) { ctx.skip('no company with a bank + expense GL account'); return; }

      await client.query('BEGIN');
      const recon = await client.query<{ id: string }>(
        `INSERT INTO bank_reconciliations
           (company_id, bank_account_id, statement_date, statement_balance, gl_balance, started_by)
         VALUES ($1, $2, CURRENT_DATE, 0, 0, $3) RETURNING id`,
        [fixture.companyId, fixture.bankAccountId, USER_ID],
      );
      const reconId = recon.rows[0]!.id;

      const insert = (column: 'source_record_id' | 'source_document_id') =>
        client.query(
          `INSERT INTO gl_journal_entries
             (company_id, entry_date, description, source, ${column}, status, created_by)
           VALUES ($1, CURRENT_DATE, 'Bank recon adjustment: fixture', 'auto_bank_recon', $2, 'draft', $3)
           RETURNING id`,
          [fixture.companyId, reconId, USER_ID],
        );

      const ok = await insert('source_record_id');
      expect(ok.rowCount).toBe(1);

      // The old column still guards its own meaning — this is the exact insert
      // that was failing in production.
      await client.query('SAVEPOINT fk_probe');
      await expect(insert('source_document_id')).rejects.toThrow(/fk_gl_je_source_document/);
      await client.query('ROLLBACK TO SAVEPOINT fk_probe');

      // And the link is readable back for the cancel guard.
      const linked = await client.query(
        `SELECT id FROM gl_journal_entries
         WHERE company_id = $1 AND source = 'auto_bank_recon' AND source_record_id = $2`,
        [fixture.companyId, reconId],
      );
      expect(linked.rowCount).toBe(1);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }, 30_000);
});
