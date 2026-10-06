/**
 * NUMRACE round 3 (sec-numrace S4): the ledger-date window (utils/journalDateWindow) enforced once at the funnel —
 * createJournalEntry refuses an entry date outside 1900-01-01..2199-12-31 before the journal writes anything
 * (gl/journalDateGuard) — and on bank-transfers, which INSERTs its journal itself.
 *
 *   - the manual journal route: 400 with the window's wording, nothing written;
 *   - MCP create_draft_journal: the caller-safe refusal, nothing written;
 *   - `preWrite`: a refusal raised after the request wrote is NOT answered 4xx (withAuth would COMMIT that write) —
 *     respondIfJournalDateRefused declines it, leaving the 500 that rolls it back;
 *   - bank-transfers: a transferDate outside the window is a 422 before anything runs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import journalEntries from '../../pages/api/accounting/journal-entries';
import bankTransfers from '../../pages/api/accounting/bank-transfers';
import { createDraftJournalTool } from '@/lib/mcp/tools/writeJournals';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { respondIfJournalDateRefused } from '@/lib/apiJournalDate';
import { isJournalDateRefused } from '@/modules/accounting/utils/journalDateWindow';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { response } from './mfa-impersonation-postgres.helpers';
import { dropFixture, inTx, seedBankTx } from './helpers/l1FifoFixture';
import { callRoute, dropRouteUser, seedRouteUser } from './helpers/vatLateClaimRoutes';
import { dropCrossYear, seedCrossYear, toolCtx, type CrossYear } from './helpers/numraceCrossYear';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
let c: CrossYear;
let token = '';

const lines = () => [
  { glAccountId: c.expense, debit: 10, credit: 0, description: 'NRJD' },
  { glAccountId: c.fx.bankAccountId, debit: 0, credit: 10, description: 'NRJD' },
];
const journals = async (tag: string) => Number(((await sql`SELECT COUNT(*)::int AS n FROM gl_journal_entries
  WHERE company_id = ${c.fx.companyId}::UUID AND description = ${tag}`) as { n: number }[])[0]!.n);

async function refusalOf(fn: () => Promise<unknown>): Promise<unknown> {
  try { await fn(); } catch (err) { return err; }
  return null;
}

describeIfDb('NUMRACE r3 (S4): createJournalEntry refuses a date outside 1900..2199', () => {
  beforeAll(async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    c = await seedCrossYear('NUMRACE-JD', DATABASE_URL!);
    token = await seedRouteUser(c.fx, 'numrace-jd');
  }, 60000);

  afterAll(async () => {
    await dropRouteUser(c.fx);
    await dropCrossYear(c);
    await dropFixture(c.fx);
  }, 60000);

  it('the manual journal route: 0001-06-01 is a 400 naming the window, nothing written', async () => {
    const out = await callRoute(c.fx, token, journalEntries, {
      entryDate: '0001-06-01', description: 'NRJD route', lines: lines(),
    });
    process.stdout.write(`JD-route ${JSON.stringify(out)}\n`);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(JSON.stringify(out.body)).toMatch(/outside 1900-01-01 to 2199-12-31/);
    expect(await journals('NRJD route')).toBe(0);
  }, 60000);

  it('MCP create_draft_journal dated 2200-01-01: the caller-safe refusal, nothing written', async () => {
    const out = await inTx(c.fx, () => createDraftJournalTool.handler({
      date: '2200-01-01', memo: 'NRJD mcp', idempotency_key: `nrjd-${crypto.randomUUID()}`,
      lines: [
        { account_id: c.expense, debit: 10, credit: 0 },
        { account_id: c.fx.bankAccountId, debit: 0, credit: 10 },
      ],
    }, toolCtx(c)));
    process.stdout.write(`JD-mcp ${JSON.stringify(out)}\n`);
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(/outside 1900-01-01 to 2199-12-31/);
    expect(await journals('NRJD mcp')).toBe(0);
  }, 60000);

  it('preWrite: refused before any write → a route 400; refused after one → declined (the 500 rolls it back)', async () => {
    const clean = await refusalOf(() => inTx(c.fx, () => createJournalEntry(c.fx.companyId,
      { entryDate: '100000-01-01', description: 'NRJD clean', lines: lines() }, c.fx.userId)));
    const dirty = await refusalOf(() => inTx(c.fx, async () => {
      await seedBankTx(c.fx, { date: '2025-06-01', amount: -1, description: 'NRJD earlier write' });
      return createJournalEntry(c.fx.companyId,
        { entryDate: '0001-06-01', description: 'NRJD dirty', lines: lines() }, c.fx.userId);
    }));
    const cleanRes = response();
    const dirtyRes = response();
    const answered = [respondIfJournalDateRefused(cleanRes.res as never, clean),
      respondIfJournalDateRefused(dirtyRes.res as never, dirty)];
    process.stdout.write(`JD-prewrite ${JSON.stringify({ clean: String(clean), dirty: String(dirty), answered })}\n`);
    expect(isJournalDateRefused(clean) && clean.preWrite).toBe(true);
    expect(isJournalDateRefused(dirty) && !dirty.preWrite).toBe(true);
    expect(answered).toEqual([true, false]);
    expect(cleanRes.state.statusCode).toBe(400);
    expect(await journals('NRJD clean') + await journals('NRJD dirty')).toBe(0);
  }, 60000);

  it('bank-transfers (INSERTs its own journal): transferDate 0001-06-01 is a 422 before anything runs', async () => {
    const out = await callRoute(c.fx, token, bankTransfers, {
      fromAccountId: c.fx.bankAccountId, toAccountId: c.expense, amount: 10, transferDate: '0001-06-01',
    });
    process.stdout.write(`JD-txf ${JSON.stringify(out)}\n`);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(422);
    expect(JSON.stringify(out.body)).toMatch(/between 1900-01-01 and 2199-12-31/);
  }, 60000);
});
