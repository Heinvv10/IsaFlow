/**
 * WP2 row 5 round 2 (#1494 review): the bank-contra transfer at every remaining door.
 *
 *  - MCP bulk: an own-bank line, or one whose transfer is already in the ledger, is a per-line skip named in the reply
 *    (dry run and live agree), never a batch-wide abort; the good lines beside it post.
 *  - MCP single allocate: both refusals are typed tool errors, read before any write.
 *  - Split (screen and MCP) and the reconciliation adjustment refuse a bank-account contra: 400, nothing written.
 *  - The gate: the second leg of a transfer this run posted is skipped as "paired with transfer <ref>", and undoing
 *    the run reverses the journal ONCE and brings both lines back to imported.
 *  - A supplier call naming no contact, onto a bank account, posts the transfer arm's journal, not bank-to-bank.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { NextApiResponse } from 'next';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { actionRoute, asToken, bankCompany, cleanupBankControlsA, mcpCaller, type BankCompany } from './bank-controls-a.helpers';
import { allocateBankTransactionTool } from '../../src/lib/mcp/tools/writeBankAllocate';
import { bulkAllocateBankTransactionsTool } from '../../src/lib/mcp/tools/writeBankBulkAllocate';
import { splitAllocateBankTransactionTool } from '../../src/lib/mcp/tools/writeBankSplit';
import bankAutoPost from '../../pages/api/accounting/bank-auto-post';
import bankReconciliationsAction from '../../pages/api/accounting/bank-reconciliations-action';
import { withAuth, type CompanyAuthedRequest } from '../../src/lib/auth';
import { sweep } from '../../src/modules/accounting/services/bank/autoPostGateService';
import { allocateTransaction } from '../../src/modules/accounting/services/bank/bankAllocationService';
import { createJournalEntry, postJournalEntry } from '../../src/modules/accounting/services/gl/journalEntryService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let act: ReturnType<typeof actionRoute>;
const mcp = mcpCaller(pool, [allocateBankTransactionTool, bulkAllocateBankTransactionsTool, splitAllocateBankTransactionTool]);
type Reply = { isError?: boolean; content: { text: string }[] };
type Bulk = { posted?: number; would_post?: number; skipped: Array<{ index: number; transaction_id: string; reason: string }> };
const bulkOf = (r: Reply) => JSON.parse(r.content[0]!.text) as Bulk;

beforeAll(async () => { a = await createUser(pool, tokens); act = actionRoute(tokens); });
afterAll(async () => {
  await pool.query('DELETE FROM bank_reconciliations WHERE company_id = ANY($1)', [companies]);
  await cleanupBankControlsA(pool, companies, [a]); // ends the pool
});

const lineOn = async (f: BankCompany, bank: string, amount: number, date: string, description = 'BCT2 line') => (await pool.query(
  `INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status)
   VALUES($1,$2,$3::DATE,$4,$5,'imported') RETURNING id`, [f.c, bank, date, amount, description])).rows[0].id as string;
const status = async (id: string) => (await pool.query('SELECT status FROM bank_transactions WHERE id = $1', [id])).rows[0].status as string;
const journals = async (f: BankCompany) => (await pool.query(
  `SELECT COUNT(*)::INT AS n FROM gl_journal_entries WHERE company_id = $1 AND status = 'posted'`, [f.c])).rows[0].n as number;
const key = () => crypto.randomUUID();

describe('MCP bulk: a bad bank-contra line is skipped and named, the good lines post', () => {
  it('own-bank and already-posted transfer lines skip; the dry run reports exactly what the live call skips', async () => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    // The movement already in the ledger: B's leg posted first (3 days off, so the auto-link leaves A's line alone).
    const posted = await lineOn(f, f.bank2, 800, '2026-09-04');
    expect((await act(a, f.c, { action: 'allocate', bankTransactionId: posted, allocationType: 'transfer', contraAccountId: f.bank })).state.statusCode).toBe(200);
    const dup = await lineOn(f, f.bank, -800, '2026-09-03');
    const self = await lineOn(f, f.bank, -90, '2026-09-03');
    const good = await lineOn(f, f.bank, -120, '2026-09-03');
    const allocations = [
      { transaction_id: self, alloc_type: 'account', contra_account_id: f.bank },
      { transaction_id: dup, alloc_type: 'account', contra_account_id: f.bank2 },
      { transaction_id: good, alloc_type: 'account', contra_account_id: f.expA },
    ];
    const before = await journals(f);
    const dry = await mcp(a, f.c, 'bulk_allocate_bank_transactions', { allocations, dry_run: true, idempotency_key: key() });
    expect(dry.isError, dry.content[0]!.text).toBeFalsy();
    const live = await mcp(a, f.c, 'bulk_allocate_bank_transactions', { allocations, idempotency_key: key() });
    expect(live.isError, live.content[0]!.text).toBeFalsy();
    const expected = [
      { index: 0, transaction_id: self, reason: expect.stringMatching(/own bank account/) },
      { index: 1, transaction_id: dup, reason: expect.stringMatching(/A matching transfer already exists/) },
    ];
    expect(bulkOf(dry)).toMatchObject({ would_post: 1, skipped: expected });
    expect(bulkOf(live)).toMatchObject({ posted: 1, skipped: expected });
    expect({ self: await status(self), dup: await status(dup), good: await status(good), journals: await journals(f) })
      .toEqual({ self: 'imported', dup: 'imported', good: 'allocated', journals: before + 1 });
  });

  it('a line onto another bank is previewed with the in-batch caveat', async () => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    const line = await lineOn(f, f.bank, -55, '2026-09-03');
    const dry = await mcp(a, f.c, 'bulk_allocate_bank_transactions', {
      allocations: [{ transaction_id: line, alloc_type: 'account', contra_account_id: f.bank2 }], dry_run: true, idempotency_key: key() });
    expect(JSON.parse(dry.content[0]!.text)).toMatchObject({ would_post: 1,
      preview_caveats: [expect.stringMatching(/EARLIER line of this same batch .* is not previewable/)] });
  });
});

describe('MCP bulk: what the batch itself makes, and what another request holds', () => {
  it('both legs of one movement in one batch (3 days apart): the first posts, the second is skipped live as a duplicate', async () => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    const out = await lineOn(f, f.bank, -930, '2026-09-01');
    const inn = await lineOn(f, f.bank2, 930, '2026-09-04'); // outside the auto-link's two days: not paired
    const allocations = [
      { transaction_id: out, alloc_type: 'account', contra_account_id: f.bank2 },
      { transaction_id: inn, alloc_type: 'account', contra_account_id: f.bank },
    ];
    const dry = bulkOf(await mcp(a, f.c, 'bulk_allocate_bank_transactions', { allocations, dry_run: true, idempotency_key: key() }));
    expect(dry).toMatchObject({ would_post: 2, skipped: [] }); // not previewable: the caveat says so
    const live = bulkOf(await mcp(a, f.c, 'bulk_allocate_bank_transactions', { allocations, idempotency_key: key() }));
    expect(live).toMatchObject({ posted: 1, skipped: [{ index: 1, transaction_id: inn, reason: expect.stringMatching(/A matching transfer already exists/) }] });
    expect({ out: await status(out), inn: await status(inn), journals: await journals(f) }).toEqual({ out: 'allocated', inn: 'imported', journals: 1 });
  });

  it('a transfer line another request holds is skipped as locked; the batch\'s other line posts', async () => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    const held = await lineOn(f, f.bank, -940, '2026-09-02');
    const good = await lineOn(f, f.bank, -41, '2026-09-02');
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM bank_transactions WHERE id = $1 FOR UPDATE', [held]);
      const live = bulkOf(await mcp(a, f.c, 'bulk_allocate_bank_transactions', { idempotency_key: key(), allocations: [
        { transaction_id: held, alloc_type: 'account', contra_account_id: f.bank2 },
        { transaction_id: good, alloc_type: 'account', contra_account_id: f.expA }] }));
      expect(live).toMatchObject({ posted: 1, skipped: [{ index: 0, transaction_id: held, reason: expect.stringMatching(/locked by another request/) }] });
    } finally { await holder.query('ROLLBACK'); holder.release(); }
    expect({ held: await status(held), good: await status(good) }).toEqual({ held: 'imported', good: 'allocated' });
  }, 30000);
});

describe('MCP allocate_bank_transaction: typed refusals, nothing written', () => {
  it('own bank, then an already-posted transfer: each a tool error naming the fact', async () => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    const self = await lineOn(f, f.bank, -91, '2026-09-03');
    const own = await mcp(a, f.c, 'allocate_bank_transaction', { transaction_id: self, alloc_type: 'account', contra_account_id: f.bank, idempotency_key: key() });
    expect(own).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/own bank account/) }] });
    const posted = await lineOn(f, f.bank2, 801, '2026-09-04');
    expect((await act(a, f.c, { action: 'allocate', bankTransactionId: posted, allocationType: 'transfer', contraAccountId: f.bank })).state.statusCode).toBe(200);
    const dup = await lineOn(f, f.bank, -801, '2026-09-03');
    const before = await journals(f);
    const refused = await mcp(a, f.c, 'allocate_bank_transaction', { transaction_id: dup, alloc_type: 'account', contra_account_id: f.bank2, idempotency_key: key() });
    expect(refused).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/A matching transfer already exists/) }] });
    expect({ self: await status(self), dup: await status(dup), journals: await journals(f) }).toEqual({ self: 'imported', dup: 'imported', journals: before });
  });
});

describe('a posted journal of ANY source already moving the amount between the two banks (brk-1494 LOW 1)', () => {
  it.each(['manual', 'auto_recurring'] as const)('%s DR bank2 / CR bank: the line onto bank2 is refused naming it, nothing posted', async (source) => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    const je = await asToken(pool, a, f.c, async () => {
      const draft = await createJournalEntry(f.c, { entryDate: '2026-09-01', description: 'BCT2 bank to bank', source, lines: [
        { glAccountId: f.bank2, debit: 500, credit: 0, description: 'in' }, { glAccountId: f.bank, debit: 0, credit: 500, description: 'out' }] } as never, a);
      await postJournalEntry(f.c, draft.id, a);
      return draft;
    }, { session: true });
    const line = await lineOn(f, f.bank, -500, '2026-09-02');
    const before = await journals(f);
    const res = await act(a, f.c, { action: 'allocate', bankTransactionId: line, allocationType: 'account', contraAccountId: f.bank2 });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect(JSON.stringify(res.state.body)).toContain(`A matching transfer journal ${je.entryNumber} already exists`);
    expect({ line: await status(line), journals: await journals(f) }).toEqual({ line: 'imported', journals: before });
  });
});

describe('a split part or a reconciliation adjustment onto a bank account is refused', () => {
  it('split_allocate (screen and MCP): 400 / tool error, nothing written', async () => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    const line = await lineOn(f, f.bank, -100, '2026-09-03');
    const res = await act(a, f.c, { action: 'split_allocate', bankTransactionId: line,
      lines: [{ contraAccountId: f.expA, amount: 60 }, { contraAccountId: f.bank2, amount: 40 }] });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect(JSON.stringify(res.state.body)).toMatch(/a transfer can't be split; allocate it as a transfer/);
    const out = await mcp(a, f.c, 'split_allocate_bank_transaction', { transaction_id: line, idempotency_key: key(),
      lines: [{ contra_account_id: f.expA, amount: 60 }, { contra_account_id: f.bank2, amount: 40 }] });
    expect(out).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/a transfer can't be split/) }] });
    expect({ line: await status(line), journals: await journals(f) }).toEqual({ line: 'imported', journals: 0 });
  });

  it('a reconciliation adjustment to a bank account: 400, no journal', async () => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    const rec = (await pool.query(`INSERT INTO bank_reconciliations(bank_account_id, statement_date, started_by, company_id)
      VALUES ($1, DATE '2026-09-30', $2, $3) RETURNING id`, [f.bank, a, f.c])).rows[0].id as string;
    const adjust = (contra: string) => callRoute(bankReconciliationsAction as never, tokens[a]!, f.c, 'POST',
      { action: 'adjustment', reconciliationId: rec, bankAccountId: f.bank, contraAccountId: contra, amount: 25, description: 'BCT2 adj' },
      '/api/accounting/bank-reconciliations-action');
    const res = await adjust(f.bank2);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect(JSON.stringify(res.state.body)).toMatch(/adjustment can't post to a bank account/);
    expect(await journals(f)).toBe(0);
    expect((await adjust(f.expA)).state.statusCode).toBe(200); // the control: an expense contra still posts
  });
});

describe('the gate: both legs of one movement in one run, and its undo', () => {
  const gate = withAuth(async (req: CompanyAuthedRequest, res: NextApiResponse) => {
    res.status(200).json({ data: await sweep(req.companyId, req.body.ids as string[], 'categorization', req.user.id, req.user.id) });
  });
  const run = async (f: BankCompany, ids: string[]) => {
    const res = await callRoute(gate as never, tokens[a]!, f.c, 'POST', { ids }, '/api/accounting/smart-categorize');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    return (res.state.body as { data: { runId: string; posted: number; skipped: { txId: string; reason: string }[] } }).data;
  };

  it('the second leg is "paired with transfer <ref>"; undoing the run reverses once and frees both lines', async () => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    await pool.query(`INSERT INTO bank_auto_post_settings(company_id, enabled, min_confidence, amount_cap, llm_enabled,
      llm_min_confidence, llm_amount_cap, updated_at) VALUES ($1, true, 0.50, 0, false, 0.95, 2000, NOW())`, [f.c]);
    const [out, inn] = [await lineOn(f, f.bank, -270, '2026-09-05', 'GATE PAIR'), await lineOn(f, f.bank2, 270, '2026-09-05', 'GATE PAIR')];
    await pool.query('UPDATE bank_transactions SET suggested_gl_account_id = $2, suggested_confidence = 0.95 WHERE id = $1', [out, f.bank2]);
    await pool.query('UPDATE bank_transactions SET suggested_gl_account_id = $2, suggested_confidence = 0.95 WHERE id = $1', [inn, f.bank]);
    const result = await run(f, [out, inn]);
    const je = (await pool.query(`SELECT je.entry_number, je.id FROM bank_transactions bt
      JOIN gl_journal_entries je ON je.id = bt.transfer_journal_entry_id WHERE bt.id = $1`, [out < inn ? out : inn])).rows[0];
    expect(result.posted).toBe(1);
    expect(result.skipped).toEqual([{ txId: out < inn ? inn : out, reason: `paired with transfer ${je.entry_number}` }]);
    expect({ out: await status(out), inn: await status(inn) }).toEqual({ out: 'allocated', inn: 'allocated' });
    const undo = await callRoute(bankAutoPost as never, tokens[a]!, f.c, 'POST', { action: 'undo', runId: result.runId },
      '/api/accounting/bank-auto-post');
    expect(undo.state.statusCode, JSON.stringify(undo.state.body)).toBe(200);
    const reversals = (await pool.query(`SELECT COUNT(*)::INT AS n FROM gl_journal_entries
      WHERE company_id = $1 AND reversal_of_id = $2 AND status = 'posted'`, [f.c, je.id])).rows[0].n as number;
    expect({ out: await status(out), inn: await status(inn), reversals }).toEqual({ out: 'imported', inn: 'imported', reversals: 1 });
  });
});

describe('allocateTransaction: a supplier call naming no contact, onto a bank account', () => {
  it('posts through the transfer arm (one transfer journal), not bank-to-bank past it', async () => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    const line = await lineOn(f, f.bank, -77, '2026-09-03');
    await asToken(pool, a, f.c, () => allocateTransaction(f.c, line, f.bank2, a, undefined, 'supplier'), { session: true });
    const row = (await pool.query(`SELECT bt.allocation_type, je.source FROM bank_transactions bt
      JOIN gl_journal_entries je ON je.id = bt.transfer_journal_entry_id WHERE bt.id = $1`, [line])).rows[0];
    expect(row).toEqual({ allocation_type: 'transfer', source: 'auto_bank_transfer' });
  });
});
