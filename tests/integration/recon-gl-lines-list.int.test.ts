/**
 * The reconciliation screen's manual-match GL list (GET /api/accounting/bank-reconciliation-gl-lines).
 *
 * Seen on prod 2026-11-17: a posted journal on the bank account never appeared in the recon's GL list, while
 * Auto-Match found it. The screen read the company's journal-entries list (`?gl_account_id=…&status=posted&limit=200`):
 * that list ignores `gl_account_id`, carries no lines and stops at the 200 newest entries, so the GL list it built
 * offered nothing. The list now comes from the same definition auto-match uses (`reconcilableGlLineWhere`): every
 * posted, standing, unmatched line of the session's bank account dated on or before its statement date, newest first,
 * with `total` and `truncated` so a cut list is never shown as the whole.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import journalEntries from '../../pages/api/accounting/journal-entries';
import reconGlLines from '../../pages/api/accounting/bank-reconciliation-gl-lines';
import { listReconcilableGlLines } from '@/modules/accounting/services/bank/bankReconcilableGlLines';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { request, response } from './mfa-impersonation-postgres.helpers';
import { setup, teardown, type Ctx } from './d8-r4-helpers';
import { clearExtras, setupWithUser } from './d10-helpers';
import { call, cleanup, newBank, routes, seedJournal, seedPair, startSession, newId } from './d12-helpers';

let c: Ctx;
/** A second company with a reconciliation of its own: the list must answer 404 for it, never its lines. */
let c2: Ctx | undefined;
let otherRec = '';
let token = '';
let bank = '';
let rec = '';
let oldLine = '';
let matchedLine = '';
let lateLine = '';
const NEWER = 210;
type Row = Record<string, unknown>;
interface Page { lines: { id: string; debit: number; credit: number; entryDate: string }[]; total: number; truncated: boolean }

async function get(route: (q: never, s: never) => unknown, query: Record<string, string>) {
  const req = request({ 'sb-access-token': token, active_company_id: c.fx.companyId }, 'GET') as unknown as Row;
  req.query = query;
  const out = response();
  await route(req as never, out.res as never);
  return { status: out.state.statusCode, data: (out.state.body as { data?: unknown } | undefined)?.data };
}
const list = async (query: Record<string, string> = {}) => {
  const out = await get(reconGlLines as never, { reconciliationId: rec, ...query });
  expect(out.status, JSON.stringify(out).slice(0, 400)).toBe(200);
  return out.data as Page;
};

describe.skipIf(!process.env.DATABASE_URL || !process.env.JWT_SECRET)('recon manual-match GL list', () => {
  beforeAll(async () => {
    assertNotProductionDb('recon GL lines list');
    ({ c, token } = await setupWithUser('RGL'));
    bank = await newBank(c);
    // The line that has to be offered: older than every other journal on the account.
    oldLine = await seedJournal(c, bank, 123.45, '2026-01-05');
    // NEWER newer posted journals on the same bank account (bank DR 10.00 .. 12.09), all inside the statement date.
    await sql`
      WITH je AS (
        INSERT INTO gl_journal_entries (company_id, entry_date, description, status, created_by)
        SELECT ${c.fx.companyId}::UUID, DATE '2026-03-01' + (g % 100), 'RGL newer ' || g, 'posted', ${c.fx.userId}::UUID
        FROM generate_series(1, ${NEWER}::INT) g
        RETURNING id, description)
      INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
      SELECT ${c.fx.companyId}::UUID, je.id, v.acct, v.dr * amt, v.cr * amt, je.description
      FROM je
      CROSS JOIN LATERAL (SELECT 10 + split_part(je.description, ' ', 3)::INT / 100.0 AS amt) a
      CROSS JOIN (VALUES (${bank}::UUID, 1, 0), (${c.acct.expense}::UUID, 0, 1)) v(acct, dr, cr)`;
    // Not offered: a line already matched to a statement line, and one dated after the statement date (2026-06-30).
    const p = await seedPair(c, bank, 77.77, '2026-04-01');
    const m = await call(c, token, routes.tx, { action: 'match', bankTransactionId: p.bt, journalLineId: p.jl });
    if (m.status >= 300) throw new Error(`match: ${JSON.stringify(m)}`);
    matchedLine = p.jl;
    lateLine = await seedJournal(c, bank, 88.88, '2026-07-15');
    rec = await startSession(c, token, bank);
    c2 = await setup('RGL2');
    await seedJournal(c2, c2.fx.bankAccountId, 55.55, '2026-02-02');
    otherRec = String(((await sql`
      INSERT INTO bank_reconciliations (company_id, bank_account_id, statement_date, statement_balance, started_by)
      VALUES (${c2.fx.companyId}::UUID, ${c2.fx.bankAccountId}::UUID, '2026-06-30', 0, ${c2.fx.userId}::UUID)
      RETURNING id`) as Row[])[0]!.id);
  }, 180000);
  afterAll(async () => {
    await cleanup(c); await clearExtras(c); await teardown(c);
    await cleanup(c2); await teardown(c2);
  }, 120000);

  it('control: the old source (journal-entries, limit 200) does not offer the older line', async () => {
    const out = await get(journalEntries as never, { gl_account_id: bank, status: 'posted', limit: '200' });
    expect(out.status).toBe(200);
    const entries = ((out.data as { entries?: Row[] }).entries ?? []) as { lines?: { id: string; glAccountId: string }[] }[];
    const offered = entries.flatMap((e) => e.lines ?? []).filter((l) => l.glAccountId === bank).map((l) => l.id);
    expect(offered).not.toContain(oldLine);
  }, 60000);

  it('offers the older unmatched line behind more than 200 newer ones, and every reconcilable line', async () => {
    const page = await list();
    const ids = page.lines.map((l) => l.id);
    expect(ids).toContain(oldLine);
    expect(page.total).toBe(NEWER + 1);
    expect(page.lines).toHaveLength(NEWER + 1);
    expect(page.truncated).toBe(false);
    const old = page.lines.find((l) => l.id === oldLine)!;
    expect(old).toMatchObject({ debit: 0, credit: 123.45, entryDate: '2026-01-05' });
  }, 60000);

  it('never offers a matched line or one dated after the statement date', async () => {
    const ids = (await list()).lines.map((l) => l.id);
    expect(ids).not.toContain(matchedLine);
    expect(ids).not.toContain(lateLine);
  }, 60000);

  it('a cut list says so: limit 50 -> 50 newest lines, total and truncated', async () => {
    const page = await list({ limit: '50' });
    expect(page.lines).toHaveLength(50);
    expect(page.total).toBe(NEWER + 1);
    expect(page.truncated).toBe(true);
    const dates = page.lines.map((l) => l.entryDate);
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(page.lines.map((l) => l.id)).not.toContain(oldLine);
  }, 60000);

  it('search narrows on the server: by amount and by description', async () => {
    const byAmount = await list({ search: '123.45', limit: '50' });
    expect(byAmount.lines.map((l) => l.id)).toEqual([oldLine]);
    expect(byAmount.total).toBe(1);
    const byText = await list({ search: 'RGL newer 20', limit: '500' });
    // 'RGL newer 20' and 'RGL newer 200'..'209'.
    expect(byText.total).toBe(11);
    expect((await list({ search: '100%' })).total, 'a LIKE wildcard in the search is literal').toBe(0);
  }, 60000);

  it('refuses a malformed id or limit (400) and another session id (404)', async () => {
    expect((await get(reconGlLines as never, { reconciliationId: 'nope' })).status).toBe(400);
    expect((await get(reconGlLines as never, { reconciliationId: rec, limit: '0' })).status).toBe(400);
    expect((await get(reconGlLines as never, { reconciliationId: rec, limit: '501' })).status).toBe(400);
    expect((await get(reconGlLines as never, { reconciliationId: newId() })).status).toBe(404);
  }, 60000);

  it("another company's real reconciliation is a 404, not its list (nor an empty one)", async () => {
    const out = await get(reconGlLines as never, { reconciliationId: otherRec });
    expect(out.status, JSON.stringify(out).slice(0, 300)).toBe(404);
    expect(out.data).toBeUndefined();
    // Through the route, row-level security already hides the other company's session. The service's own company_id
    // is the guard for every caller without those GUCs (this connection bypasses RLS), so it is asserted there too.
    expect(await listReconcilableGlLines(c.fx.companyId, otherRec)).toBeNull();
    expect(await listReconcilableGlLines(c2!.fx.companyId, otherRec)).toMatchObject({ total: 1 });
  }, 60000);
});
