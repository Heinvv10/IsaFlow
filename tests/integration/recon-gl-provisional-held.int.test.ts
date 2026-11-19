/**
 * A bank-first provisional journal X carries its own statement line through `provisional_je_id`, so X's bank leg is
 * already that line's movement: `matchTransaction` refuses a second statement line on it (LINE_CLAIMED). The
 * reconciliation's GL side (`reconcilableGlLineWhere`: the manual-match list AND auto-match) offered that leg anyway:
 * the list showed a line Match then refused (400), and auto-match attempted it and reported it as raced. Both now leave out a
 * journal held by a provisional, read down the reversal chain the way the confirm and the transaction picker read it.
 *
 * Edges (ledger-breaker review of #1596): a re-reversed provisional's live head stays held; a released hold (its line's
 * provisional_je_id cleared) gives the leg back; and another company's provisional, even one whose row names THIS
 * company's journal, hides nothing here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import reconGlLines from '../../pages/api/accounting/bank-reconciliation-gl-lines';
import { listReconcilableGlLines } from '@/modules/accounting/services/bank/bankReconcilableGlLines';
import { autoMatchTransactions } from '@/modules/accounting/services/bank/bankAutoMatchService';
import { inTx } from './helpers/l1FifoFixture';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { request, response } from './mfa-impersonation-postgres.helpers';
import { buildChain, setup, teardown, type Ctx } from './d8-r4-helpers';
import { clearExtras, setupWithUser } from './d10-helpers';
import { STATEMENT_DATE, call, cleanup, newBank, routes, seedJournal, seedLine, startSession } from './d12-helpers';

let c: Ctx;
let token = '';
let bank = '';
let rec = '';
let heldLeg = '';
let freeLeg = '';
let rival = '';
/** Company B, with a provisional of its own. */
let b: Ctx | undefined;
type Row = Record<string, unknown>;

/** A posted provisional journal X (expense DR / bank CR `total`) whose own statement line `line` carries it. */
async function makeProvisional(line: string, total: number, date: string, x0: Ctx = c, onBank = bank) {
  const [x] = (await sql`INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, created_by,
      posting_agent, needs_evidence)
    VALUES (${x0.fx.companyId}::UUID, ${date}::DATE, 'RGLP provisional', 'auto_bank_recon', 'draft', ${x0.fx.userId}::UUID,
      'ai-provisional:v1', true) RETURNING id`) as Row[];
  await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
    VALUES (${x0.fx.companyId}::UUID, ${x!.id}::UUID, ${x0.acct.expense}::UUID, ${total}, 0, 'RGLP provisional')`;
  const [leg] = (await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
    VALUES (${x0.fx.companyId}::UUID, ${x!.id}::UUID, ${onBank}::UUID, 0, ${total}, 'RGLP provisional') RETURNING id`) as Row[];
  await sql`UPDATE gl_journal_entries SET status = 'posted', posted_at = NOW() WHERE id = ${x!.id}::UUID`;
  await sql`UPDATE bank_transactions SET status = 'provisional', provisional_je_id = ${x!.id}::UUID WHERE id = ${line}::UUID`;
  return { je: String(x!.id), bankLeg: String(leg!.id) };
}

async function listIds(session = rec): Promise<string[]> {
  const req = request({ 'sb-access-token': token, active_company_id: c.fx.companyId }, 'GET') as unknown as Row;
  req.query = { reconciliationId: session };
  const out = response();
  await (reconGlLines as (q: never, s: never) => unknown)(req as never, out.res as never);
  expect(out.state.statusCode, JSON.stringify(out.state.body).slice(0, 300)).toBe(200);
  return ((out.state.body as { data: { lines: { id: string }[] } }).data.lines).map((l) => l.id);
}

describe.skipIf(!process.env.DATABASE_URL || !process.env.JWT_SECRET)('recon GL side leaves out provisional-held legs', () => {
  beforeAll(async () => {
    assertNotProductionDb('recon GL provisional held');
    ({ c, token } = await setupWithUser('RGLP'));
    bank = await newBank(c);
    // X's own statement line carries it; X's bank leg is held.
    const own = await seedLine(c, bank, 77, '2026-06-05');
    heldLeg = (await makeProvisional(own, 77, '2026-06-05')).bankLeg;
    // An ordinary unmatched GL line on the same bank (still offered).
    freeLeg = await seedJournal(c, bank, 66, '2026-06-06');
    rec = await startSession(c, token, bank);
    // A second, imported statement line of X's amount and date: auto-match pairs it with X's leg at 0.9 unless held.
    rival = await seedLine(c, bank, 77, '2026-06-05');
  }, 180000);
  afterAll(async () => {
    await sql`UPDATE bank_transactions SET provisional_je_id = NULL
      WHERE company_id = ANY(${[c.fx.companyId, ...(b ? [b.fx.companyId] : [])]}::UUID[])`;
    await cleanup(c); await clearExtras(c); await teardown(c);
    await cleanup(b); await teardown(b);
  }, 120000);

  it('control: matching the held leg by hand is refused (400) with a readable sentence', async () => {
    const out = await call(c, token, routes.tx, { action: 'match', bankTransactionId: rival, journalLineId: heldLeg,
      reconciliationId: rec });
    expect(out.status, out.body).toBe(400);
    expect(out.body).toMatch(/is the bank leg of a provisional journal whose own bank transaction .* already carries it/);
    expect(out.body).not.toMatch(/violates|duplicate key|SQLSTATE/);
  }, 60000);

  it('the manual-match list does not offer the held leg, and still offers an ordinary line', async () => {
    const ids = await listIds();
    expect(ids).toContain(freeLeg);
    expect(ids).not.toContain(heldLeg);
  }, 60000);

  it('auto-match does not attempt the held leg: no refusal counted, the rival line stays imported', async () => {
    const out = await call(c, token, routes.tx, { action: 'auto_match', bankAccountId: bank, reconciliationId: rec });
    expect(out.status, out.body).toBe(200);
    // A held leg reached matchTransaction's LINE_CLAIMED, which auto-match counts as raced ("allocated by another
    // request") — the wrong story for a line that was never matchable. Neither counter may move.
    const data = out.data as { matched: number; skippedRefused?: number; skippedRaced?: number };
    expect(data, JSON.stringify(data)).toMatchObject({ matched: 0, skippedRaced: 0, skippedRefused: 0 });
    const [row] = (await sql`SELECT status, matched_journal_line_id FROM bank_transactions WHERE id = ${rival}::UUID`) as Row[];
    expect(row).toMatchObject({ status: 'imported', matched_journal_line_id: null });
  }, 60000);

  /** The bank legs (debit - credit) of `bk`, with their journal and date. */
  const legsOn = async (bk: string) => (await sql`
    SELECT jl.id::TEXT AS id, jl.journal_entry_id::TEXT AS je, (jl.debit - jl.credit)::float8 AS net,
      to_char(je.entry_date, 'YYYY-MM-DD') AS d
    FROM gl_journal_lines jl JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
    WHERE jl.gl_account_id = ${bk}::UUID AND jl.company_id = ${c.fx.companyId}::UUID`) as Row[];
  const autoMatch = async (bk: string, session: string) => {
    const out = await call(c, token, routes.tx, { action: 'auto_match', bankAccountId: bk, reconciliationId: session });
    expect(out.status, out.body).toBe(200);
    return out.data as { matched: number; skippedRaced?: number; skippedRefused?: number };
  };
  const matchedTo = async (line: string) => String(((await sql`
    SELECT matched_journal_line_id::TEXT AS jl FROM bank_transactions WHERE id = ${line}::UUID`) as Row[])[0]!.jl);

  it('a re-reversed provisional: the live head of its chain stays held, in the list and in auto-match', async () => {
    const bk = await newBank(c);
    const own = await seedLine(c, bk, 88, '2026-06-08');
    const x = await makeProvisional(own, 88, '2026-06-08', c, bk);
    // X reversed, then the reversal reversed, through the product: R2 puts X's movement back in the ledger.
    const [, , r2] = await buildChain(c, x.je, 2);
    const legs = await legsOn(bk);
    const head = legs.find((l) => l.je === r2)!;
    // Not vacuous: the head is a -88 movement on this bank, dated inside the session.
    expect(head).toMatchObject({ net: -88 });
    expect(String(head.d) <= STATEMENT_DATE, String(head.d)).toBe(true);
    const session = await startSession(c, token, bk);
    const rivalLine = await seedLine(c, bk, 88, String(head.d));
    const ids = await listIds(session);
    for (const l of legs) expect(ids, `the chain's leg on journal ${String(l.je)}`).not.toContain(l.id);
    expect(await autoMatch(bk, session)).toMatchObject({ matched: 0, skippedRaced: 0, skippedRefused: 0 });
    expect(await matchedTo(rivalLine)).toBe('null');
  }, 120000);

  it('a released hold gives the leg back: offered in the list and matched by auto-match', async () => {
    const bk = await newBank(c);
    const own = await seedLine(c, bk, 99, '2026-06-09');
    const x = await makeProvisional(own, 99, '2026-06-09', c, bk);
    const session = await startSession(c, token, bk);
    expect(await listIds(session)).not.toContain(x.bankLeg);
    // Planted: every product path that clears provisional_je_id (dismiss, auto-post undo, settlement void) also
    // reverses X, so none leaves X standing with the hold gone. The line is set aside (excluded) so that it is not an
    // auto-match candidate itself.
    await sql`UPDATE bank_transactions SET provisional_je_id = NULL, status = 'excluded' WHERE id = ${own}::UUID`;
    expect(await listIds(session)).toContain(x.bankLeg);
    const rivalLine = await seedLine(c, bk, 99, '2026-06-09');
    expect(await autoMatch(bk, session)).toMatchObject({ matched: 1, skippedRaced: 0, skippedRefused: 0 });
    expect(await matchedTo(rivalLine)).toBe(x.bankLeg);
  }, 120000);

  it("another company's provisional hides none of this company's lines, even a row naming this company's journal", async () => {
    b = await setup('RGLPB');
    // B's own provisional, on B's bank.
    const bLine = await seedLine(b, b.fx.bankAccountId, 55, '2026-06-11');
    await makeProvisional(bLine, 55, '2026-06-11', b, b.fx.bankAccountId);
    const bk = await newBank(c);
    const mine = await seedJournal(c, bk, 55, '2026-06-11');
    const mineJe = String((await legsOn(bk)).find((l) => l.id === mine)!.je);
    // A B row that names A's journal as its provisional: the FK to gl_journal_entries is not a tenant check, so only
    // the held set's own company_id keeps B's row from holding A's journal.
    const forged = await seedLine(b, b.fx.bankAccountId, 56, '2026-06-12');
    await sql`UPDATE bank_transactions SET status = 'provisional', provisional_je_id = ${mineJe}::UUID WHERE id = ${forged}::UUID`;
    const session = await startSession(c, token, bk);
    expect(await listIds(session)).toContain(mine);
    // Through a request, row-level security already hides B's row from A. The held set's own company_id is the guard
    // for every caller without those GUCs (MCP tools, sweeps), so both readers are driven here on a connection that
    // bypasses RLS too.
    expect((await listReconcilableGlLines(c.fx.companyId, session))!.lines.map((l) => l.id)).toContain(mine);
    const rivalLine = await seedLine(c, bk, 55, '2026-06-11');
    const run = await inTx(c.fx, () => autoMatchTransactions(c.fx.companyId, bk, session, c.fx.userId));
    expect(run, JSON.stringify(run)).toMatchObject({ matched: 1, skippedRaced: 0, skippedRefused: 0 });
    expect(await matchedTo(rivalLine)).toBe(mine);
  }, 120000);
});
