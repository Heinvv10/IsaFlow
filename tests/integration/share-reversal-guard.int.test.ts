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
import { dropFixture, inTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';
import { dropStepExtras, ledger, postedJournal, seedStepAccounts, type StepAccounts } from './helpers/shareUndoFixture';
import { text, undoShareKit } from './helpers/undoShareKit';
import { callRoute, dropRouteUser, seedRouteUser } from './helpers/vatLateClaimRoutes';

const DATABASE_URL = process.env.DATABASE_URL;
type Row = Record<string, unknown>;
let fx: Fixture;
let a: StepAccounts;
let token = '';
const { call, scenario } = undoShareKit(() => fx, () => a);
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
    const s = await scenario('SHREV', '2026-05-31');
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

  it('an ordinary journal is unaffected: MCP and REST reverse it as before', async () => {
    const j1 = await postedJournal(fx, '2026-06-10', [{ account: a.expense, debit: 10 }, { account: a.bank, credit: 10 }]);
    const j2 = await postedJournal(fx, '2026-06-11', [{ account: a.expense, debit: 20 }, { account: a.bank, credit: 20 }]);
    // A journal that names j1 as its causing record but is not an undo-share journal does not block j1's reversal.
    const j3 = await postedJournal(fx, '2026-06-12', [{ account: a.expense, debit: 5 }, { account: a.bank, credit: 5 }]);
    await sql`UPDATE gl_journal_entries SET source_record_id = ${j1}::UUID WHERE id = ${j3}::UUID AND company_id = ${fx.companyId}::UUID`;
    const r = await reverseTool(j1);
    expect(r.isError, text(r)).toBeFalsy();
    expect((await callRoute(fx, token, journalEntriesAction, { id: j2, action: 'reverse' })).statusCode).toBe(200);
    expect([await reversedAt(j1), await reversedAt(j2)].every((v) => v != null)).toBe(true);
  }, 120000);
});
