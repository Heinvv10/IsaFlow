/**
 * K-144 (review r3 M1) — a locked TABLE is not "this line is already matched".
 *
 * `lockBankTransactionForUpdate` issues `SET LOCAL lock_timeout = '5s'`, which
 * bounds EVERY lock wait for the rest of the request. So the 55P03 that a slow
 * peer produces on the match UPDATE is the same code a relation-level lock
 * produces — DDL, `VACUUM FULL`, or migration 657's own `CREATE UNIQUE INDEX`,
 * which holds SHARE on `bank_transactions` for the length of the build. Mapped
 * to LINE_CLAIMED unconditionally, every user matching during a deploy was told
 * their journal line is "already matched to another bank transaction", a
 * specific claim that is false, and `autoMatchTransactions` counted the row in
 * `skippedRaced` — reported to the user as "allocated by another request".
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { matchTransaction } from '@/modules/accounting/services/bank/bankTransactionQueryService';
import {
  BankMatchUnavailableError, tableLockUnavailable,
} from '@/modules/accounting/services/bank/bankTxLock';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();

let admin: Pool;
let bankAccount = '';
let line = '';
let lineTwo = '';
let txA = '';
let txB = '';

function ctx(client: PoolClient) {
  return { client, userId: USER, companyId: COMPANY, claims: {} } as never;
}

describeIfDb('K-144 M1 a table-level lock is a retryable fault, not a claimed line', () => {
  beforeAll(async () => {
    const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
    if (dbName === 'isaflow') throw new Error('Refusing to run against production.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 5 });
    await admin.query(
      `INSERT INTO companies (id,name,is_active) VALUES ($1,'M1 Table Lock Fixture',true)`, [COMPANY]);
    const bank = await admin.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type,
         account_subtype, normal_balance, is_active)
       VALUES ($1,'1000','M1 Bank','asset','bank','debit',true) RETURNING id`, [COMPANY]);
    bankAccount = bank.rows[0].id;
    const je = await admin.query(
      `INSERT INTO gl_journal_entries (company_id, entry_date, description, status, created_by)
       VALUES ($1,'2026-03-10','M1 entry','posted',$2) RETURNING id`, [COMPANY, USER]);
    const jl = await admin.query(
      `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
       VALUES ($1,$2,$3,0,100,'M1 line one'),
              ($1,$2,$3,0,100,'M1 line two') RETURNING id`,
      [COMPANY, je.rows[0].id, bankAccount]);
    line = jl.rows[0].id;
    lineTwo = jl.rows[1].id;
    const tx = await admin.query(
      `INSERT INTO bank_transactions
         (company_id, bank_account_id, transaction_date, amount, description, status)
       VALUES ($1,$2,'2026-03-10',-100,'M1 first','imported'),
              ($1,$2,'2026-03-10',-100,'M1 second','imported')
       RETURNING id`, [COMPANY, bankAccount]);
    txA = tx.rows[0].id;
    txB = tx.rows[1].id;
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

  // The discriminator itself, against real locks. NOWAIT, so the table is held
  // for milliseconds: a test that waits out the full 5s lock_timeout with the
  // table locked wedges every other integration file that writes bank rows,
  // which is why the end-to-end case below is opt-in.
  it('reports the table as unavailable while a DDL-mode lock is held, and free otherwise', async () => {
    const ddl: PoolClient = await admin.connect();
    const probe: PoolClient = await admin.connect();
    try {
      // Locked first, and the probe transaction ended before the lock is
      // released: a granted ROW EXCLUSIVE is held to the end of ITS
      // transaction, and SHARE conflicts with it, so a probe left open would
      // block the DDL client instead.
      await ddl.query('BEGIN');
      // SHARE is what a non-CONCURRENT CREATE INDEX takes.
      await ddl.query('LOCK TABLE bank_transactions IN SHARE MODE');
      await probe.query('BEGIN');
      expect(await als.run(ctx(probe), () => tableLockUnavailable())).toBe(true);
      await probe.query('ROLLBACK');
      await ddl.query('ROLLBACK');

      await probe.query('BEGIN');
      expect(await als.run(ctx(probe), () => tableLockUnavailable())).toBe(false);
      await probe.query('ROLLBACK');
    } finally {
      probe.release();
      ddl.release();
    }
  }, 60000);

  // Opt-in: holds SHARE on bank_transactions for the whole 5s lock_timeout.
  // `BANK_TABLE_LOCK_E2E=1 bun run test:integration -- <this file>`.
  (process.env.BANK_TABLE_LOCK_E2E ? it : it.skip)('a DDL lock on bank_transactions surfaces as retryable, and claims nothing about the line', async () => {
    const ddl: PoolClient = await admin.connect();
    const b: PoolClient = await admin.connect();
    await ddl.query('BEGIN');
    await b.query('BEGIN');
    try {
      // SHARE lets the row lock and the claim SELECT through and blocks only
      // the UPDATE's ROW EXCLUSIVE.
      await ddl.query('LOCK TABLE bank_transactions IN SHARE MODE');

      let caught: unknown;
      try {
        await als.run(ctx(b), () => matchTransaction(COMPANY, txB, lineTwo));
      } catch (err) { caught = err; }

      expect(caught).toBeInstanceOf(BankMatchUnavailableError);
      expect((caught as Error).message).toMatch(/retry in a moment/i);
      expect((caught as Error).message).not.toMatch(/already matched/i);

      // The savepoints rolled back cleanly: the request transaction is usable.
      const still = await b.query('SELECT 1 AS ok');
      expect(still.rows[0].ok).toBe(1);
    } finally {
      await b.query('ROLLBACK');
      await ddl.query('ROLLBACK');
      b.release();
      ddl.release();
    }
  }, 60000);

  it('a peer holding the line past lock_timeout is still LINE_CLAIMED', async () => {
    const a: PoolClient = await admin.connect();
    const b: PoolClient = await admin.connect();
    await a.query('BEGIN');
    await b.query('BEGIN');
    try {
      await als.run(ctx(a), () => matchTransaction(COMPANY, txA, line));
      let caught: unknown;
      try {
        await als.run(ctx(b), () => matchTransaction(COMPANY, txB, line));
      } catch (err) { caught = err; }
      // The table is free, so the probe is granted and the 55P03 keeps its
      // contention reading — the discriminator does not swallow the real race.
      expect(caught).not.toBeInstanceOf(BankMatchUnavailableError);
      expect((caught as Error).message).toMatch(/already matched to another bank transaction/i);
    } finally {
      await b.query('ROLLBACK');
      await a.query('ROLLBACK');
      a.release();
      b.release();
    }
  }, 60000);
});
