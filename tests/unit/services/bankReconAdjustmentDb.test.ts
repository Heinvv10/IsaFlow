/**
 * createAdjustmentEntry, end to end against a real Postgres.
 *
 * This path was DEAD: it wrote the reconciliation id into
 * `source_document_id`, which migration 409 gave an FK to captured_documents,
 * so every adjustment failed the insert and the action 400'd. It now writes
 * `source_record_id` (migration 526). Put it back on `source_document_id` and
 * this goes red on fk_gl_je_source_document — which is the production bug.
 *
 * Runs inside a rolled-back transaction, so the posted journal never survives.
 */
import { describe, it, expect, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { isDbReachable } from '../helpers/dbReachable';
import { assertNotProductionDb } from '../helpers/bankDbFixture';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getPoolForTests } from '@/lib/neon';
import { createAdjustmentEntry } from '@/modules/accounting/services/bank/bankReconciliationService';

const USER_PLACEHOLDER = '00000000-0000-0000-0000-0000000000aa';

interface Fixture {
  companyId: string; bankAccountId: string; contraAccountId: string; userId: string;
}

/**
 * A company that can actually take a POSTED journal today: bank + expense
 * accounts, an open fiscal period covering the date, and a real member to
 * post as (resolveUserUuid rejects an id that is not one).
 */
async function findPostableFixture(client: PoolClient): Promise<Fixture | null> {
  const { rows } = await client.query<{
    company_id: string; bank_id: string; exp_id: string; user_id: string;
  }>(`
    SELECT b.company_id, b.id AS bank_id, e.id AS exp_id, cu.user_id
    FROM gl_accounts b
    JOIN gl_accounts e ON e.company_id = b.company_id
      AND e.account_type = 'expense' AND e.is_active
    JOIN fiscal_periods fp ON fp.company_id = b.company_id
      AND fp.status = 'open' AND CURRENT_DATE BETWEEN fp.start_date AND fp.end_date
    JOIN company_users cu ON cu.company_id = b.company_id
    WHERE b.account_subtype = 'bank' AND b.is_active
    ORDER BY b.company_id, e.account_code
    LIMIT 1
  `);
  const r = rows[0];
  return r ? {
    companyId: r.company_id, bankAccountId: r.bank_id,
    contraAccountId: r.exp_id, userId: r.user_id,
  } : null;
}

describe('createAdjustmentEntry (real DB)', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('posts the adjustment and links the reconciliation', async (ctx) => {
    assertNotProductionDb();
    const client = await getPoolForTests().connect();
    try {
      const fixture = await findPostableFixture(client);
      if (!fixture) { ctx.skip('no company with a bank + expense account in an open period'); return; }

      await client.query('BEGIN');
      const recon = await client.query<{ id: string }>(
        `INSERT INTO bank_reconciliations
           (company_id, bank_account_id, statement_date, statement_balance, gl_balance, started_by)
         VALUES ($1, $2, CURRENT_DATE, 0, 0, $3) RETURNING id`,
        [fixture.companyId, fixture.bankAccountId, USER_PLACEHOLDER],
      );
      const reconId = recon.rows[0]!.id;

      const alsCtx = {
        client, userId: fixture.userId, companyId: fixture.companyId, claims: {},
      } as unknown as Parameters<typeof als.run>[0];
      const journalEntryId = await als.run(alsCtx, () => createAdjustmentEntry(
        fixture.companyId, reconId, fixture.bankAccountId, fixture.contraAccountId,
        150, 'recon adjustment fixture', fixture.userId,
      ));

      const je = await client.query<{
        status: string; source: string;
        source_record_id: string | null; source_document_id: string | null;
      }>(
        `SELECT status, source, source_record_id, source_document_id
         FROM gl_journal_entries WHERE id = $1 AND company_id = $2`,
        [journalEntryId, fixture.companyId],
      );
      expect(je.rows[0]).toMatchObject({
        status: 'posted', source: 'auto_bank_recon',
        source_record_id: reconId, source_document_id: null,
      });

      // Balanced, and against the two accounts asked for.
      const lines = await client.query<{ debit: string; credit: string; gl_account_id: string }>(
        'SELECT debit, credit, gl_account_id FROM gl_journal_lines WHERE journal_entry_id = $1',
        [journalEntryId],
      );
      expect(lines.rowCount).toBe(2);
      const totalDebit = lines.rows.reduce((s, l) => s + Number(l.debit), 0);
      const totalCredit = lines.rows.reduce((s, l) => s + Number(l.credit), 0);
      expect(totalDebit).toBeCloseTo(150, 2);
      expect(totalCredit).toBeCloseTo(150, 2);
      expect(lines.rows.map(l => l.gl_account_id).sort()).toEqual(
        [fixture.bankAccountId, fixture.contraAccountId].sort(),
      );
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }, 30_000);
});
