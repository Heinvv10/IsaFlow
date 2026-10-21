/**
 * Migration 908 on PostgreSQL: scripts/import-sage-britech.ts's Sage LIVE
 * history (source auto_migration, entry numbers SAGE-<n>) is relabelled
 * auto_gl_import, reversals with it; Sage's own opening balances ('O/B from
 * other system') and every genuine take-on stay auto_migration. Label only:
 * amounts, dates and status untouched. Idempotent. Rolled back afterwards.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
afterAll(() => pool.end());
const MIGRATION = readFileSync(join(process.cwd(), 'scripts/migrations/sql/908_relabel_sage_history_journals.sql'), 'utf8');

async function company(c: PoolClient, user: string) {
  const id = randomUUID();
  await c.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, `m908 ${id.slice(0, 8)}`]);
  const a = (await c.query(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level)
     VALUES ($1, '9001', 'A', 'asset', 'debit', 1), ($1, '9002', 'B', 'equity', 'credit', 1) RETURNING id`, [id],
  )).rows.map((r) => r.id as string);
  const journal = async (entryNumber: string | null, description: string, source = 'auto_migration', reversalOf: string | null = null) => {
    const je = (await c.query(
      `INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, source, status, created_by, reversal_of_id)
       VALUES ($1, $2, '2023-02-28', $3, $4, 'posted', $5, $6) RETURNING id`, [id, entryNumber, description, source, user, reversalOf],
    )).rows[0]!.id as string;
    await c.query(`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
      VALUES ($1, $2, $3, 100, 0, 'd'), ($1, $2, $4, 0, 100, 'c')`, [id, je, a[0], a[1]]);
    return je;
  };
  return { id, journal };
}

const label = async (c: PoolClient, id: string) => (await c.query('SELECT source FROM gl_journal_entries WHERE id = $1', [id])).rows[0]!.source as string;
/** Everything but the label, for both test companies. */
const fingerprint = async (c: PoolClient, companies: string[]) => (await c.query(
  `SELECT string_agg(concat_ws('|', e.id, e.entry_date, e.status, e.description, l.gl_account_id, l.debit, l.credit), ',' ORDER BY e.id, l.id) AS f
     FROM gl_journal_entries e JOIN gl_journal_lines l ON l.journal_entry_id = e.id
    WHERE e.company_id = ANY($1::uuid[])`, [companies],
)).rows[0]!.f as string;

describe('migration 908', () => {
  it('relabels the Sage history and its reversals, keeps Sage opening balances and genuine take-ons, changes nothing else', async () => {
    const c = await pool.connect();
    const user = randomUUID();
    await c.query('BEGIN');
    try {
      await c.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@t.local`]);
      const a = await company(c, user);
      const b = await company(c, user);
      const history = await a.journal('SAGE-1001', 'm908 Cost of sales - March 23');
      const historyReversal = await a.journal(null, 'm908 reversal of history', 'auto_migration', history);
      const deeper = await a.journal(null, 'm908 reversal of the reversal', 'auto_migration', historyReversal);
      const openingBalance = await a.journal('SAGE-1002', 'O/B from other system');
      const obReversal = await a.journal(null, 'm908 reversal of O/B', 'auto_migration', openingBalance);
      const wizardTakeOn = await a.journal(null, 'm908 Opening balances — migration import');
      const otherSource = await a.journal('SAGE-1003', 'm908 card spend', 'manual');
      const otherCompany = await b.journal('SAGE-2001', 'm908 Correction');
      const before = await fingerprint(c, [a.id, b.id]);

      await c.query(MIGRATION);

      expect(await label(c, history)).toBe('auto_gl_import');
      expect(await label(c, historyReversal)).toBe('auto_gl_import');
      expect(await label(c, deeper)).toBe('auto_gl_import');
      expect(await label(c, otherCompany)).toBe('auto_gl_import'); // the script's history, whichever company
      expect(await label(c, openingBalance)).toBe('auto_migration');
      expect(await label(c, obReversal)).toBe('auto_migration');
      expect(await label(c, wizardTakeOn)).toBe('auto_migration');
      expect(await label(c, otherSource)).toBe('manual');
      expect(await fingerprint(c, [a.id, b.id])).toBe(before); // no amount, date or status changed

      await c.query(MIGRATION); // idempotent
      expect(await label(c, openingBalance)).toBe('auto_migration');
      expect(await fingerprint(c, [a.id, b.id])).toBe(before);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});
