/**
 * #1545 review round 2 — reverse_allocations (the MCP range reversal) under its pre-lock, against real Postgres.
 *
 *  M1    only rows the call LOCKED are reversed: a row allocated INTO the range while the call waited is left alone;
 *        and the step-2 agent refusal is asked again under the locks.
 *  M2    the reply lists what was reversed (the re-read), not the first read.
 *  LOW2  the counterpart check uses the leg set the reversal resets (the chain head's), so a counterpart matched to a
 *        re-reversal is seen by the dry run.
 *  LOW3  one 5 s deadline for the whole pre-lock, not 5 s per held line.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser } from './r035-approval.helpers';
import { actionRoute, asToken, bankCompany, cleanupBankControlsA, enforce, lineStatus, mcpCaller, type BankCompany } from './bank-controls-a.helpers';
import { reverseAllocationsTool } from '../../src/lib/mcp/tools/writeBankReverseRange';
import { reverseJournalEntry } from '../../src/modules/accounting/services/gl/journalEntryPostingService';
import { reverseReconciledTransaction } from '../../src/modules/accounting/services/bank/bankAllocationService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let act: ReturnType<typeof actionRoute>;
const mcp = mcpCaller(pool, [reverseAllocationsTool]);
const key = () => crypto.randomUUID();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Reply = { isError?: boolean; content: { text: string }[] };
type RangeOut = { reversed: number; transactions: { transaction_id: string }[] };

beforeAll(async () => { a = await createUser(pool, tokens); act = actionRoute(tokens); });
afterAll(() => cleanupBankControlsA(pool, companies, [a])); // ends the pool

const DAY = '2026-09-14';
const lineOn = async (f: BankCompany, bank: string, amount: number, desc: string) => (await pool.query(
  `INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status)
   VALUES($1,$2,$3::DATE,$4,$5,'imported') RETURNING id`, [f.c, bank, DAY, amount, desc])).rows[0].id as string;
const allocate = async (f: BankCompany, line: string, contra: string, type = 'account') => {
  const res = await act(a, f.c, { action: 'allocate', bankTransactionId: line, allocationType: type, contraAccountId: contra });
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
};
const range = (f: BankCompany, dry = false) => mcp(a, f.c, 'reverse_allocations', {
  bank_account_id: f.bank, from_date: DAY, to_date: DAY, dry_run: dry, idempotency_key: key() }) as Promise<Reply>;
async function holdRows(ids: string[]): Promise<PoolClient> {
  const h = await pool.connect();
  await h.query('BEGIN');
  for (const id of ids) await h.query('SELECT 1 FROM bank_transactions WHERE id = $1 FOR UPDATE', [id]);
  return h;
}
const release = async (h: PoolClient) => { await h.query('ROLLBACK'); h.release(); };
async function waitForLockWaiter(): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (Number((await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()
      AND wait_event_type = 'Lock'`)).rows[0].n) > 0) return;
    await sleep(20);
  }
  throw new Error('no lock waiter appeared');
}

describe('M1 / M2: what the range call locked is what it reverses and reports', () => {
  it('a row allocated INTO the range while the call waited is not reversed; the reply lists only what was', async () => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    const x = await lineOn(f, f.bank, -111, 'R2 X');
    await allocate(f, x, f.expA);
    const z = await lineOn(f, f.bank, -112, 'R2 Z'); // imported at the first read
    const holder = await holdRows([x]);
    const call = range(f);
    await waitForLockWaiter();
    await allocate(f, z, f.expA); // allocated into the range meanwhile (z is not held by anyone)
    await release(holder);
    const out = await call;
    expect(out.isError, out.content[0]!.text).toBeFalsy();
    const body = JSON.parse(out.content[0]!.text) as RangeOut;
    expect({ reversed: body.reversed, listed: body.transactions.map((t) => t.transaction_id) }).toEqual({ reversed: 1, listed: [x] });
    expect({ x: await lineStatus(pool, x), z: await lineStatus(pool, z) }).toEqual({ x: 'imported', z: 'allocated' });
  }, 30000);

  it('the step-2 agent refusal is asked again under the locks: enforcement switched on meanwhile refuses, nothing written', async () => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    const x = await lineOn(f, f.bank, -113, 'R2 E');
    await allocate(f, x, f.expA);
    const holder = await holdRows([x]);
    const call = range(f);
    await waitForLockWaiter();
    await enforce(pool, f.c, a, ['manual_journal']);
    await release(holder);
    const out = await call;
    expect(out.isError, out.content[0]!.text).toBe(true);
    expect(await lineStatus(pool, x)).toBe('allocated');
  }, 30000);

  it('M2: a line a single reverse freed while the call waited drops out of `transactions` as well as `reversed`', async () => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    const x = await lineOn(f, f.bank, -114, 'R2 F1');
    const y = await lineOn(f, f.bank, -115, 'R2 F2');
    await allocate(f, x, f.expA);
    await allocate(f, y, f.expA);
    let go!: () => void; let held!: () => void;
    const gate = new Promise<void>((r) => { go = r; });
    const holding = new Promise<void>((r) => { held = r; });
    const single = asToken(pool, a, f.c, async () => { await reverseReconciledTransaction(f.c, y, a); held(); await gate; }, { session: true });
    await holding;
    const call = range(f);
    await waitForLockWaiter();
    go();
    await single;
    const body = JSON.parse((await call).content[0]!.text) as RangeOut;
    expect({ reversed: body.reversed, listed: body.transactions.map((t) => t.transaction_id) }).toEqual({ reversed: 1, listed: [x] });
  }, 30000);
});

describe('LOW2: the counterpart check judges the leg set the reversal resets', () => {
  it('a reconciled counterpart matched to the chain HEAD (a re-reversal) is refused by the dry run too', async () => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    const x = await lineOn(f, f.bank, -616, 'R2 HX');
    const y = await lineOn(f, f.bank2, 616, 'R2 HY');
    await allocate(f, x, f.bank2, 'transfer'); // y auto-linked to J
    const j = (await pool.query('SELECT transfer_journal_entry_id AS j FROM bank_transactions WHERE id = $1', [x])).rows[0].j as string;
    // J -> R1 (legacy hand reversal) -> R2 (re-reversal: J's cash back); y then matched to R2's bank-2 leg, Sage-reconciled.
    const r1 = await asToken(pool, a, f.c, () => reverseJournalEntry(f.c, j, a, { bankLinesHandled: true }), { session: true });
    const r2 = await asToken(pool, a, f.c, () => reverseJournalEntry(f.c, r1.id, a, { bankLinesHandled: true }), { session: true });
    const leg = (await pool.query('SELECT id FROM gl_journal_lines WHERE journal_entry_id = $1 AND gl_account_id = $2', [r2.id, f.bank2])).rows[0].id;
    await pool.query("UPDATE bank_transactions SET matched_journal_line_id = $2, status = 'reconciled' WHERE id = $1", [y, leg]);
    const out = await range(f, true);
    expect(out).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/other bank's line of this transfer/) }] });
  }, 30000);
});

describe('LOW3: one deadline for the whole pre-lock', () => {
  it('two held lines cost the call ~5 s in all, not 5 s each', async () => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    const x1 = await lineOn(f, f.bank, -117, 'R2 D1');
    const x2 = await lineOn(f, f.bank, -118, 'R2 D2');
    await allocate(f, x1, f.expA);
    await allocate(f, x2, f.expA);
    const holder = await holdRows([x1, x2]);
    const t0 = Date.now();
    let out: Reply;
    try { out = await range(f); } finally { await release(holder); }
    const ms = Date.now() - t0;
    expect(out!.isError).toBe(true); // contended: retryable, nothing reversed
    expect(ms, `waited ${ms} ms`).toBeLessThan(8000); // 5 s per line would be ~10 s
    expect({ x1: await lineStatus(pool, x1), x2: await lineStatus(pool, x2) }).toEqual({ x1: 'allocated', x2: 'allocated' });
  }, 40000);
});
