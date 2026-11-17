/**
 * #1518 review round 1 on the live-bank-line refusal (bank/liveBankLineReversal) and row 10 (transferLegReset).
 *
 *  - A RECONCILED line that no completed reconciliation holds — the Sage import's (no reconciliation) or the anomaly on
 *    an unfinished one — is not refused by the GL: the bank Reverse refuses those for good, so "undo it from Bank
 *    Transactions" was a dead end (D12: keep today's behaviour). A line MATCHED into an open session still refuses.
 *  - An entry already reversed is answered "already reversed", not as a live line.
 *  - Row 10: the other leg is judged and audited as the reversed line is (step 2, assertMayReverse / auditedReversal).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import journalEntriesAction from '../../pages/api/accounting/journal-entries-action';
import bankTransfers from '../../pages/api/accounting/bank-transfers';
import { reverseJournalEntry } from '../../src/modules/accounting/services/gl/journalEntryPostingService';
import { callRoute, createUser } from './r035-approval.helpers';
import {
  actionRoute, asToken, bankCompany, cleanupBankControlsA, enforce, lineStatus, plantBatch, plantLine, refusalOf, type BankCompany,
} from './bank-controls-a.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let b = '';
let act: ReturnType<typeof actionRoute>;
const glReverse = (user: string, c: string, je: string) => callRoute(journalEntriesAction as never, tokens[user]!, c, 'POST',
  { id: je, action: 'reverse' }, '/api/accounting/journal-entries-action');
const contras = async (je: string) => (await pool.query(
  "SELECT count(*)::INT AS n FROM gl_journal_entries WHERE reversal_of_id = $1 AND status = 'posted'", [je])).rows[0].n as number;

beforeAll(async () => { a = await createUser(pool, tokens); b = await createUser(pool, tokens); act = actionRoute(tokens); });
afterAll(async () => {
  await pool.query('UPDATE bank_transactions SET reconciliation_id = NULL WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM bank_reconciliations WHERE company_id = ANY($1)', [companies]);
  await cleanupBankControlsA(pool, companies, [a, b]); // ends the pool
});

/** A line (−R1 500) allocated to expA through the bank route; its journal. */
async function allocated(): Promise<BankCompany & { line: string; je: string }> {
  const f = await bankCompany(pool, [[a, 'admin'], [b, 'admin']], companies);
  const line = await plantLine(pool, f, await plantBatch(pool, f, a));
  const res = await act(a, f.c, { action: 'allocate', bankTransactionId: line, allocationType: 'account', contraAccountId: f.expA });
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  const je = (await pool.query(`SELECT jl.journal_entry_id AS je FROM bank_transactions bt
    JOIN gl_journal_lines jl ON jl.id = bt.matched_journal_line_id WHERE bt.id = $1`, [line])).rows[0].je as string;
  return { ...f, line, je };
}
const openSession = async (f: BankCompany) => (await pool.query(`INSERT INTO bank_reconciliations(bank_account_id, statement_date,
  started_by, company_id) VALUES ($1, DATE '2026-09-30', $2, $3) RETURNING id`, [f.bank, a, f.c])).rows[0].id as string;

describe('reconciled lines no completed reconciliation holds are not this rule\'s (#1518 MEDIUM)', () => {
  it('a Sage-reconciled line (no reconciliation): the GL reversal still works', async () => {
    const f = await allocated();
    await pool.query("UPDATE bank_transactions SET status = 'reconciled' WHERE id = $1", [f.line]);
    const res = await glReverse(a, f.c, f.je);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await contras(f.je)).toBe(1);
  });

  it('the anomaly (reconciled on an unfinished reconciliation): the GL reversal still works', async () => {
    const f = await allocated();
    await pool.query("UPDATE bank_transactions SET status = 'reconciled', reconciliation_id = $2 WHERE id = $1", [f.line, await openSession(f)]);
    const res = await glReverse(a, f.c, f.je);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await contras(f.je)).toBe(1);
  });

  it('a line MATCHED into an open session is live: 400 with the unmatch hint, nothing written', async () => {
    const f = await allocated();
    await pool.query("UPDATE bank_transactions SET status = 'matched', reconciliation_id = $2 WHERE id = $1", [f.line, await openSession(f)]);
    const res = await glReverse(a, f.c, f.je);
    expect(refusalOf(res)).toMatchObject({ status: 400, message: expect.stringMatching(/still matched to it\. Undo it from Bank Transactions.*unmatch the line/) });
    expect(await contras(f.je)).toBe(0);
  });
});

describe('an entry already reversed (#1518 LOW 4)', () => {
  it('is answered "already reversed", not as a live line, though its line still points at it', async () => {
    const f = await allocated();
    // The legacy hand reversal (the GL now refuses it while the line is live), planted through the opt-out.
    await asToken(pool, a, f.c, () => reverseJournalEntry(f.c, f.je, a, { bankLinesHandled: true }), { session: true });
    const res = await glReverse(a, f.c, f.je);
    expect(refusalOf(res)).toMatchObject({ status: 400, message: 'Journal entry already reversed' });
  });
});

describe('row 10: the other leg is judged and audited like the reversed line (#1518 LOW 3)', () => {
  it('under enforcement, reversing the IN leg writes the OUT leg\'s reversal audit too', async () => {
    const f = await bankCompany(pool, [[a, 'admin'], [b, 'admin']], companies);
    const out = await plantLine(pool, f, await plantBatch(pool, f, a), -720);
    const inn = (await pool.query(`INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status)
      VALUES ($1, $2, DATE '2026-09-01', 720, 'BC line in', 'imported') RETURNING id`, [f.c, f.bank2])).rows[0].id as string;
    const res = await act(a, f.c, { action: 'allocate', bankTransactionId: out, allocationType: 'transfer', contraAccountId: f.bank2 });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await lineStatus(pool, inn)).toBe('allocated');
    await enforce(pool, f.c, a, ['manual_journal']);
    const rev = await act(b, f.c, { action: 'reverse', bankTransactionId: inn });
    expect(rev.state.statusCode, JSON.stringify(rev.state.body)).toBe(200);
    const audited = (await pool.query(`SELECT count(*)::INT AS n FROM audit_log
      WHERE company_id = $1 AND action = 'reverse' AND entity_id = $2`, [f.c, out])).rows[0].n as number;
    expect({ out: await lineStatus(pool, out), inn: await lineStatus(pool, inn), outAudited: audited })
      .toEqual({ out: 'imported', inn: 'imported', outAudited: 1 });
  });
});

describe('the Transfers page sees a re-reversed statement transfer (#1518 LOW 5)', () => {
  it('reversed from the bank (both legs freed), put back by a GL re-reversal: typing it again asks for confirmation (428)', async () => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    const out = await plantLine(pool, f, await plantBatch(pool, f, a), -830);
    expect((await act(a, f.c, { action: 'allocate', bankTransactionId: out, allocationType: 'transfer', contraAccountId: f.bank2 })).state.statusCode).toBe(200);
    const j1 = (await pool.query('SELECT transfer_journal_entry_id AS j FROM bank_transactions WHERE id = $1', [out])).rows[0].j as string;
    expect((await act(a, f.c, { action: 'reverse', bankTransactionId: out })).state.statusCode).toBe(200);
    const r1 = (await pool.query('SELECT id FROM gl_journal_entries WHERE reversal_of_id = $1', [j1])).rows[0].id as string;
    expect((await glReverse(a, f.c, r1)).state.statusCode).toBe(200); // no live line on the chain now: allowed
    const typed = await callRoute(bankTransfers as never, tokens[a]!, f.c, 'POST',
      { fromAccountId: f.bank, toAccountId: f.bank2, amount: 830, transferDate: '2026-09-01' }, '/api/accounting/bank-transfers');
    expect(typed.state.statusCode, JSON.stringify(typed.state.body)).toBe(428);
  });
});
