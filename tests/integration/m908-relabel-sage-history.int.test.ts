/**
 * Migration 908 on PostgreSQL: scripts/import-sage-britech.ts's Sage LIVE
 * history (its company only; source auto_migration, entry numbers SAGE-<n>)
 * is relabelled auto_gl_import, reversals with it at any depth, each change
 * recorded in audit_log; Sage's own opening balances (by description, any
 * case and trailing punctuation, or by reference O/balance / O/B), every
 * genuine take-on and every other company stay as they are. Label only:
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

/** The company scripts/import-sage-britech.ts hardcodes: the only one 908 touches. */
const BRITECH = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c';

async function company(c: PoolClient, user: string, id: string = randomUUID()) {
  await c.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, `m908 ${id.slice(0, 8)}`]);
  const a = (await c.query(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level)
     VALUES ($1, '9001', 'A', 'asset', 'debit', 1), ($1, '9002', 'B', 'equity', 'credit', 1) RETURNING id`, [id],
  )).rows.map((r) => r.id as string);
  const journal = async (entryNumber: string | null, description: string, source = 'auto_migration', reversalOf: string | null = null, reference: string | null = null) => {
    const je = (await c.query(
      `INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, source, status, created_by, reversal_of_id, reference)
       VALUES ($1, $2, '2023-02-28', $3, $4, 'posted', $5, $6, $7) RETURNING id`, [id, entryNumber, description, source, user, reversalOf, reference],
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
      const a = await company(c, user, BRITECH);
      const b = await company(c, user);
      const history = await a.journal('SAGE-1001', 'm908 Cost of sales - March 23');
      const historyReversal = await a.journal(null, 'm908 reversal of history', 'auto_migration', history);
      const deeper = await a.journal(null, 'm908 reversal of the reversal', 'auto_migration', historyReversal);
      const openingBalance = await a.journal('SAGE-1002', 'O/B from other system', 'auto_migration', null, 'O/balance');
      const obVariant = await a.journal('SAGE-1004', 'o/b FROM other system.', 'auto_migration');
      const obByReference = await a.journal('SAGE-1005', 'Opening balance', 'auto_migration', null, 'O/B');
      const obReversal = await a.journal(null, 'm908 reversal of O/B', 'auto_migration', openingBalance);
      const wizardTakeOn = await a.journal(null, 'm908 Opening balances — migration import');
      const otherSource = await a.journal('SAGE-1003', 'm908 card spend', 'manual');
      const otherCompany = await b.journal('SAGE-2001', 'm908 Correction');
      const before = await fingerprint(c, [a.id, b.id]);
      const audit = async () => (await c.query(
        "SELECT entity_id, entity_ref, user_id, action, entity_type, changes FROM audit_log WHERE company_id = $1 AND changes->'metadata'->>'migration' = '908_relabel_sage_history_journals.sql' ORDER BY entity_ref",
        [BRITECH],
      )).rows;

      await c.query(MIGRATION);

      expect(await label(c, history)).toBe('auto_gl_import');
      expect(await label(c, historyReversal)).toBe('auto_gl_import');
      expect(await label(c, deeper)).toBe('auto_gl_import');
      for (const kept of [openingBalance, obVariant, obByReference, obReversal, wizardTakeOn]) expect(await label(c, kept)).toBe('auto_migration');
      expect(await label(c, otherSource)).toBe('manual');
      expect(await label(c, otherCompany)).toBe('auto_migration'); // not the script's company: untouched
      expect(await fingerprint(c, [a.id, b.id])).toBe(before); // no amount, date or status changed

      // Each relabelled journal's change is recorded, by its author.
      const recorded = await audit();
      expect(recorded.map((r) => r.entity_id).sort()).toEqual([history, historyReversal, deeper].sort());
      for (const r of recorded) {
        expect(r).toMatchObject({ action: 'update', entity_type: 'gl_journal_entry', user_id: user });
        expect(r.changes.fields).toEqual([{ field: 'source', label: 'Source', old: 'auto_migration', new: 'auto_gl_import' }]);
      }

      await c.query(MIGRATION); // idempotent: nothing relabelled, nothing recorded again
      expect(await label(c, openingBalance)).toBe('auto_migration');
      expect(await fingerprint(c, [a.id, b.id])).toBe(before);
      expect(await audit()).toHaveLength(3);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  // Review M2: gl_journal_entries FORCEs RLS and its only policy is TO app_user.
  // A role subject to it would see no rows, relabel none, count none and pass.
  // With row_security off it is refused instead.
  it('refuses, rather than passes as a no-op, when the role applying it is subject to RLS', async () => {
    const c = await pool.connect();
    const user = randomUUID();
    await c.query('BEGIN');
    try {
      await c.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@t.local`]);
      const a = await company(c, user, BRITECH);
      await a.journal('SAGE-1001', 'm908 Cost of sales - March 23');
      await c.query('SET LOCAL ROLE app_user');
      await expect(c.query(MIGRATION)).rejects.toThrow(/row-level security/);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});
