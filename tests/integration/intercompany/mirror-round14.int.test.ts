/**
 * Intercompany P2, round 14: RULING 2026-11-21 (Hein), the per-pair cutover.
 *  - the pair's cutover is the latest of the connection's cut-over date and the two sides' mirroring_since (both links set), read by
 *    intercompany_pair_cutovers; one side off: no cutover;
 *  - from it the P1 generator drafts nothing for the pair's sale-class rows (either direction) and lists them "eliminated by mirroring"; the day
 *    before is drafted as always; a loan row is drafted;
 *  - a hand-made elimination dated on or after a cutover needs a reason (cutoverRequiringReason), and the reason is stored.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { createIntercompanyTransaction } from '../../../src/modules/accounting/services/reports/intercompanyService';
import { autoGenerateEliminations, type SkippedEliminationRow } from '../../../src/modules/accounting/services/reports/eliminationGenerator';
import { createEliminationAdjustment } from '../../../src/modules/accounting/services/reports/consolidatedReportingService';
import { cutoverRequiringReason, getPairCutovers } from '../../../src/modules/accounting/services/reports/eliminationDuplicates';
import { asService, co, groupAccounts, U } from './mirror.helpers';
import { makeLedger } from './ledger.helpers';
import { asAppUser, party, withoutTrigger } from './intercompany.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const L = makeLedger(pool);
beforeAll(async () => { await L.setup(); await L.monthly(co.A, 2026); await L.monthly(co.B, 2026); }, 60000);
afterAll(L.cleanup, 60000);
beforeEach(L.reset);

const conn = async () => (await pool.query("SELECT id FROM intercompany_connections WHERE status <> 'revoked' AND $1 IN (company_low_id, company_high_id) AND $2 IN (company_low_id, company_high_id)", [co.A, co.B])).rows[0].id as string;
/** Both sides' links set (L.reset's connect sets A's customer and B's supplier only), mirroring_since back-dated, the cut-over date set. */
async function turnOn(o: { cutover?: string; since?: string; aOn?: boolean; bOn?: boolean } = {}) {
  const id = await conn();
  if (o.aOn !== false) await asAppUser(pool, U.ab, co.A, (q) => q.query('UPDATE intercompany_connection_sides SET supplier_id = $2 WHERE connection_id = $1 AND company_id = $3', [id, party.aSupplier, co.A]), true);
  if (o.bOn !== false) await asAppUser(pool, U.ab, co.B, (q) => q.query('UPDATE intercompany_connection_sides SET customer_id = $2 WHERE connection_id = $1 AND company_id = $3', [id, party.bCustomer, co.B]), true);
  await asAppUser(pool, U.ab, co.A, (q) => q.query('UPDATE intercompany_connections SET cutover_date = $2 WHERE id = $1', [id, o.cutover ?? '2026-03-01']), true);
  // (a fixture: back-date the stamp the database wrote, past both side triggers, re-enabled in the same transaction)
  await withoutTrigger(pool, 'intercompany_connection_sides', 'trg_intercompany_sides_auto_since', async (q) => {
    await q.query('ALTER TABLE intercompany_connection_sides DISABLE TRIGGER trg_intercompany_sides_guard');
    await q.query('UPDATE intercompany_connection_sides SET mirroring_since = $2::timestamptz WHERE connection_id = $1 AND mirroring_since IS NOT NULL', [id, `${o.since ?? '2026-01-01'} 09:00+02`]);
    await q.query('ALTER TABLE intercompany_connection_sides ENABLE ALWAYS TRIGGER trg_intercompany_sides_guard');
  });
}
async function manual(src: string, tgt: string, type: string, date: string, amount = 500) {
  const r = await asService(pool, U.ab, src, () => createIntercompanyTransaction({
    groupId: co.G, sourceCompanyId: src, targetCompanyId: tgt, transactionType: type, amount, transactionDate: date, description: `manual ${type} ${date}` }));
  await pool.query("UPDATE intercompany_transactions SET match_status = 'matched' WHERE id = $1", [r.id]);
  return r.id as string;
}
async function generate(from = '2026-01-01', to = '2026-06-30') {
  const skipped: SkippedEliminationRow[] = [];
  const made = await asService(pool, U.ab, co.A, () => autoGenerateEliminations(co.G, from, to, [], skipped));
  return { drafted: made.map((m) => m.sourceIntercompanyId), skipped };
}

describe('the pair\'s cutover', () => {
  it('both sides on: the latest of the cut-over date and the two mirroring_since dates', async () => {
    await turnOn({ cutover: '2026-03-01', since: '2026-01-10' });
    expect([...(await asService(pool, U.ab, co.A, () => getPairCutovers(co.G))).values()]).toEqual(['2026-03-01']);
    await turnOn({ cutover: '2026-03-01', since: '2026-04-10' });
    expect([...(await asService(pool, U.ab, co.A, () => getPairCutovers(co.G))).values()]).toEqual(['2026-04-10']);
  });

  it.each([['B', { bOn: false }], ['A', { aOn: false }]] as const)('one company on, the other off (%s lacks a link): no cutover, the rows are drafted as before', async (_who, off) => {
    await turnOn(off);
    expect((await asService(pool, U.ab, co.A, () => getPairCutovers(co.G))).size).toBe(0);
    const r = await manual(co.A, co.B, 'sale', '2026-03-05');
    expect((await generate()).drafted).toContain(r);
  });

  it('a side switched on stamps mirroring_since itself (a sent value is ignored); switched off clears it', async () => {
    const id = await conn();
    await asAppUser(pool, U.ab, co.A, (q) => q.query('UPDATE intercompany_connection_sides SET supplier_id = $2 WHERE connection_id = $1 AND company_id = $3', [id, party.aSupplier, co.A]), true);
    const since = async () => (await pool.query('SELECT mirroring_since FROM intercompany_connection_sides WHERE connection_id = $1 AND company_id = $2', [id, co.A])).rows[0].mirroring_since as Date | null;
    expect(Math.abs(Date.now() - (await since())!.getTime())).toBeLessThan(120000);
    await asAppUser(pool, U.ab, co.A, (q) => q.query('UPDATE intercompany_connection_sides SET supplier_id = NULL WHERE connection_id = $1 AND company_id = $2', [id, co.A]), true);
    expect(await since()).toBeNull();
  });
});

describe('the generator from the cutover (2026-03-01)', () => {
  it('the day before is drafted; the day of is skipped, "eliminated by mirroring"', async () => {
    await turnOn();
    const before = await manual(co.A, co.B, 'sale', '2026-02-28');
    const on = await manual(co.A, co.B, 'sale', '2026-03-01');
    const g = await generate();
    expect(g.drafted).toContain(before);
    expect(g.drafted).not.toContain(on);
    expect(g.skipped).toEqual([{ transactionId: on, reason: 'eliminated by mirroring', cutover: '2026-03-01' }]);
  });

  it('either direction, sale, purchase and mgmt_fee: skipped; a loan of the pair is not (balances are not mirrored)', async () => {
    await turnOn();
    const rows = [await manual(co.A, co.B, 'sale', '2026-03-05'), await manual(co.B, co.A, 'purchase', '2026-03-05'),
      await manual(co.B, co.A, 'sale', '2026-03-06'), await manual(co.A, co.B, 'mgmt_fee', '2026-03-07')];
    const loan = await manual(co.A, co.B, 'loan', '2026-03-05');
    const g = await generate();
    expect(g.skipped.map((s) => s.transactionId).sort()).toEqual([...rows].sort());
    expect(g.skipped.map((s) => s.transactionId)).not.toContain(loan);
  });

  it('a later mirroring_since moves the cutover: 1 March drafted, 10 April skipped', async () => {
    await turnOn({ cutover: '2026-03-01', since: '2026-04-10' });
    const march = await manual(co.A, co.B, 'sale', '2026-03-01');
    const april = await manual(co.A, co.B, 'sale', '2026-04-10');
    const g = await generate();
    expect([g.drafted.includes(march), g.skipped.map((s) => s.transactionId)]).toEqual([true, [april]]);
  });
});

describe('a hand-made elimination after the cutover', () => {
  it('needs a reason from the cutover on (not the day before), and the reason is stored', async () => {
    await turnOn();
    const need = (d: string | null) => asService(pool, U.ab, co.A, () => cutoverRequiringReason(co.G, d));
    expect([await need('2026-02-28'), await need('2026-03-01'), await need(null)]).toEqual([null, '2026-03-01', '2026-03-01']);
    const made = await asService(pool, U.ab, co.A, () => createEliminationAdjustment(co.G, {
      adjustmentType: 'interco_revenue', description: 'by hand', periodStart: '2026-03-31', periodEnd: '2026-03-31', manualReason: 'management fee booked as a journal',
      lines: [{ groupAccountId: groupAccounts.rev, debit: 10, credit: 0, description: '' }, { groupAccountId: groupAccounts.exp, debit: 0, credit: 10, description: '' }] }));
    expect(made.manualReason).toBe('management fee booked as a journal');
    expect((await pool.query('SELECT manual_reason FROM consolidation_adjustments WHERE id = $1', [made.id])).rows[0].manual_reason).toBe('management fee booked as a journal');
  });
});
