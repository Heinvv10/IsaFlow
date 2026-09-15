/**
 * K-144 (review r2 H-A) — migration 657's pre-index dedupe pass.
 *
 * The pass has to resolve every existing double-binding before the unique index
 * can be built, and only ONE shape can be resolved without guessing: a loser
 * whose status is still `matched` owns no journal, so releasing it strands
 * nothing. Any other loser carries a posted journal that is navigated to by
 * `matched_journal_line_id` — releasing it both orphans that journal and leaves
 * `status='allocated'` with a NULL link, which is exactly the state
 * `lockForStatusWrite` tests for, so the anti-orphan guard stops firing.
 *
 * Each case drops the already-built index, plants one shape, runs the real
 * migration file, asserts, and rolls the whole thing back.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const MIGRATION = readFileSync(
  join(process.cwd(), 'scripts/migrations/sql/657_bank_tx_matched_line_unique.sql'), 'utf8');

const COMPANY = randomUUID();
const USER = randomUUID();

let admin: Pool;
let bankAccount = '';
let line = '';

/** Plant one double-binding on `line`, run 657, return the settled rows. */
async function runMigrationOn(
  client: PoolClient, statuses: readonly string[],
): Promise<{ id: string; status: string; link: string | null }[]> {
  // IF EXISTS: on a database where db:migrate has not applied 657 yet, a bare
  // DROP errors in setup and every case reports a failure that is not real.
  await client.query('DROP INDEX IF EXISTS uq_bank_tx_matched_line');
  const ids: string[] = [];
  for (let i = 0; i < statuses.length; i++) {
    const r = await client.query(
      `INSERT INTO bank_transactions
         (company_id, bank_account_id, transaction_date, amount, description,
          status, matched_journal_line_id, created_at)
       VALUES ($1,$2,'2026-03-10',-100,$3,$4,$5, NOW() + ($6 || ' seconds')::interval)
       RETURNING id`,
      [COMPANY, bankAccount, `657 row ${i}`, statuses[i], line, String(i)]);
    ids.push(r.rows[0].id);
  }
  await client.query(MIGRATION);
  const after = await client.query(
    `SELECT id, status, matched_journal_line_id FROM bank_transactions
     WHERE company_id = $1 ORDER BY created_at`, [COMPANY]);
  return after.rows.map((r: Record<string, unknown>) => ({
    id: String(r.id),
    status: String(r.status),
    link: r.matched_journal_line_id ? String(r.matched_journal_line_id) : null,
  })).filter(r => ids.includes(r.id));
}

describeIfDb('migration 657 dedupe pass', () => {
  beforeAll(async () => {
    const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
    if (dbName === 'isaflow') throw new Error('Refusing to run against production.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 3 });
    await admin.query(
      `INSERT INTO companies (id,name,is_active) VALUES ($1,'657 Dedupe Fixture',true)`, [COMPANY]);
    const bank = await admin.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type,
         account_subtype, normal_balance, is_active)
       VALUES ($1,'1000','657 Bank','asset','bank','debit',true) RETURNING id`, [COMPANY]);
    bankAccount = bank.rows[0].id;
    const je = await admin.query(
      `INSERT INTO gl_journal_entries (company_id, entry_date, description, status, created_by)
       VALUES ($1,'2026-03-10','657 entry','posted',$2) RETURNING id`, [COMPANY, USER]);
    const jl = await admin.query(
      `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
       VALUES ($1,$2,$3,0,100,'657 line') RETURNING id`, [COMPANY, je.rows[0].id, bankAccount]);
    line = jl.rows[0].id;
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    await admin.query('DELETE FROM bank_transactions WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM gl_journal_lines WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM gl_accounts WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM companies WHERE id = $1', [COMPANY]);
    await admin.end();
  });

  it('lets the allocated owner keep the line and rewinds the matched loser to imported', async () => {
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      const rows = await runMigrationOn(c, ['allocated', 'matched']);
      expect(rows[0]).toEqual({ id: rows[0]!.id, status: 'allocated', link: line });
      expect(rows[1]).toEqual({ id: rows[1]!.id, status: 'imported', link: null });
      // No row may end in a status that claims an allocation it no longer has.
      const stranded = await c.query(
        `SELECT COUNT(*)::int AS n FROM bank_transactions
         WHERE company_id = $1 AND status IN ('allocated','reconciled')
           AND matched_journal_line_id IS NULL`, [COMPANY]);
      expect(stranded.rows[0].n).toBe(0);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }, 60000);

  it('lets the reconciled owner keep the line when the loser is merely matched', async () => {
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      const rows = await runMigrationOn(c, ['reconciled', 'matched']);
      expect(rows[0]!.status).toBe('reconciled');
      expect(rows[0]!.link).toBe(line);
      expect(rows[1]).toEqual({ id: rows[1]!.id, status: 'imported', link: null });
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }, 60000);

  // The rank between `allocated` and `reconciled` decides which row the refusal
  // NAMES. `allocated` is the one status that means an allocation posted a
  // journal for THIS row, so it is the owner and the reconciled row is the
  // borrower the human has to unwind. Ranking `reconciled` first inverts that
  // and sends them at the owner.
  it('names the reconciled borrower, not the allocated owner', async () => {
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      const planted: string[] = [];
      await c.query('DROP INDEX uq_bank_tx_matched_line');
      for (const [i, status] of ['allocated', 'reconciled'].entries()) {
        const r = await c.query(
          `INSERT INTO bank_transactions
             (company_id, bank_account_id, transaction_date, amount, description,
              status, matched_journal_line_id, created_at)
           VALUES ($1,$2,'2026-03-10',-100,$3,$4,$5, NOW() + ($6 || ' seconds')::interval)
           RETURNING id`,
          [COMPANY, bankAccount, `657 rank ${i}`, status, line, String(i)]);
        planted.push(r.rows[0].id);
      }
      const [allocatedTx, reconciledTx] = planted;
      const err = await c.query(MIGRATION).then(() => null, (e: Error) => e);
      expect(err?.message).toContain(`tx=${reconciledTx} status=reconciled`);
      expect(err?.message).not.toContain(`tx=${allocatedTx}`);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }, 60000);

  it.each([
    ['allocated + reconciled', ['allocated', 'reconciled']],
    ['two allocated', ['allocated', 'allocated']],
    ['two reconciled', ['reconciled', 'reconciled']],
    ['allocated + excluded', ['allocated', 'excluded']],
  ] as const)('refuses rather than guessing an owner: %s', async (_label, statuses) => {
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await expect(runMigrationOn(c, statuses)).rejects.toThrow(
        /Migration 657: 1 bank transaction\(s\) share a journal line/);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }, 60000);

  it('leaves a single binding and a genuinely unbound row untouched', async () => {
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      const rows = await runMigrationOn(c, ['allocated']);
      expect(rows[0]).toEqual({ id: rows[0]!.id, status: 'allocated', link: line });
      const idx = await c.query(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_bank_tx_matched_line'`);
      expect(idx.rowCount).toBe(1);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }, 60000);
});
