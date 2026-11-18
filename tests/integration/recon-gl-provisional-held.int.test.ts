/**
 * A bank-first provisional journal X carries its own statement line through `provisional_je_id`, so X's bank leg is
 * already that line's movement: `matchTransaction` refuses a second statement line on it (LINE_CLAIMED). The
 * reconciliation's GL side (`reconcilableGlLineWhere`: the manual-match list AND auto-match) offered that leg anyway:
 * the list showed a line Match then refused (400), and auto-match attempted it and reported it as raced. Both now leave out a
 * journal held by a provisional, read down the reversal chain the way the confirm and the transaction picker read it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import reconGlLines from '../../pages/api/accounting/bank-reconciliation-gl-lines';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { request, response } from './mfa-impersonation-postgres.helpers';
import { teardown, type Ctx } from './d8-r4-helpers';
import { clearExtras, setupWithUser } from './d10-helpers';
import { call, cleanup, newBank, routes, seedJournal, seedLine, startSession } from './d12-helpers';

let c: Ctx;
let token = '';
let bank = '';
let rec = '';
let heldLeg = '';
let freeLeg = '';
let rival = '';
type Row = Record<string, unknown>;

/** A posted provisional journal X (expense DR / bank CR `total`) whose own statement line `line` carries it. */
async function makeProvisional(line: string, total: number, date: string): Promise<{ je: string; bankLeg: string }> {
  const [x] = (await sql`INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, created_by,
      posting_agent, needs_evidence)
    VALUES (${c.fx.companyId}::UUID, ${date}::DATE, 'RGLP provisional', 'auto_bank_recon', 'draft', ${c.fx.userId}::UUID,
      'ai-provisional:v1', true) RETURNING id`) as Row[];
  await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
    VALUES (${c.fx.companyId}::UUID, ${x!.id}::UUID, ${c.acct.expense}::UUID, ${total}, 0, 'RGLP provisional')`;
  const [leg] = (await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
    VALUES (${c.fx.companyId}::UUID, ${x!.id}::UUID, ${bank}::UUID, 0, ${total}, 'RGLP provisional') RETURNING id`) as Row[];
  await sql`UPDATE gl_journal_entries SET status = 'posted', posted_at = NOW() WHERE id = ${x!.id}::UUID`;
  await sql`UPDATE bank_transactions SET status = 'provisional', provisional_je_id = ${x!.id}::UUID WHERE id = ${line}::UUID`;
  return { je: String(x!.id), bankLeg: String(leg!.id) };
}

async function listIds(): Promise<string[]> {
  const req = request({ 'sb-access-token': token, active_company_id: c.fx.companyId }, 'GET') as unknown as Row;
  req.query = { reconciliationId: rec };
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
    await sql`UPDATE bank_transactions SET provisional_je_id = NULL WHERE company_id = ${c.fx.companyId}::UUID`;
    await cleanup(c); await clearExtras(c); await teardown(c);
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
});
