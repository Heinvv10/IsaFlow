/**
 * Bank audit follow-up (2026-11-16): a journal a LIVE bank line still books, reversed from anywhere but the bank line.
 *
 * Before: Journal Entries' Reverse, MCP `reverse_journal_entry` and every internal reversal (soft delete, the
 * opening-balance re-run, a pay run's journal) reversed the journal and left its statement line `allocated` /
 * `matched` against a journal no longer on the books — the line's cards and tiles went on counting cash the ledger had
 * taken back. Now refused, 400 JOURNAL_HAS_LIVE_BANK_LINE, naming the line and the Bank Transactions undo, before any
 * write: at the GL entrance (bankReversalGate, so MCP's dry run agrees) and again under reverseJournalEntry's claim
 * (every internal caller), which it releases. The bank line's own undo reverses the journal and resets the line.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import journalEntriesAction from '../../pages/api/accounting/journal-entries-action';
import { reverseJournalEntryTool } from '../../src/lib/mcp/tools/writeJournalReverse';
import { McpRegistry } from '../../src/lib/mcp/registry';
import { reverseJournalEntry } from '../../src/modules/accounting/services/gl/journalEntryPostingService';
import { callRoute, createUser } from './r035-approval.helpers';
import { plantJournal } from './r035-pr6.helpers';
import {
  actionRoute, asToken, bankCompany, cleanupBankControlsA, lineStatus, plantBatch, plantLine, refusalOf, type BankCompany, type McpReply,
} from './bank-controls-a.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let act: ReturnType<typeof actionRoute>;
const registry = new McpRegistry();
registry.register(reverseJournalEntryTool);
const mcp = (c: string, args: Record<string, unknown>) => asToken(pool, a, c, async () =>
  (await registry.call('reverse_journal_entry', { idempotency_key: crypto.randomUUID(), ...args }, { userId: a, companyId: c,
    scopes: ['write:journals', 'write:post'], companyRole: 'owner', tokenJti: 'revjl', oauthAppId: null })) as McpReply);
const glReverse = (c: string, je: string) => callRoute(journalEntriesAction as never, tokens[a]!, c, 'POST',
  { id: je, action: 'reverse' }, '/api/accounting/journal-entries-action');

beforeAll(async () => { a = await createUser(pool, tokens); act = actionRoute(tokens); });
afterAll(() => cleanupBankControlsA(pool, companies, [a]));

const LINE = /^This journal books the bank line 2026-09-01 −R\s1\s500\.00 "BC line", which is still (allocated|matched) to it\. Undo it from Bank Transactions/;

/** Nothing reversed: no contra in the company, the journal not claimed (reversed_at / reversed_by still empty). */
async function untouched(c: string, je: string) {
  const { rows } = await pool.query(
    `SELECT (SELECT count(*)::INT FROM gl_journal_entries WHERE company_id = $1 AND reversal_of_id IS NOT NULL) AS contras,
            reversed_at IS NULL AND reversed_by IS NULL AS unclaimed, status
     FROM gl_journal_entries WHERE id = $2`, [c, je]);
  return rows[0] as { contras: number; unclaimed: boolean; status: string };
}
const UNTOUCHED = { contras: 0, unclaimed: true, status: 'posted' };

/** A statement line (−R1 500) allocated to expA through the bank route: its journal is `je`. */
async function allocated(): Promise<BankCompany & { line: string; je: string }> {
  const f = await bankCompany(pool, [[a, 'admin']], companies);
  const line = await plantLine(pool, f, await plantBatch(pool, f, a));
  const res = await act(a, f.c, { action: 'allocate', bankTransactionId: line, allocationType: 'account', contraAccountId: f.expA });
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  const je = (await pool.query(
    `SELECT jl.journal_entry_id AS je FROM bank_transactions bt JOIN gl_journal_lines jl ON jl.id = bt.matched_journal_line_id
     WHERE bt.id = $1`, [line])).rows[0].je as string;
  return { ...f, line, je };
}

/** A posted manual journal (DR expA / CR bank R1 500) a statement line is MATCHED to through the bank route. */
async function matched(): Promise<BankCompany & { line: string; je: string }> {
  const f = await bankCompany(pool, [[a, 'admin']], companies);
  const line = await plantLine(pool, f, await plantBatch(pool, f, a));
  const je = await plantJournal(pool, f, a);
  const posted = await callRoute(journalEntriesAction as never, tokens[a]!, f.c, 'POST', { id: je, action: 'post' },
    '/api/accounting/journal-entries-action');
  expect(posted.state.statusCode, JSON.stringify(posted.state.body)).toBe(200);
  const jl = (await pool.query('SELECT id FROM gl_journal_lines WHERE journal_entry_id = $1 AND credit > 0', [je])).rows[0].id as string;
  const res = await act(a, f.c, { action: 'match', bankTransactionId: line, journalLineId: jl });
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  return { ...f, line, je };
}

describe('Journal Entries Reverse refuses a journal a live bank line books', () => {
  it('an ALLOCATED line: 400 naming the line, nothing written; the bank line\'s own Reverse then reverses and resets it', async () => {
    const f = await allocated();
    const res = await glReverse(f.c, f.je);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect(refusalOf(res).message).toMatch(LINE);
    expect(refusalOf(res).message).not.toMatch(/unmatch/);
    expect(await untouched(f.c, f.je)).toEqual(UNTOUCHED);
    expect(await lineStatus(pool, f.line)).toBe('allocated');
    // The remedy the message names (bankReverseReconciled passes bankLinesHandled): reversed AND reset.
    expect((await act(a, f.c, { action: 'reverse', bankTransactionId: f.line })).state.statusCode).toBe(200);
    expect(await lineStatus(pool, f.line)).toBe('imported');
    expect((await untouched(f.c, f.je)).contras).toBe(1);
  });

  it('a MATCHED line: 400 with the unmatch hint; once unmatched the journal reverses from the GL', async () => {
    const f = await matched();
    const res = await glReverse(f.c, f.je);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect(refusalOf(res).message).toMatch(LINE);
    expect(refusalOf(res).message).toMatch(/To keep the journal, unmatch the line there instead/);
    expect(await untouched(f.c, f.je)).toEqual(UNTOUCHED);
    expect(await lineStatus(pool, f.line)).toBe('matched');
    expect((await act(a, f.c, { action: 'unmatch', bankTransactionId: f.line })).state.statusCode).toBe(200);
    expect((await glReverse(f.c, f.je)).state.statusCode).toBe(200);
    expect((await untouched(f.c, f.je)).contras).toBe(1);
  });
});

describe('MCP reverse_journal_entry refuses it too, dry run included', () => {
  it.each([[true], [false]])('dry_run %s: isError naming the line; nothing written', async (dryRun) => {
    const f = await allocated();
    const out = await mcp(f.c, { journal_entry_id: f.je, dry_run: dryRun });
    expect(out.isError, out.content[0]?.text).toBe(true);
    expect(out.content[0]?.text).toMatch(LINE);
    expect(await untouched(f.c, f.je)).toEqual(UNTOUCHED);
    expect(await lineStatus(pool, f.line)).toBe('allocated');
  });
});

describe('an internal caller (soft delete, opening-balance re-run, pay run) is refused under the claim', () => {
  it('reverseJournalEntry with no entrance gate throws the typed refusal and releases its claim', async () => {
    const f = await matched();
    // Caught INSIDE the transaction so it commits: a claim left behind would show as reversed_at set.
    const err = await asToken(pool, a, f.c, async () => {
      try { await reverseJournalEntry(f.c, f.je, a); return null; } catch (e) { return e as Error & { code?: string }; }
    }, { session: true });
    expect(err?.code).toBe('JOURNAL_HAS_LIVE_BANK_LINE');
    expect(err?.message).toMatch(LINE);
    expect(await untouched(f.c, f.je)).toEqual(UNTOUCHED);
    expect(await lineStatus(pool, f.line)).toBe('matched');
  });
});

describe('only a reversal that takes the line\'s cash OUT is refused', () => {
  it('a legacy hand reversal is re-reversed from the GL (it repairs the line); reversing that again is refused', async () => {
    const f = await allocated();
    // The pre-2026-11-16 state: the journal reversed in the GL, its line left allocated (planted through the opt-out).
    const r1 = await asToken(pool, a, f.c, () => reverseJournalEntry(f.c, f.je, a, { bankLinesHandled: true }), { session: true });
    const back = await glReverse(f.c, r1.id);
    expect(back.state.statusCode, JSON.stringify(back.state.body)).toBe(200);
    const r2 = (back.state.body as { data: { id: string } }).data.id;
    const again = await glReverse(f.c, r2);
    expect(again.state.statusCode, JSON.stringify(again.state.body)).toBe(400);
    expect(refusalOf(again).message).toMatch(LINE);
    expect((await untouched(f.c, f.je)).contras).toBe(2);
    expect(await lineStatus(pool, f.line)).toBe('allocated');
  });
});
