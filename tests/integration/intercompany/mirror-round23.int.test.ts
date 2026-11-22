/**
 * Intercompany P2, round 23 (the blind review of round 22): a manual elimination of a mirrored row and the derived mirror elimination are
 * MUTUALLY EXCLUSIVE (one predicate, intercompany_row_manually_eliminated), so no path double counts:
 *  H-1  (a) a row whose pair stands is refused; (b) a draft made while the receiver had not accepted is refused at post once it has; a forced
 *       manual elimination suppresses the derived one in every window (additivity: a range is the sum of its months); the list says nothing false.
 *  M-1  an older generator's adjustment (no reason) of a mirrored row is ignored everywhere: the row stays listed and can be eliminated.
 *  M-2  a row-carrying elimination needs both dates, inside the row's month, containing the row's date.
 *  L-1  two creations for one row (no unique index) are serialised by the group's elimination lock.
 *  L-2  a draft can be discarded (the row is listed again); a posted one cannot.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { cancelSupplierInvoice } from '../../../src/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import * as svc from '../../../src/modules/accounting/services/reports/consolidatedReportingService';
import { getPostedEliminations } from '../../../src/modules/accounting/services/reports/consolidatedTrialBalanceService';
import { assertMirroredRowResolvable } from '../../../src/modules/accounting/services/reports/eliminationResolve';
import { getMirroredEliminations, type DroppedMirroredElimination } from '../../../src/modules/accounting/services/reports/mirrorEliminations';
import { asService, co, groupAccounts, inbox, sentInvoice, U } from './mirror.helpers';
import { lockWaiter, makeLedger } from './ledger.helpers';
import { withoutTrigger } from './intercompany.session';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const L = makeLedger(pool);
beforeAll(async () => { await L.setup(); for (const y of [2026, 2027]) { await L.monthly(co.A, y); await L.monthly(co.B, y); } }, 90000);
afterAll(L.cleanup, 60000);
beforeEach(L.reset);

const redate = (bill: string, date: string) => pool.query('UPDATE supplier_invoices SET invoice_date = $2::date, due_date = $2::date + 30 WHERE id = $1', [bill, date]);
/** A December sale the receiver booked in January: a cut-off variance, nothing eliminates it. */
async function variance() { const m = await L.accepted({ date: '2026-12-30' }); await redate(m.bill, '2027-01-02'); await L.approveBill(m.bill); return m; }
/** A sale whose pair stands (the receiver approved its bill in the same month): the mirror eliminates it. */
async function standing(date = '2026-03-05') { const m = await L.accepted({ date }); await L.approveBill(m.bill); return m; }
async function dropped(from: string, to: string) {
  const out: DroppedMirroredElimination[] = [];
  await asService(pool, U.ab, co.A, () => getMirroredEliminations(co.G, from, to, out));
  return out;
}
const lines = () => [{ groupAccountId: groupAccounts.rev, debit: 1000, credit: 0, description: 'Eliminate revenue' }, { groupAccountId: groupAccounts.exp, debit: 0, credit: 1000, description: 'Eliminate expense' }];
/** The route's two steps: the row check, then the insert (one request transaction). */
const eliminate = (row: string, start = '2026-12-30', end = start, reason: string | null = 'The receiver booked it in January') => asService(pool, U.ab, co.A, async () => {
  await assertMirroredRowResolvable(co.G, row, start, end);
  return svc.createEliminationAdjustment(co.G, { adjustmentType: 'interco_revenue', description: 'Manual elimination', periodStart: start, periodEnd: end,
    sourceIntercompanyId: row, ...(reason ? { manualReason: reason } : {}), lines: lines() });
});
/** The row check as the route runs it: inside the request's transaction (its lock is transaction-scoped). */
const check = (row: string, start: string, end: string) => asService(pool, U.ab, co.A, () => assertMirroredRowResolvable(co.G, row, start, end));
const post = (id: string) => asService(pool, U.ab, co.A, () => svc.postEliminationAdjustment(id, co.G));
/** A stored adjustment written straight to the table, past every guard (what a race, an old release or a later change can leave). */
async function force(row: string, status: string, reason: string | null, start: string, end: string): Promise<string> {
  return (await pool.query(
    `INSERT INTO consolidation_adjustments (group_id, adjustment_type, description, period_start, period_end, status, lines, source_intercompany_id, manual_reason)
     VALUES ($1, 'interco_revenue', 'forced', $2, $3, $4, $5::jsonb, $6, $7) RETURNING id`, [co.G, start, end, status, JSON.stringify(lines()), row, reason])).rows[0].id as string;
}
const counted = (from: string, to: string) => asService(pool, U.ab, co.A, () => getPostedEliminations(co.G, from, to));
const manual = (row: string, from: string | null, to: string | null) => pool.query('SELECT public.intercompany_row_manually_eliminated($1, $2, $3) AS v', [row, from, to]).then((r) => r.rows[0].v as boolean);

describe('H-1: the mirror and a person never both eliminate a row', () => {
  it('(a) a row whose pair stands is refused; one forced past the guards suppresses the derived elimination, whatever the window, and the list says no more than is true', async () => {
    await standing();
    const row = await L.groupRow();
    const derivedLines = (await L.derived('2026-03-01', '2026-03-31')).flatMap((e) => e.lines).length;
    expect(derivedLines).toBe(2);
    await expect(check(row.id, '2026-03-01', '2026-03-31')).rejects.toMatchObject({ name: 'EliminationNotUnresolvedError' });
    const adj = await force(row.id, 'posted', 'forced by a race', '2026-03-01', '2026-03-31');
    expect(await counted('2026-03-01', '2026-03-31')).toHaveLength(2);                  // the person's alone, not 4
    expect(await L.derived('2026-03-01', '2026-03-31')).toEqual([]);
    expect(await L.derived('2026-01-01', '2026-12-31')).toEqual([]);
    const list = await asService(pool, U.ab, co.A, () => svc.getEliminationAdjustments(co.G, '2026-03-01', '2026-03-31'));
    expect(list.filter((a) => a.automatic)).toEqual([]);
    expect(list.find((a) => a.id === adj)).toMatchObject({ status: 'posted', mirrorFacts: null });   // (c) no mirror facts are claimed for it
    await pool.query("UPDATE consolidation_adjustments SET status = 'reversed' WHERE id = $1", [adj]);
    expect(await counted('2026-03-01', '2026-03-31')).toHaveLength(2);                  // the mirror's again
    expect(await L.derived('2026-03-01', '2026-03-31')).toHaveLength(1);
  });

  it('another group\'s adjustment naming the row does not suppress its derived elimination', async () => {
    await standing();
    const row = await L.groupRow();
    const g2 = crypto.randomUUID();
    await pool.query("INSERT INTO company_groups(id, name) VALUES ($1, 'IC round 23 other group')", [g2]);
    try {
      await pool.query(`INSERT INTO consolidation_adjustments (group_id, adjustment_type, description, period_start, period_end, status, lines, source_intercompany_id, manual_reason)
                        VALUES ($1, 'interco_revenue', 'elsewhere', '2026-03-01', '2026-03-31', 'posted', '[]'::jsonb, $2, 'a reason')`, [g2, row.id]);
      expect(await manual(row.id, null, null)).toBe(false);
      expect(await L.derived('2026-03-01', '2026-03-31')).toHaveLength(1);
    } finally {
      await pool.query('DELETE FROM consolidation_adjustments WHERE group_id = $1', [g2]);
      await pool.query('DELETE FROM company_groups WHERE id = $1', [g2]);
    }
  });

  it('an adjustment with no period never counts, so it must not suppress the derived elimination either', async () => {
    await standing();
    const row = await L.groupRow();
    await pool.query(`INSERT INTO consolidation_adjustments (group_id, adjustment_type, description, status, lines, source_intercompany_id, manual_reason)
                      VALUES ($1, 'interco_revenue', 'no period', 'posted', '[]'::jsonb, $2, 'a reason')`, [co.G, row.id]);
    expect(await manual(row.id, null, null)).toBe(false);
    expect(await L.derived('2026-03-01', '2026-03-31')).toHaveLength(1);
  });

  it('(b) a draft made while the receiver had not accepted is refused at post once it has (and approved): nothing double counts', async () => {
    const sent = await sentInvoice(pool, { date: '2026-03-05' });
    await withoutTrigger(pool, 'intercompany_messages', 'trg_intercompany_messages_guard', (q) => q.query("UPDATE intercompany_messages SET status = 'failed', error = 'x' WHERE id = $1", [sent.id]));
    const row = await L.groupRow();
    const adj = await eliminate(row.id, '2026-03-05');
    expect((await dropped('2026-03-01', '2026-03-31')).map((d) => d.code)).toEqual(['drafted']);
    expect((await inbox.accept(U.b, co.B, sent.id)).state.statusCode).toBe(200);        // (a failed message can be accepted)
    await L.approveBill((await pool.query('SELECT target_doc_id AS b FROM intercompany_messages WHERE id = $1', [sent.id])).rows[0].b as string);
    await expect(post(adj.id)).rejects.toMatchObject({ name: 'EliminationNotUnresolvedError' });
    expect((await L.adjustments()).map((a) => a.status)).toEqual(['draft']);
    expect(await counted('2026-03-01', '2026-03-31')).toHaveLength(2);                  // the mirror's, once
  });

  it('a manual elimination suppresses the derived reversal too: a range is the sum of its months (window-independent)', async () => {
    const m = await L.accepted({ date: '2026-02-10' });
    await L.approveBill(m.bill);
    await pool.query("UPDATE fiscal_periods SET status = 'closed' WHERE company_id = $1 AND start_date = '2026-02-01'", [co.B]);
    try { await asService(pool, U.b, co.B, () => cancelSupplierInvoice(co.B, m.bill, U.b)); } finally {
      await pool.query("UPDATE fiscal_periods SET status = 'open' WHERE company_id = $1 AND start_date = '2026-02-01'", [co.B]);
    }
    const rev = (await pool.query('SELECT entry_date::text AS d FROM gl_journal_entries WHERE company_id = $1 AND reversal_of_id IS NOT NULL', [co.B])).rows[0].d as string;
    const row = await L.groupRow();
    await force(row.id, 'posted', 'forced: the row is listed only for a window holding both months (a stated limit), so the guard cannot make it', '2026-02-01', '2026-02-28');
    const month = rev.slice(0, 8) + '01';
    const [feb, later, both] = [(await counted('2026-02-01', '2026-02-28')).length, (await counted(month, rev)).length, (await counted('2026-02-01', rev)).length];
    expect([feb, later, both]).toEqual([2, 0, 2]);                                      // 2 + 0 = 2: not 2 + a derived reversal
  });
});

describe('M-1: an older generator\'s adjustment (no reason) of a mirrored row is ignored everywhere', () => {
  it('a draft of one does not list the row as drafted, a posted one does not unlist it; a person can still eliminate it', async () => {
    await variance();
    const row = await L.groupRow();
    const old = await force(row.id, 'draft', null, '2026-12-30', '2026-12-30');
    expect((await dropped('2026-12-01', '2026-12-31')).map((d) => d.code)).toEqual(['variance']);
    await pool.query("UPDATE consolidation_adjustments SET status = 'posted' WHERE id = $1", [old]);
    expect((await dropped('2026-12-01', '2026-12-31')).map((d) => d.code)).toEqual(['variance']);
    expect(await counted('2026-12-01', '2026-12-31')).toEqual([]);
    await post((await eliminate(row.id)).id);                                           // (the index lets a reasoned one stand beside it)
    expect(await dropped('2026-12-01', '2026-12-31')).toEqual([]);
    expect(await counted('2026-12-01', '2026-12-31')).toHaveLength(2);
  });

  it('what the reports count and what the predicate says agree, for every status, reason and period', async () => {
    await variance();
    const row = await L.groupRow();
    for (const status of ['draft', 'posted', 'reversed', 'discarded']) {
      for (const reason of [null, 'because']) {
        for (const [s, e] of [['2026-12-01', '2026-12-31'], ['2026-12-30', '2026-12-30'], ['2026-11-01', '2027-01-31']]) {
          await pool.query('DELETE FROM consolidation_adjustments WHERE group_id = $1', [co.G]);
          await force(row.id, status, reason, s!, e!);
          const stored = (await counted('2026-12-01', '2026-12-31')).length > 0;
          expect(await manual(row.id, '2026-12-01', '2026-12-31'), `${status}/${reason}/${s}-${e}`).toBe(stored);
        }
      }
    }
  });
});

describe('M-2: a row-carrying elimination is dated inside the row\'s month and contains the row\'s date', () => {
  it.each([
    ['no dates', undefined, undefined], ['no end', '2026-12-30', undefined], ['a whole year', '2026-01-01', '2026-12-31'],
    ['into January', '2026-12-30', '2027-01-02'], ['before the row', '2026-12-01', '2026-12-20'], ['another month', '2026-11-01', '2026-11-30'],
  ])('%s is refused', async (_name, start, end) => {
    await variance();
    const row = await L.groupRow();
    await expect(check(row.id, start as string, end as string)).rejects.toMatchObject({ name: 'EliminationSourceError' });
  });

  it('the row\'s own month, or any part of it holding the row\'s date, is accepted and the report of that month counts it', async () => {
    await variance();
    const row = await L.groupRow();
    await expect(check(row.id, '2026-12-01', '2026-12-31')).resolves.toBeUndefined();
    await expect(check(row.id, '2026-12-30', '2026-12-31')).resolves.toBeUndefined();
    await post((await eliminate(row.id, '2026-12-01', '2026-12-31')).id);
    expect(await dropped('2026-12-01', '2026-12-31')).toEqual([]);
    expect(await counted('2026-12-01', '2026-12-31')).toHaveLength(2);
  });
});

describe('L-1: two creations for one row are serialised', () => {
  it('without the unique index the second waits for the first and then sees it stand', async () => {
    await variance();
    const row = await L.groupRow();
    await pool.query('DROP INDEX IF EXISTS uq_consolidation_adjustments_standing_source');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    let one: Promise<void> = Promise.resolve();
    try {
      let made: () => void = () => undefined;
      const first = new Promise<void>((r) => { made = r; });
      one = asService(pool, U.ab, co.A, async () => {
        await assertMirroredRowResolvable(co.G, row.id, '2026-12-30', '2026-12-30');
        await svc.createEliminationAdjustment(co.G, { adjustmentType: 'interco_revenue', description: 'one', periodStart: '2026-12-30', periodEnd: '2026-12-30', sourceIntercompanyId: row.id, manualReason: 'first', lines: lines() });
        made(); await gate;
      });
      await Promise.race([first, one]);
      const two = eliminate(row.id, '2026-12-30', '2026-12-30', 'second');
      const settled = two.then(() => 'created', (e: Error) => e.name);
      expect(await lockWaiter(pool, 'advisory', 5000)).toBe(true);                      // the second REACHED the lock
      release(); await one;
      expect(await settled).toBe('EliminationAlreadyStandsError');
      expect((await L.adjustments()).map((a) => a.status)).toEqual(['draft']);
    } finally {
      release(); await one.catch(() => undefined);                                      // (a failed case must not leave the first session holding the table)
      await pool.query('DELETE FROM consolidation_adjustments WHERE group_id = $1', [co.G]);
      await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS uq_consolidation_adjustments_standing_source ON consolidation_adjustments (source_intercompany_id, (manual_reason IS NOT NULL)) WHERE status IN ('draft', 'posted')");
    }
  });
});

describe('L-2: a draft can be discarded', () => {
  it('the row is listed again and can be eliminated afresh; a posted one is not discarded; another group\'s is not found', async () => {
    await variance();
    const row = await L.groupRow();
    const adj = await eliminate(row.id);
    await expect(eliminate(row.id)).rejects.toMatchObject({ name: 'EliminationAlreadyStandsError', message: expect.stringMatching(/discard/) });
    await asService(pool, U.ab, co.A, () => svc.discardEliminationAdjustment(adj.id, co.G));
    expect((await L.adjustments()).map((a) => a.status)).toEqual(['discarded']);
    expect((await dropped('2026-12-01', '2026-12-31')).map((d) => d.code)).toEqual(['variance']);
    expect((await asService(pool, U.ab, co.A, () => svc.getEliminationAdjustments(co.G, '2026-12-01', '2026-12-31'))).map((a) => a.id)).not.toContain(adj.id);
    const again = await eliminate(row.id);
    await post(again.id);
    await expect(asService(pool, U.ab, co.A, () => svc.discardEliminationAdjustment(again.id, co.G))).rejects.toMatchObject({ name: 'EliminationStateError' });
    await expect(asService(pool, U.ab, co.A, () => svc.discardEliminationAdjustment(adj.id, co.G))).rejects.toMatchObject({ name: 'EliminationStateError' });
    const other = await eliminate(row.id, '2026-12-30', '2026-12-30', 'a reversal first').catch(() => null);   // (the posted one stands: refused)
    expect(other).toBeNull();
    await asService(pool, U.ab, co.A, () => svc.reverseEliminationAdjustment(again.id, co.G));
    const third = await eliminate(row.id);
    await expect(asService(pool, U.ab, co.A, () => svc.discardEliminationAdjustment(third.id, crypto.randomUUID()))).rejects.toMatchObject({ name: 'EliminationStateError' });
  });
});
