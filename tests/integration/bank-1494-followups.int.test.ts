/**
 * #1494 follow-ups (rev-1494 / brk-1494 / the codex gate's counterpart wrapper), against real Postgres.
 *
 *  rev 2   a transfer rule's pre-read candidates leave out the lines an earlier rule of the SAME sweep posted: not
 *          counted as another request's race.
 *  brk 4   a transfer rule takes no line lock for a line its period will skip anyway.
 *  undo    undoRow locks the journal's other line WITH its own in id order (a reverse from the lower-id leg locks them
 *          the same way); judges ANY second line; clears the run row's transfer pointer on the hand-reversed path.
 *  M1      reverse_allocations' dry run refuses a reconciled counterpart, as the live call does.
 *  M2      a counterpart another request holds: the batch / range call reverses nothing.
 *  brk     a batch line a single reverse freed while the batch waited is SKIPPED, not the whole call aborted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import type { NextApiResponse } from 'next';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { asToken, bankCompany, cleanupBankControlsA, lineStatus, mcpCaller, type BankCompany } from './bank-controls-a.helpers';
import bankRulesAction from '../../pages/api/accounting/bank-rules-action';
import bankAutoPost from '../../pages/api/accounting/bank-auto-post';
import { withAuth, type CompanyAuthedRequest } from '../../src/lib/auth';
import { sweep } from '../../src/modules/accounting/services/bank/autoPostGateService';
import { applyRules } from '../../src/modules/accounting/services/bank/bankRulesMatchingService';
import { reverseJournalEntry } from '../../src/modules/accounting/services/gl/journalEntryPostingService';
import { reverseReconciledTransaction } from '../../src/modules/accounting/services/bank/bankAllocationService';
import { transferPairKey } from '../../src/modules/accounting/services/bank/transferPairLock';
import { bulkAllocateBankTransactionsTool } from '../../src/lib/mcp/tools/writeBankBulkAllocate';
import { reverseBankAllocationBatchTool } from '../../src/lib/mcp/tools/writeBankReverseBatch';
import { reverseAllocationsTool } from '../../src/lib/mcp/tools/writeBankReverseRange';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
const mcp = mcpCaller(pool, [bulkAllocateBankTransactionsTool, reverseBankAllocationBatchTool, reverseAllocationsTool]);
const key = () => crypto.randomUUID();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Reply = { isError?: boolean; content: { text: string }[] };

beforeAll(async () => { a = await createUser(pool, tokens); });
afterAll(async () => {
  await pool.query('UPDATE bank_transactions SET allocation_rule_id = NULL, allocation_batch_id = NULL WHERE company_id = ANY($1)', [companies]);
  await cleanupBankControlsA(pool, companies, [a]); // ends the pool
});

const lineOn = async (f: BankCompany, bank: string, amount: number, date: string, description: string, id = crypto.randomUUID()) =>
  (await pool.query(`INSERT INTO bank_transactions(id, company_id, bank_account_id, transaction_date, amount, description, status)
    VALUES($1,$2,$3,$4::DATE,$5,$6,'imported') RETURNING id`, [id, f.c, bank, date, amount, description])).rows[0].id as string;
const rule = (f: BankCompany, name: string, pattern: string, gl: string, priority: number) => pool.query(
  `INSERT INTO bank_categorisation_rules(company_id, rule_name, match_field, match_type, match_pattern, gl_account_id,
     auto_create_entry, created_by, priority) VALUES($1,$2,'description','contains',$3,$4,true,$5,$6)`, [f.c, name, pattern, gl, a, priority]);
/** Can another connection take the row lock right now? */
const rowFree = async (id: string) => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT 1 FROM bank_transactions WHERE id = $1 FOR UPDATE NOWAIT', [id]);
    return true;
  } catch { return false; } finally { await c.query('ROLLBACK'); c.release(); }
};
const pairFree = async (f: BankCompany, x: string, y: string) => (await pool.query(
  'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS free', [transferPairKey(f.c, x, y)])).rows[0].free as boolean;
async function waitForLockWaiter(): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (Number((await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()
      AND wait_event_type = 'Lock'`)).rows[0].n) > 0) return;
    await sleep(20);
  }
  throw new Error('no lock waiter appeared');
}
async function holdRow(id: string): Promise<PoolClient> {
  const h = await pool.connect();
  await h.query('BEGIN');
  await h.query('SELECT 1 FROM bank_transactions WHERE id = $1 FOR UPDATE', [id]);
  return h;
}
const release = async (h: PoolClient) => { await h.query('ROLLBACK'); h.release(); };

/** The confidence gate posts `x` onto bank2 as a transfer; `y` (bank2, same day) is auto-linked. Returns the run. */
async function gateTransfer(f: BankCompany, x: string) {
  await pool.query(`INSERT INTO bank_auto_post_settings(company_id, enabled, min_confidence, amount_cap, llm_enabled,
    llm_min_confidence, llm_amount_cap, updated_at) VALUES ($1, true, 0.50, 0, false, 0.95, 2000, NOW()) ON CONFLICT (company_id) DO NOTHING`, [f.c]);
  await pool.query('UPDATE bank_transactions SET suggested_gl_account_id = $2, suggested_confidence = 0.95 WHERE id = $1', [x, f.bank2]);
  const run = withAuth(async (req: CompanyAuthedRequest, res: NextApiResponse) => {
    res.status(200).json({ data: await sweep(req.companyId, [x], 'categorization', req.user.id, req.user.id) });
  });
  const res = await callRoute(run as never, tokens[a]!, f.c, 'POST', {}, '/api/accounting/smart-categorize');
  return (res.state.body as { data: { runId: string } }).data.runId;
}
const undo = (f: BankCompany, runId: string) => callRoute(bankAutoPost as never, tokens[a]!, f.c, 'POST', { action: 'undo', runId },
  '/api/accounting/bank-auto-post');
const pointer = async (id: string) => (await pool.query('SELECT transfer_journal_entry_id AS t FROM bank_transactions WHERE id = $1', [id])).rows[0].t;

describe('the rule sweep (rev 2, brk 4)', () => {
  it('a line an earlier rule of this sweep posted is not counted as raced by a later transfer rule', async () => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    await rule(f, 'FU expense first', 'FU DUAL', f.expA, 0);
    await rule(f, 'FU transfer second', 'FU DUAL', f.bank2, 1);
    await lineOn(f, f.bank, -321, '2026-09-08', 'FU DUAL line');
    const res = await callRoute(bankRulesAction as never, tokens[a]!, f.c, 'POST', { action: 'apply', bankAccountId: f.bank },
      '/api/accounting/bank-rules-action');
    expect((res.state.body as { data: Record<string, number> }).data).toMatchObject({ applied: 1, autoPostSkippedRaced: 0 });
  });

  it('a transfer rule takes no line or pair lock for a line its period will skip', async () => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    await rule(f, 'FU no period', 'FU NOPERIOD', f.bank2, 0);
    const line = await lineOn(f, f.bank, -322, '2031-01-15', 'FU NOPERIOD line'); // no fiscal period covers 2031
    const seen = await asToken(pool, a, f.c, async () => {
      await applyRules(f.c, f.bank, a);
      return { lineFree: await rowFree(line), pairFree: await pairFree(f, f.bank, f.bank2) }; // the sweep still open
    }, { session: true });
    expect(seen).toEqual({ lineFree: true, pairFree: true });
  });
});

describe('the gate\'s undo (rev on dd4110dbe1)', () => {
  it('locks the lower-id counterpart BEFORE its own line: a held counterpart leaves the run row unlocked', async () => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    const [low, high] = [crypto.randomUUID(), crypto.randomUUID()].sort() as [string, string];
    const y = await lineOn(f, f.bank2, 404, '2026-09-09', 'FU Y', low);
    const x = await lineOn(f, f.bank, -404, '2026-09-09', 'FU X', high);
    const runId = await gateTransfer(f, x);
    expect(await lineStatus(pool, y)).toBe('allocated');
    const holder = await holdRow(y);
    const pending = undo(f, runId);
    await waitForLockWaiter();
    const xFree = await rowFree(x); // id order: the undo waits on Y before it takes X
    await release(holder);
    const res = await pending;
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect({ xFree, x: await lineStatus(pool, x), y: await lineStatus(pool, y) }).toEqual({ xFree: true, x: 'imported', y: 'imported' });
  });

  it('a posting reversed by hand: both lines freed, the run row\'s transfer pointer cleared too', async () => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    const y = await lineOn(f, f.bank2, 405, '2026-09-09', 'FU HY');
    const x = await lineOn(f, f.bank, -405, '2026-09-09', 'FU HX');
    const runId = await gateTransfer(f, x);
    const je = await pointer(x);
    await asToken(pool, a, f.c, () => reverseJournalEntry(f.c, String(je), a, { bankLinesHandled: true }), { session: true }); // legacy hand reversal
    const res = await undo(f, runId);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect({ x: await lineStatus(pool, x), y: await lineStatus(pool, y), px: await pointer(x), py: await pointer(y) })
      .toEqual({ x: 'imported', y: 'imported', px: null, py: null });
  });

  it('a posting reversed by hand whose counterpart another request holds: contended, nothing changed', async () => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    const y = await lineOn(f, f.bank2, 407, '2026-09-09', 'FU KY');
    const x = await lineOn(f, f.bank, -407, '2026-09-09', 'FU KX');
    const runId = await gateTransfer(f, x);
    const je = await pointer(x);
    await asToken(pool, a, f.c, () => reverseJournalEntry(f.c, String(je), a, { bankLinesHandled: true }), { session: true });
    const holder = await holdRow(y);
    let res;
    try { res = await undo(f, runId); } finally { await release(holder); }
    expect(res.state.statusCode, JSON.stringify(res.state.body)).not.toBe(500);
    expect(JSON.stringify(res.state.body)).not.toMatch(/"undone":true/);
    expect({ x: await lineStatus(pool, x), y: await lineStatus(pool, y) }).toEqual({ x: 'allocated', y: 'allocated' });
  }, 30000);

  it('a reconciled SECOND line of a non-transfer posting is the row\'s reconciled skip, not a failure', async () => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    const x = await lineOn(f, f.bank, -406, '2026-09-09', 'FU NX');
    await pool.query(`INSERT INTO bank_auto_post_settings(company_id, enabled, min_confidence, amount_cap, llm_enabled,
      llm_min_confidence, llm_amount_cap, updated_at) VALUES ($1, true, 0.50, 0, false, 0.95, 2000, NOW())`, [f.c]);
    await pool.query('UPDATE bank_transactions SET suggested_gl_account_id = $2, suggested_confidence = 0.95 WHERE id = $1', [x, f.expA]);
    const run = withAuth(async (req: CompanyAuthedRequest, res: NextApiResponse) => {
      res.status(200).json({ data: await sweep(req.companyId, [x], 'categorization', req.user.id, req.user.id) });
    });
    const runId = ((await callRoute(run as never, tokens[a]!, f.c, 'POST', {}, '/api/accounting/smart-categorize')).state.body as
      { data: { runId: string } }).data.runId;
    // Forced: a second statement line matched to the same journal (its other line) and reconciled in the Sage import.
    const z = await lineOn(f, f.bank, -406, '2026-09-10', 'FU NZ');
    await pool.query(`UPDATE bank_transactions SET status = 'reconciled', matched_journal_line_id = (SELECT o.id
      FROM bank_transactions bt JOIN gl_journal_lines m ON m.id = bt.matched_journal_line_id
      JOIN gl_journal_lines o ON o.journal_entry_id = m.journal_entry_id AND o.id <> m.id WHERE bt.id = $2 LIMIT 1) WHERE id = $1`, [z, x]);
    const res = await undo(f, runId);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect((res.state.body as { data: { skippedBy: { reconciled: number } } }).data.skippedBy.reconciled).toBe(1);
    expect(await lineStatus(pool, x)).toBe('allocated');
  });
});

/** A bulk-posted transfer (an account line onto bank2) whose bank2 line is auto-linked outside the batch. */
async function bulkTransfer(f: BankCompany, amount: number, date = '2026-09-11') {
  const out = await lineOn(f, f.bank, -amount, date, 'FU BT out');
  const inn = await lineOn(f, f.bank2, amount, date, 'FU BT in');
  const res = await mcp(a, f.c, 'bulk_allocate_bank_transactions', { idempotency_key: key(),
    allocations: [{ transaction_id: out, alloc_type: 'account', contra_account_id: f.bank2 }] }) as Reply;
  expect(res.isError, res.content[0]!.text).toBeFalsy();
  expect(await lineStatus(pool, inn)).toBe('allocated');
  return { out, inn, batchId: (JSON.parse(res.content[0]!.text) as { batch_id: string }).batch_id };
}

describe('the batch and range reversals and the counterpart (M1, M2, brk)', () => {
  it('M1: reverse_allocations\' dry run refuses a reconciled counterpart, as the live call does; nothing written', async () => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    const t = await bulkTransfer(f, 501);
    await pool.query("UPDATE bank_transactions SET status = 'reconciled' WHERE id = $1", [t.inn]);
    const args = { bank_account_id: f.bank, from_date: '2026-09-11', to_date: '2026-09-11' };
    for (const dry of [true, false]) {
      const out = await mcp(a, f.c, 'reverse_allocations', { ...args, dry_run: dry, idempotency_key: key() }) as Reply;
      expect(out).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/other bank's line of this transfer/) }] });
    }
    expect(await lineStatus(pool, t.out)).toBe('allocated');
  });

  it.each(['batch', 'range'] as const)('M2 %s: a counterpart another request holds — nothing reversed', async (tool) => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    const t = await bulkTransfer(f, tool === 'batch' ? 502 : 503);
    const holder = await holdRow(t.inn);
    let out: Reply;
    try {
      out = await mcp(a, f.c, tool === 'batch' ? 'reverse_bank_allocation_batch' : 'reverse_allocations', tool === 'batch'
        ? { batch_id: t.batchId, idempotency_key: key() }
        : { bank_account_id: f.bank, from_date: '2026-09-11', to_date: '2026-09-11', idempotency_key: key() }) as Reply;
    } finally { await release(holder); }
    expect(out!.isError, out!.content[0]!.text).toBe(true);
    expect({ out: await lineStatus(pool, t.out), inn: await lineStatus(pool, t.inn) }).toEqual({ out: 'allocated', inn: 'allocated' });
  }, 30000);

  it('brk: a batch line a single reverse freed while the batch waited is skipped, the call does not abort', async () => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    const t = await bulkTransfer(f, 504);
    let go!: () => void; let started!: () => void;
    const gate = new Promise<void>((r) => { go = r; });
    const holding = new Promise<void>((r) => { started = r; });
    const single = asToken(pool, a, f.c, async () => { await reverseReconciledTransaction(f.c, t.out, a); started(); await gate; }, { session: true });
    await holding;
    const batch = mcp(a, f.c, 'reverse_bank_allocation_batch', { batch_id: t.batchId, idempotency_key: key() }) as Promise<Reply>;
    await waitForLockWaiter();
    go();
    await single;
    const out = await batch;
    expect(out.isError, out.content[0]!.text).toBeFalsy();
    expect(JSON.parse(out.content[0]!.text)).toMatchObject({ reversed: 0, skipped: [{ transaction_id: t.out }] });
    expect({ out: await lineStatus(pool, t.out), inn: await lineStatus(pool, t.inn) }).toEqual({ out: 'imported', inn: 'imported' });
  }, 30000);
});
