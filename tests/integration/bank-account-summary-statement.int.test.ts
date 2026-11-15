/**
 * WP1 PR-B: the statement half of the bank summary, against Postgres.
 *   - `latest` is the newest STATEMENT (statement_date, then import time), not the newest import.
 *   - When the latest batch carries no balance, `lastWithBalance` falls back to the newest one that does, and the
 *     difference is taken as at THAT statement's date: a journal dated after it is not in the comparison.
 *   - No batch at all: every statement field is null.
 *   - A credit-card (liability) bank account gets the same formula as an asset one: closing − (debit − credit)
 *     (Hein 2026-11-15).
 *   - Line counts are live, and a batch with NO live line (every line undone or deleted) is never `latest` or
 *     `lastWithBalance`: its balances describe lines that are no longer there (team-lead decision, 2026-11-15).
 *   - An AI-read closing balance ('ai_read') is a figure: shown, and the difference is computed from it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { getBankAccountSummaries, type BankAccountSummary } from '@/modules/accounting/services/bank/bankAccountSummaryService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser } from './r035-approval.helpers';
import { asToken, bankCompany, cleanupBankControlsA, type BankCompany } from './bank-controls-a.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let u = '';
let f: BankCompany;
let card = '';

/** A posted journal on `date`: DR `debitAccount` / CR `creditAccount` of `amount`. */
async function journal(date: string, debitAccount: string, creditAccount: string, amount: number): Promise<void> {
  const je = (await pool.query(
    `INSERT INTO gl_journal_entries(company_id,entry_number,entry_date,description,source,status,created_by)
     VALUES($1,$2,$3::DATE,'WP1 statement','manual','draft',$4) RETURNING id`,
    [f.c, `JE-${crypto.randomUUID().slice(0, 8)}`, date, u])).rows[0].id as string;
  await pool.query(
    `INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit,description)
     VALUES($1,$2,$3,$5,0,'dr'),($1,$2,$4,0,$5,'cr')`, [f.c, je, debitAccount, creditAccount, amount]);
  await pool.query("UPDATE gl_journal_entries SET status = 'posted' WHERE id = $1", [je]);
}

/** A batch for `bank`, its statement dated `statementDate`, imported at `createdAt`, with `lines` lines naming it. */
async function batch(bank: string, statementDate: string, createdAt: string, opts: {
  opening?: number | null; closing?: number | null; source?: string | null; lines?: number;
} = {}): Promise<string> {
  const id = (await pool.query(
    `INSERT INTO bank_import_batches(company_id, bank_account_id, statement_date, transaction_count, imported_by,
       import_channel, bank_format, opening_balance, closing_balance, balance_source, created_at)
     VALUES($1,$2,$3::DATE,$4,$5,'upload','fnb',$6,$7,$8,$9::TIMESTAMPTZ) RETURNING id`,
    [f.c, bank, statementDate, opts.lines ?? 0, u, opts.opening ?? null, opts.closing ?? null,
      opts.source === undefined ? (opts.closing == null ? 'not_in_file' : 'running_balance') : opts.source,
      createdAt])).rows[0].id as string;
  for (let i = 0; i < (opts.lines ?? 0); i++) {
    await pool.query(
      `INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status, import_batch_id)
       VALUES($1,$2,$3::DATE,$4,'WP1 stmt line','imported',$5)`, [f.c, bank, statementDate, -(i + 1), id]);
  }
  return id;
}

const summary = async (id: string): Promise<BankAccountSummary> =>
  (await asToken(pool, u, f.c, () => getBankAccountSummaries(f.c, { asAt: '2026-12-31' }))).accounts.find((a) => a.id === id)!;

beforeAll(async () => {
  u = await createUser(pool, tokens);
  f = await bankCompany(pool, [[u, 'admin']], companies);
  card = (await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,account_subtype,bank_account_type)
     VALUES ($1,$2,'WP1 Credit Card','liability','credit',true,'bank','credit_card') RETURNING id`,
    [f.c, `CC${f.c.slice(0, 4)}`])).rows[0].id as string;
}, 60000);

afterAll(async () => { await cleanupBankControlsA(pool, companies, [u]); });

describe('bank account summary — statement', () => {
  it('no batch at all: latest, lastWithBalance, the ledger at the statement and the difference are null', async () => {
    expect((await summary(f.bank)).statement).toEqual({
      latest: null, lastWithBalance: null, ledgerAtStatementCents: null, differenceCents: null });
  });

  let september = '';
  let october = '';

  it('latest is the newest statement: an older month imported later does not displace it', async () => {
    september = await batch(f.bank, '2026-09-30', '2026-10-01T08:00:00Z', { opening: 900, closing: 1000.10, lines: 3 });
    await batch(f.bank, '2026-08-31', '2026-10-02T08:00:00Z', { opening: 800, closing: 900, lines: 1 });
    const s = (await summary(f.bank)).statement;
    expect(s.latest).toMatchObject({ batchId: september, statementDate: '2026-09-30', sourceLabel: 'FNB',
      balanceSource: 'running_balance', openingCents: 90000, closingCents: 100010, lineCount: 3 });
    expect(s.lastWithBalance?.batchId).toBe(september);
  });

  it('the difference is the closing balance less the ledger AS AT the statement date; later journals are left out', async () => {
    await journal('2026-09-15', f.bank, f.expA, 1000.00); // in the statement's ledger
    await journal('2026-10-15', f.bank, f.expA, 500.00); //  after it: in today's ledger only
    const s = await summary(f.bank);
    expect(s.ledgerCents).toBe(150000);
    expect(s.statement.ledgerAtStatementCents).toBe(100000);
    expect(s.statement.differenceCents).toBe(100010 - 100000);
  });

  it('falls back to the last statement with a balance when the latest has none, at that statement\'s own date', async () => {
    october = await batch(f.bank, '2026-10-31', '2026-11-01T08:00:00Z', { lines: 2 });
    const s = (await summary(f.bank)).statement;
    expect(s.latest).toMatchObject({ batchId: october, balanceSource: 'not_in_file', openingCents: null, closingCents: null,
      lineCount: 2 });
    expect(s.lastWithBalance).toMatchObject({ batchId: september, statementDate: '2026-09-30', closingCents: 100010 });
    expect({ ledger: s.ledgerAtStatementCents, difference: s.differenceCents }).toEqual({ ledger: 100000, difference: 10 });
  });

  it('counts the latest statement\'s lines live', async () => {
    await pool.query(
      'DELETE FROM bank_transactions WHERE id IN (SELECT id FROM bank_transactions WHERE company_id = $1 AND import_batch_id = $2 LIMIT 1)',
      [f.c, october]);
    expect((await summary(f.bank)).statement.latest?.lineCount).toBe(1);
  });

  it('a credit-card (liability) account: same formula, closing − (debit − credit)', async () => {
    await journal('2026-09-10', f.expA, card, 1500.00); // card spend: CR the card
    await journal('2026-09-20', card, f.expB, 200.00); //  a refund: DR the card
    await journal('2026-10-05', f.expA, card, 99.99); //   after the statement
    await batch(card, '2026-09-30', '2026-10-01T09:00:00Z', { closing: -1400.00, lines: 1 });
    const s = await summary(card);
    expect(s.accountType).toBe('liability');
    expect(s.ledgerCents).toBe(-130000 - 9999);
    expect(s.statement.ledgerAtStatementCents).toBe(-130000);
    expect(s.statement.differenceCents).toBe(-140000 - -130000);
  });

  it('skips a batch with no live line: neither latest nor lastWithBalance, even with the newest date and a balance', async () => {
    const before = (await summary(f.bank)).statement;
    const emptied = await batch(f.bank, '2026-11-30', '2026-12-01T08:00:00Z', { opening: 1, closing: 2, lines: 2 });
    expect((await summary(f.bank)).statement.latest?.batchId).toBe(emptied); // live: it is the newest statement
    await pool.query('DELETE FROM bank_transactions WHERE company_id = $1 AND import_batch_id = $2', [f.c, emptied]);
    await batch(f.bank, '2026-12-15', '2026-12-16T08:00:00Z', { closing: 5, lines: 0 }); // never had a line
    expect((await summary(f.bank)).statement).toEqual(before);
  });

  it('an AI-read closing balance is a figure: shown as ai_read, and the difference is computed from it', async () => {
    const ai = await batch(f.bank2, '2026-09-30', '2026-10-01T10:00:00Z', { closing: 250.00, source: 'ai_read', lines: 1 });
    await journal('2026-09-05', f.bank2, f.expA, 200.00);
    const s = (await summary(f.bank2)).statement;
    expect(s.lastWithBalance).toMatchObject({ batchId: ai, balanceSource: 'ai_read', closingCents: 25000 });
    expect({ ledger: s.ledgerAtStatementCents, difference: s.differenceCents }).toEqual({ ledger: 20000, difference: 5000 });
  });
});
