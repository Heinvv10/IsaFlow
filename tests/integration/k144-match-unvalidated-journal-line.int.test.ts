/**
 * K-144 — RED. `matchTransaction` (bankTxStatusMutations.ts:69-94 on
 * origin/master) writes `matched_journal_line_id = ${journalLineId}` straight
 * from its argument. Nothing checks that the line exists in the caller's
 * company, and nothing checks that some other bank transaction is not already
 * bound to it.
 *
 * Reachable unvalidated from two routes:
 *   pages/api/accounting/bank-transactions-action.ts:90 — `journalLineId` is
 *     only Zod-checked as a UUID (schema line 31).
 *   pages/api/accounting/bank-match-confirm.ts:260 — the `journal_line`
 *     candidate arm calls straight through, unlike the `bank_transfer` arm
 *     above it which DOES look the line up company-scoped first (line 214).
 *
 * The FK to gl_journal_lines(id) is not a tenant check: referential integrity
 * is not subject to row-level security, so a line id belonging to another
 * company is accepted and the bank row is marked `matched` against a journal
 * line that no query in this company can ever resolve.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { matchTransaction } from '@/modules/accounting/services/bank/bankTxStatusMutations';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY_A = randomUUID();
const COMPANY_B = randomUUID();
const USER = randomUUID();

let admin: Pool;
let bankTxA = '';
let bankTxA2 = '';
let foreignLine = '';
let ownLine = '';
let ownLine2 = '';

function inTx<T>(fn: () => Promise<T>): Promise<T> {
  return (async () => {
    const c: PoolClient = await admin.connect();
    await c.query('BEGIN');
    try {
      const out = await als.run({ client: c, userId: USER, companyId: COMPANY_A, claims: {} } as never, fn);
      await c.query('COMMIT');
      return out;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  })();
}

async function acct(company: string, code: string, subtype: string) {
  const r = await admin.query(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type,
       account_subtype, normal_balance, is_active)
     VALUES ($1,$2,$3,'asset',$4,'debit',true) RETURNING id`,
    [company, code, `K144 ${code}`, subtype]);
  return r.rows[0].id as string;
}

describeIfDb('K-144 a matched journal line must belong to the caller company', () => {
  beforeAll(async () => {
    const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
    if (dbName === 'isaflow') throw new Error('Refusing to run against production.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 4 });
    await admin.query(
      `INSERT INTO companies (id,name,is_active) VALUES ($1,'K144 Company A',true),($2,'K144 Company B',true)`,
      [COMPANY_A, COMPANY_B]);

    const bankA = await acct(COMPANY_A, '1000', 'bank');
    const bankB = await acct(COMPANY_B, '1000', 'bank');

    const mkLine = async (company: string, account: string, amount: number) => {
      const je = await admin.query(
        `INSERT INTO gl_journal_entries (company_id, entry_date, created_by, description)
         VALUES ($1,'2026-03-01',$2,'K144 fixture') RETURNING id`, [company, USER]);
      const jl = await admin.query(
        `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
         VALUES ($1,$2,$3,$4,0) RETURNING id`, [company, je.rows[0].id, account, amount]);
      return jl.rows[0].id as string;
    };
    foreignLine = await mkLine(COMPANY_B, bankB, 500);
    ownLine = await mkLine(COMPANY_A, bankA, 500);
    ownLine2 = await mkLine(COMPANY_A, bankA, 600);

    const tx = await admin.query(
      `INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status)
       VALUES ($1,$2,'2026-03-01',500,'K144 receipt one','imported'),
              ($1,$2,'2026-03-02',500,'K144 receipt two','imported')
       RETURNING id`, [COMPANY_A, bankA]);
    bankTxA = tx.rows[0].id;
    bankTxA2 = tx.rows[1].id;
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    const both = [[COMPANY_A, COMPANY_B]];
    await admin.query('DELETE FROM bank_transactions WHERE company_id = ANY($1)', both);
    await admin.query('DELETE FROM bank_reconciliations WHERE company_id = ANY($1)', both);
    await admin.query('DELETE FROM gl_journal_lines WHERE company_id = ANY($1)', both);
    await admin.query('DELETE FROM gl_journal_entries WHERE company_id = ANY($1)', both);
    await admin.query('DELETE FROM gl_accounts WHERE company_id = ANY($1)', both);
    await admin.query('DELETE FROM companies WHERE id = ANY($1)', [[COMPANY_A, COMPANY_B]]);
    await admin.end();
  });

  it('refuses a journal line belonging to another company', async () => {
    // Pinned to the message, not a bare toThrow: the old code raised a raw FK
    // violation here too, so any-throw would pass without the tenant check.
    await expect(inTx(() => matchTransaction(COMPANY_A, bankTxA, foreignLine)))
      .rejects.toThrow(/not found/i);
    const row = await admin.query(
      'SELECT status, matched_journal_line_id FROM bank_transactions WHERE id = $1', [bankTxA]);
    expect(row.rows[0].matched_journal_line_id).toBeNull();
    expect(row.rows[0].status).toBe('imported');
  });

  it('refuses a journal line that does not exist at all', async () => {
    const ghost = randomUUID();
    await expect(inTx(() => matchTransaction(COMPANY_A, bankTxA, ghost))).rejects.toThrow(
      /not found|does not belong|invalid/i);
  });

  it('refuses to bind one journal line to a second bank transaction', async () => {
    await inTx(() => matchTransaction(COMPANY_A, bankTxA, ownLine));
    await expect(inTx(() => matchTransaction(COMPANY_A, bankTxA2, ownLine)))
      .rejects.toThrow(/already matched to/i);
  });

  // Adjacent case: the reconciliation the match is filed under is stamped from
  // the same request and needs the same ownership check as the line.
  it('refuses a reconciliation belonging to another company', async () => {
    const bankB = await admin.query(
      'SELECT id FROM gl_accounts WHERE company_id = $1 LIMIT 1', [COMPANY_B]);
    const rec = await admin.query(
      `INSERT INTO bank_reconciliations
         (company_id, bank_account_id, statement_date, statement_balance, gl_balance, started_by)
       VALUES ($1,$2,'2026-03-31',0,0,$3) RETURNING id`,
      [COMPANY_B, bankB.rows[0].id, USER]);
    await expect(inTx(() => matchTransaction(COMPANY_A, bankTxA2, ownLine2, rec.rows[0].id)))
      .rejects.toThrow(/not found/i);
    const row = await admin.query(
      'SELECT status, reconciliation_id FROM bank_transactions WHERE id = $1', [bankTxA2]);
    expect(row.rows[0].reconciliation_id).toBeNull();
    expect(row.rows[0].status).toBe('imported');
  });

  // Adjacent case: re-matching the SAME bank transaction to the line it already
  // holds must still be allowed — the uniqueness check is about OTHER rows, and
  // the retry of an interrupted request is the ordinary case.
  it('lets a transaction be re-matched to the line it already holds', async () => {
    const again = await inTx(() => matchTransaction(COMPANY_A, bankTxA, ownLine));
    expect(again.matchedJournalLineId).toBe(ownLine);
  });
});
