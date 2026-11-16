/**
 * Importer ≠ allocator for extension feed lines, the paths beside allocate (Hein, 2026-11-16): auto-match, the MCP
 * bulk classifier (dry run and live) and the transfer auto-link. The pusher's line goes in through the REAL
 * extension-ingest route.
 *
 * - auto-match acts for the person who ran it: their own pushed line against a journal they created is skipped and
 *   counted; another member's run matches it.
 * - bulk_allocate_bank_transactions skips the pusher's line as approval_required, dry run and live alike.
 * - the transfer auto-link (relink / import) leaves the pusher's own extension line for a colleague, so a transfer
 *   allocation cannot clear a forged line; a colleague's run, a sole approver and enforcement off link as before.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { bulkAllocateBankTransactionsTool } from '../../src/lib/mcp/tools/writeBankBulkAllocate';
import { autoLinkImportedBatchTransfers, relinkTransferCounterparts } from '../../src/modules/accounting/services/bank/bankTransferLinkService';
import { newLinkBatchId } from '../../src/modules/accounting/services/bank/bankTransferLinkLog';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { journalRoutes, plantJournal } from './r035-pr6.helpers';
import { dataOf } from './r035-pr2.helpers';
import {
  actionRoute, asToken, cleanupBankControlsA, lineStatus, mcpCaller, plantBatch, plantLine, type BankCompany,
} from './bank-controls-a.helpers';
import { EXT_REFUSAL, FeedHarness, type FeedCompany } from './bank-controls-feed-importer.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const h = new FeedHarness(pool);
let a = '';
let b = '';
let act: ReturnType<typeof actionRoute>;
let j: ReturnType<typeof journalRoutes>;
const mcp = mcpCaller(pool, [bulkAllocateBankTransactionsTool]);
let seq = 0;

beforeAll(async () => {
  await h.start();
  ({ a, b } = h);
  act = actionRoute(h.tokens);
  j = journalRoutes(h.tokens);
}, 60000);
afterAll(async () => {
  await pool.query('UPDATE bank_transactions SET matched_journal_line_id = NULL, reconciliation_id = NULL WHERE company_id = ANY($1)', [h.companies]);
  await pool.query('DELETE FROM bank_reconciliations WHERE company_id = ANY($1)', [h.companies]);
  await h.stop(cleanupBankControlsA);
});

describe('auto-match', () => {
  /** A pushed a R500 withdrawal; `journalBy` posted a R500 journal (DR expA / CR bank) that auto-match pairs it with. */
  async function pair(journalBy: string, types = ['manual_journal'], members?: [string, string][]) {
    const f = await h.fixture(types, members);
    const line = await h.push(f, a, -500);
    const je = await plantJournal(pool, f, journalBy, { amount: 500 });
    expect((await j.post(journalBy, f.c, je)).state.statusCode).toBe(200);
    return { f, line };
  }
  const autoMatch = async (user: string, f: BankCompany) => {
    const res = await act(user, f.c, { action: 'auto_match', bankAccountId: f.bank });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    return dataOf<{ matched: number; skippedImporter?: number }>(res);
  };

  it("the pusher's own pushed line against their own journal is skipped and counted; another member's run matches it", async () => {
    const { f, line } = await pair(a);
    expect(await autoMatch(a, f)).toMatchObject({ matched: 0, skippedImporter: 1 });
    expect(await lineStatus(pool, line)).toBe('imported');
    expect(await autoMatch(h.b, f)).toMatchObject({ matched: 1 });
    expect(await lineStatus(pool, line)).toBe('matched');
  });

  it("the pusher matches a journal someone else created; enforcement off changes nothing", async () => {
    expect(await autoMatch(a, (await pair(b)).f)).toMatchObject({ matched: 1 });
    expect(await autoMatch(a, (await pair(a, [])).f)).toMatchObject({ matched: 1 });
  });
});

describe('MCP bulk_allocate_bank_transactions', () => {
  it('skips the pusher\'s extension line as approval_required with the extension wording, dry run and live alike', async () => {
    const f = await h.fixture(['manual_journal']);
    const mine = await h.push(f, a, -9999);
    const theirs = await h.push(f, b, -777);
    const allocations = [
      { transaction_id: mine, alloc_type: 'account', contra_account_id: f.expA },
      { transaction_id: theirs, alloc_type: 'account', contra_account_id: f.expA },
    ];
    const replies: string[] = [];
    for (const dry of [true, false]) {
      const res = await mcp(a, f.c, 'bulk_allocate_bank_transactions', { allocations, dry_run: dry, idempotency_key: `fi-bulk-${Date.now()}-${seq++}` });
      expect(res.isError, res.content[0]!.text).toBeFalsy();
      const body = JSON.parse(res.content[0]!.text) as { skipped: { transaction_id: string; reason: string }[] };
      expect(body.skipped.map((s) => s.transaction_id)).toEqual([mine]);
      expect(body.skipped[0]!.reason).toBe(`approval_required: ${EXT_REFUSAL('manual-journal')}`);
      replies.push(JSON.stringify(body.skipped));
    }
    expect(replies[0]).toBe(replies[1]);
    expect(await lineStatus(pool, mine)).toBe('imported');
    expect(await lineStatus(pool, theirs)).toBe('allocated'); // b's own push, a is not its importer
  });
});

describe('the transfer auto-link', () => {
  /**
   * A colleague's (b's) statement line L on bank, which `allocator` allocates as a transfer to bank2; a's pushed
   * R500 deposit F on bank2 is then the opposite leg of that journal.
   */
  async function transferScenario(allocator: string, types = ['manual_journal'], members?: [string, string][]) {
    const f: FeedCompany = await h.fixture(types, members);
    const l = await plantLine(pool, f, await plantBatch(pool, f, b), -500);
    const res = await act(allocator, f.c, { action: 'allocate', bankTransactionId: l, allocationType: 'transfer', contraAccountId: f.bank2 });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const feed = await h.push(f, a, 500, await h.connection(f, f.bank2));
    return { f, l, feed };
  }
  const relink = (user: string, f: BankCompany) => asToken(pool, user, f.c, () =>
    relinkTransferCounterparts(f.c, f.bank2, { source: 'page_load', linkBatchId: newLinkBatchId() }));

  it("relink as the pusher leaves the pusher's own extension line imported; the allocation still posted; a colleague's relink links it", async () => {
    const { f, l, feed } = await transferScenario(a);
    expect(await lineStatus(pool, l)).toBe('allocated');
    expect(await relink(a, f)).toMatchObject({ linked: 0, failed: false });
    expect(await lineStatus(pool, feed)).toBe('imported');
    expect(await relink(b, f)).toMatchObject({ linked: 1, failed: false });
    expect(await lineStatus(pool, feed)).toBe('allocated');
  });

  it("the import auto-link of a batch holds the pusher's extension line the same way", async () => {
    const { f, feed } = await transferScenario(a);
    const batch = (await pool.query('SELECT import_batch_id FROM bank_transactions WHERE id = $1', [feed])).rows[0].import_batch_id as string;
    const run = (user: string) => asToken(pool, user, f.c, () =>
      autoLinkImportedBatchTransfers(f.c, batch, { source: 'import', linkBatchId: newLinkBatchId(), importBatchId: batch }));
    expect(await run(a)).toMatchObject({ linked: 0, failed: false });
    expect(await lineStatus(pool, feed)).toBe('imported');
    expect(await run(b)).toMatchObject({ linked: 1, failed: false });
  });

  it('a sole approver, enforcement off and a line another person pushed all link as before', async () => {
    const sole = await transferScenario(a, ['manual_journal'], [[a, 'admin'], [b, 'viewer']]);
    expect(await relink(a, sole.f)).toMatchObject({ linked: 1 });
    const off = await transferScenario(a, []);
    expect(await relink(a, off.f)).toMatchObject({ linked: 1 });
    const f = await h.fixture(['manual_journal']);
    const l = await plantLine(pool, f, await plantBatch(pool, f, b), -500);
    expect((await act(a, f.c, { action: 'allocate', bankTransactionId: l, allocationType: 'transfer', contraAccountId: f.bank2 })).state.statusCode).toBe(200);
    const theirs = await h.push(f, b, 500, await h.connection(f, f.bank2));
    expect(await relink(a, f)).toMatchObject({ linked: 1 });
    expect(await lineStatus(pool, theirs)).toBe('allocated');
  });
});
