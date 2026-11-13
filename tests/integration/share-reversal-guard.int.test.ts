/**
 * A share journal with live undo-share journals cannot be reversed (step 6 round 2, breaker REPRO 10): reversing it
 * would give back a second time what the undos already gave back. Pinned on every entrance — the service
 * (breaker6-r2), MCP reverse_journal_entry (dry run and live) and the REST journal-entries-action route — each a clean
 * refusal with nothing written; an ordinary journal still reverses; once the undo is reversed, so does the share.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { McpRegistry } from '@/lib/mcp/registry';
import { reverseJournalEntryTool } from '@/lib/mcp/tools/writeJournalReverse';
import type { McpToolContext } from '@/lib/mcp/types';
import journalEntriesAction from '../../pages/api/accounting/journal-entries-action';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { dropFixture, inTx, runOn, seedFixture, type Fixture } from './helpers/l1FifoFixture';
import { dropStepExtras, ledger, postedJournal, seedStepAccounts, type StepAccounts } from './helpers/shareUndoFixture';
import { text, undoShareKit } from './helpers/undoShareKit';
import { callRoute, dropRouteUser, seedRouteUser } from './helpers/vatLateClaimRoutes';

const DATABASE_URL = process.env.DATABASE_URL;
type Row = Record<string, unknown>;
let fx: Fixture;
let a: StepAccounts;
let token = '';
const { call, callHere, payStatus, scenario } = undoShareKit(() => fx, () => a);

/** Run `first` on its own connection and HOLD its transaction; start `second` (own transaction); then commit. */
async function holdThen<T>(first: () => Promise<unknown>, second: () => Promise<T>): Promise<{ second: T | Error }> {
  const c1 = await fx.pool.connect();
  await c1.query('BEGIN');
  try {
    await runOn(fx, c1, first);
    const pending = second().then((v) => v, (e: unknown) => e as Error);
    await new Promise((r) => { setTimeout(r, 500); });  // `second` is now waiting on the share's row
    await c1.query('COMMIT');
    return { second: await pending };
  } catch (err) {
    await c1.query('ROLLBACK');
    throw err;
  } finally {
    c1.release();
  }
}
const registry = new McpRegistry();
registry.register(reverseJournalEntryTool);
const reverseTool = (id: string, dry = false) => inTx(fx, () => registry.call('reverse_journal_entry',
  { journal_entry_id: id, idempotency_key: crypto.randomUUID(), ...(dry ? { dry_run: true } : {}) },
  { userId: fx.userId, companyId: fx.companyId, scopes: ['write:journals', 'write:post'], companyRole: 'owner',
    tokenJti: 'step6', oauthAppId: null } as McpToolContext));
const reversedAt = async (id: string) =>
  ((await sql`SELECT reversed_at FROM gl_journal_entries WHERE id = ${id}::UUID`) as Row[])[0]!.reversed_at;

describe.skipIf(!DATABASE_URL || !process.env.JWT_SECRET)('reversing a share journal with live undos', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test posts and reverses journals.');
    fx = await seedFixture('SHREV', DATABASE_URL!);
    a = await seedStepAccounts(fx);
    token = await seedRouteUser(fx, 'shrev');
  }, 120000);
  afterAll(async () => { await dropRouteUser(fx); await dropStepExtras(fx); await dropFixture(fx); }, 120000);

  it('is refused by MCP (dry and live) and REST with nothing written; after the undo is reversed, the share reverses', async () => {
    // Round 5: own month — its reversed share is a re-date fingerprint for every same-shape share of its month.
    const s = await scenario('SHREV', '2026-08-31', '2026-08-10');
    const u = await call({ payment_id: s.pay, undo_share: true, share_journal_id: s.share, idempotency_key: crypto.randomUUID() });
    expect(u.isError, text(u)).toBeFalsy();
    const before = await ledger(fx);

    for (const dry of [true, false]) {
      const r = await reverseTool(s.share, dry);
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/is the share journal of undo-share journal JE-.*reverse those undo journals first/);
    }
    const rest = await callRoute(fx, token, journalEntriesAction, { id: s.share, action: 'reverse' });
    expect(rest.statusCode).toBe(400);
    expect(JSON.stringify(rest.body)).toMatch(/is the share journal of undo-share journal/);
    expect(await reversedAt(s.share)).toBeNull();
    expect(await ledger(fx)).toEqual(before);

    const undoId = String(JSON.parse(text(u)).undo_share.journal_entry_ids[0]);
    expect((await reverseTool(undoId)).isError).toBeFalsy();
    expect((await callRoute(fx, token, journalEntriesAction, { id: s.share, action: 'reverse' })).statusCode).toBe(200);
    expect(await reversedAt(s.share)).not.toBeNull();
  }, 120000);

  it('race: an undo holding the share\'s row — the reversal waits, then refuses once the undo commits', async () => {
    const s = await scenario('RACEU', '2026-05-31');
    const out = await holdThen(
      async () => {
        const u = await callHere({ payment_id: s.pay, undo_share: true, share_journal_id: s.share, idempotency_key: crypto.randomUUID() });
        expect(u.isError, text(u)).toBeFalsy();
      },
      () => inTx(fx, () => reverseJournalEntry(fx.companyId, s.share, fx.userId)),
    );
    expect(out.second).toBeInstanceOf(Error);
    expect((out.second as Error & { code?: string }).code).toBe('SHARE_HAS_LIVE_UNDOS');
    expect(await reversedAt(s.share)).toBeNull();
    expect(await payStatus(s.pay)).toBe('cancelled');
  }, 120000);

  it('race: a reversal holding the share\'s row — the undo waits, then refuses the reversed share', async () => {
    const s = await scenario('RACER', '2026-05-31');
    const out = await holdThen(
      () => reverseJournalEntry(fx.companyId, s.share, fx.userId),
      () => call({ payment_id: s.pay, undo_share: true, share_journal_id: s.share, idempotency_key: crypto.randomUUID() }),
    );
    const r = out.second as Awaited<ReturnType<typeof call>>;
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/is not posted and standing .*reversed/);
    expect(await reversedAt(s.share)).not.toBeNull();
    expect(await payStatus(s.pay)).toBe('processed');
  }, 120000);

  it('an ordinary journal is unaffected: MCP and REST reverse it as before', async () => {
    const j1 = await postedJournal(fx, '2026-06-10', [{ account: a.expense, debit: 10 }, { account: a.bank, credit: 10 }]);
    const j2 = await postedJournal(fx, '2026-06-11', [{ account: a.expense, debit: 20 }, { account: a.bank, credit: 20 }]);
    const r = await reverseTool(j1);
    expect(r.isError, text(r)).toBeFalsy();
    expect((await callRoute(fx, token, journalEntriesAction, { id: j2, action: 'reverse' })).statusCode).toBe(200);
    expect([await reversedAt(j1), await reversedAt(j2)].every((v) => v != null)).toBe(true);
  }, 120000);

  it('round 5: the LINK decides — a live journal naming a share as its source record blocks it, whatever its reference', async () => {
    const j1 = await postedJournal(fx, '2026-06-13', [{ account: a.expense, debit: 10 }, { account: a.bank, credit: 10 }]);
    const j3 = await postedJournal(fx, '2026-06-14', [{ account: a.expense, debit: 5 }, { account: a.bank, credit: 5 }], 'not an undo-share reference');
    await sql`UPDATE gl_journal_entries SET source_record_id = ${j1}::UUID WHERE id = ${j3}::UUID AND company_id = ${fx.companyId}::UUID`;
    expect(text(await reverseTool(j1))).toMatch(/is the share journal of undo-share journal/);
    expect(await reversedAt(j1)).toBeNull();
  }, 120000);
});
