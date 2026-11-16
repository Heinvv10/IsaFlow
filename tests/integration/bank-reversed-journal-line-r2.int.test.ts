/**
 * #1518 adversarial review (brk) LOWs on the live-bank-line refusal and row 10.
 *
 *  L1  A refused INTERNAL reversal leaves every table of the company exactly as it was — `gl_journal_entries.updated_at`
 *      included: the claim and its refusals run in one savepoint, rolled back, not "released" by a second UPDATE.
 *  L2  Two bank Reverses of the two legs at once: the loser is told the line was already freed, not "retry".
 *  L3  The bank Reverse clears the transfer pointer (transfer_journal_entry_id, counterparty_account_id) on both legs.
 *  L5  A provisional_je_id never exempts a LIVE (matched) line; only a provisional's own line — status 'provisional', no
 *      matched line — is D10's.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import journalEntriesAction from '../../pages/api/accounting/journal-entries-action';
import { reverseJournalEntry } from '../../src/modules/accounting/services/gl/journalEntryPostingService';
import { reverseReconciledTransaction } from '../../src/modules/accounting/services/bank/bankAllocationService';
import { callRoute, createUser } from './r035-approval.helpers';
import { plantJournal } from './r035-pr6.helpers';
import {
  actionRoute, asToken, bankCompany, cleanupBankControlsA, lineStatus, plantBatch, plantLine, refusalOf, type BankCompany,
} from './bank-controls-a.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let act: ReturnType<typeof actionRoute>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const glReverse = (c: string, je: string) => callRoute(journalEntriesAction as never, tokens[a]!, c, 'POST',
  { id: je, action: 'reverse' }, '/api/accounting/journal-entries-action');

beforeAll(async () => { a = await createUser(pool, tokens); act = actionRoute(tokens); });
afterAll(() => cleanupBankControlsA(pool, companies, [a])); // ends the pool

async function linkedTransfer() {
  const f = await bankCompany(pool, [[a, 'admin']], companies);
  const out = await plantLine(pool, f, await plantBatch(pool, f, a), -910);
  const inn = (await pool.query(`INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status)
    VALUES ($1, $2, DATE '2026-09-01', 910, 'BC line in', 'imported') RETURNING id`, [f.c, f.bank2])).rows[0].id as string;
  const res = await act(a, f.c, { action: 'allocate', bankTransactionId: out, allocationType: 'transfer', contraAccountId: f.bank2 });
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  expect(await lineStatus(pool, inn)).toBe('allocated');
  return { ...f, out, inn };
}

/** md5 of every row of every table that has a company_id, for this company. */
async function everyTable(c: string): Promise<Record<string, string>> {
  const { rows: tables } = await pool.query(`SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.column_name = 'company_id' ORDER BY 1`);
  const out: Record<string, string> = {};
  for (const { table_name: t } of tables as { table_name: string }[]) {
    const { rows } = await pool.query(`SELECT md5(COALESCE(string_agg(x::TEXT, '|' ORDER BY x::TEXT), '')) AS h
      FROM "${t}" x WHERE x.company_id = $1`, [c]);
    out[t] = String(rows[0].h);
  }
  return out;
}

describe('L1: a refused internal reversal writes nothing at all', () => {
  it('every table of the company is unchanged, gl_journal_entries.updated_at included', async () => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    const line = await plantLine(pool, f, await plantBatch(pool, f, a));
    expect((await act(a, f.c, { action: 'allocate', bankTransactionId: line, allocationType: 'account', contraAccountId: f.expA })).state.statusCode).toBe(200);
    const je = (await pool.query(`SELECT jl.journal_entry_id AS je FROM bank_transactions bt
      JOIN gl_journal_lines jl ON jl.id = bt.matched_journal_line_id WHERE bt.id = $1`, [line])).rows[0].je as string;
    const before = await everyTable(f.c);
    await sleep(20); // so a touched updated_at would differ
    const err = await asToken(pool, a, f.c, async () => {
      try { await reverseJournalEntry(f.c, je, a); return null; } catch (e) { return e as { code?: string }; }
    }, { session: true });
    expect(err?.code).toBe('JOURNAL_HAS_LIVE_BANK_LINE');
    expect(await everyTable(f.c)).toEqual(before);
  });
});

describe('L2: the reverse that loses the race to the other leg\'s', () => {
  it('is told the line was already freed, not to retry', async () => {
    const t = await linkedTransfer();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let reversed!: () => void;
    const holding = new Promise<void>((r) => { reversed = r; });
    // The winner reverses one leg (both legs locked and reset) and holds its transaction open until released.
    const winner = asToken(pool, a, t.c, async () => { await reverseReconciledTransaction(t.c, t.out, a); reversed(); await gate; },
      { session: true });
    await holding;
    const loser = act(a, t.c, { action: 'reverse', bankTransactionId: t.inn });
    for (let i = 0; i < 200; i++) {
      if (Number((await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()
        AND wait_event_type = 'Lock'`)).rows[0].n) > 0) break;
      await sleep(25);
    }
    release();
    await winner;
    const res = await loser;
    expect(refusalOf(res)).toMatchObject({ status: 400,
      message: expect.stringMatching(/^This bank line was already freed: its journal was reversed meanwhile/) });
    expect({ out: await lineStatus(pool, t.out), inn: await lineStatus(pool, t.inn) }).toEqual({ out: 'imported', inn: 'imported' });
  });
});

describe('L3: the bank Reverse clears the transfer pointer on both legs', () => {
  it('transfer_journal_entry_id and counterparty_account_id are NULL on both lines', async () => {
    const t = await linkedTransfer();
    expect((await act(a, t.c, { action: 'reverse', bankTransactionId: t.out })).state.statusCode).toBe(200);
    const { rows } = await pool.query(`SELECT transfer_journal_entry_id AS t, counterparty_account_id AS cp FROM bank_transactions
      WHERE id = ANY($1) ORDER BY id`, [[t.out, t.inn]]);
    expect(rows).toEqual([{ t: null, cp: null }, { t: null, cp: null }]);
  });
});

describe('L5: provisional_je_id never exempts a LIVE line; only a provisional\'s own line is D10\'s', () => {
  async function allocatedWithProvisional(own: boolean, status = 'allocated') {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    const line = await plantLine(pool, f, await plantBatch(pool, f, a));
    expect((await act(a, f.c, { action: 'allocate', bankTransactionId: line, allocationType: 'account', contraAccountId: f.expA })).state.statusCode).toBe(200);
    const je = (await pool.query(`SELECT jl.journal_entry_id AS je FROM bank_transactions bt
      JOIN gl_journal_lines jl ON jl.id = bt.matched_journal_line_id WHERE bt.id = $1`, [line])).rows[0].je as string;
    const other = own ? je : await plantJournal(pool, f, a, { status: 'posted' });
    // Forced: no product path writes a live match together with a provisional_je_id (brk L5, r2 L1).
    await pool.query('UPDATE bank_transactions SET provisional_je_id = $2, status = $3 WHERE id = $1', [line, other, status]);
    return { ...f, je, line };
  }
  it('a provisional of ANOTHER journal does not exempt the live line: 400', async () => {
    const f = await allocatedWithProvisional(false);
    expect(refusalOf(await glReverse(f.c, f.je))).toMatchObject({ status: 400, message: expect.stringMatching(/still allocated to it/) });
  });
  it.each(['allocated', 'matched'])('a %s line whose provisional_je_id IS the journal reversed is still refused: 400', async (status) => {
    const f = await allocatedWithProvisional(true, status);
    expect(refusalOf(await glReverse(f.c, f.je))).toMatchObject({ status: 400, message: expect.stringMatching(`still ${status} to it`) });
  });
  it('a provisional\'s own line (status provisional, no matched line) is D10\'s: the GL reversal passes', async () => {
    const f = await allocatedWithProvisional(true);
    await pool.query("UPDATE bank_transactions SET status = 'provisional', matched_journal_line_id = NULL WHERE id = $1", [f.line]);
    expect((await glReverse(f.c, f.je)).state.statusCode).toBe(200);
  });
});
