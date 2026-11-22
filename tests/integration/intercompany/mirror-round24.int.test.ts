/**
 * Intercompany P2, round 24 (the neighbours of round 23's predicate):
 *  M-1  a person's posted elimination of a row whose sale the SENDER then cancelled is listed ('stale') while it counts, so nobody leaves it behind;
 *  M-2  a person's elimination of a mirrored row and a manual (P1) row for the same sale cannot both count unseen: the duplicate facts say "eliminated
 *       by a person's adjustment", the stand predicate holds, and a mirrored row a posted manual elimination covers is refused;
 *  L-1  a window holding the row's date but not the person's whole period says so (listing and 409);
 *  L-2  a discard records who did it;
 *  L-3  1019 re-creates the standing-source index when an older 1019 left the single-column one; L-4 a plain index on source_intercompany_id exists;
 *  INFO the privilege assertion covers intercompany_row_manually_eliminated.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import * as svc from '../../../src/modules/accounting/services/reports/consolidatedReportingService';
import { getPostedEliminations } from '../../../src/modules/accounting/services/reports/consolidatedTrialBalanceService';
import { assertMirroredRowResolvable } from '../../../src/modules/accounting/services/reports/eliminationResolve';
import { getMirroredEliminations, type DroppedMirroredElimination } from '../../../src/modules/accounting/services/reports/mirrorEliminations';
import { asService, co, groupAccounts, inbox, sentInvoice, U } from './mirror.helpers';
import { makeLedger } from './ledger.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const L = makeLedger(pool);
beforeAll(async () => { await L.setup(); for (const y of [2026, 2027]) { await L.monthly(co.A, y); await L.monthly(co.B, y); } }, 90000);
afterAll(L.cleanup, 60000);
beforeEach(L.reset);

const redate = (bill: string, date: string) => pool.query('UPDATE supplier_invoices SET invoice_date = $2::date, due_date = $2::date + 30 WHERE id = $1', [bill, date]);
/** A December sale the receiver booked in January: a cut-off variance, nothing eliminates it. */
async function variance() { const m = await L.accepted({ date: '2026-12-30' }); await redate(m.bill, '2027-01-02'); await L.approveBill(m.bill); return m; }
/** A March sale the receiver rejected: nothing will eliminate it. */
async function rejected(date = '2026-03-05') { const s = await sentInvoice(pool, { date }); await inbox.reject(U.b, co.B, s.id, { reason: 'Not ours' }); return s; }
async function dropped(from: string, to: string) {
  const out: DroppedMirroredElimination[] = [];
  await asService(pool, U.ab, co.A, () => getMirroredEliminations(co.G, from, to, out));
  return out;
}
const lines = () => [{ groupAccountId: groupAccounts.rev, debit: 1000, credit: 0, description: 'Eliminate revenue' }, { groupAccountId: groupAccounts.exp, debit: 0, credit: 1000, description: 'Eliminate expense' }];
const make = (row: string, start: string, end: string, reason: string | null) => svc.createEliminationAdjustment(co.G, {
  adjustmentType: 'interco_revenue', description: 'Manual elimination', periodStart: start, periodEnd: end, sourceIntercompanyId: row, ...(reason ? { manualReason: reason } : {}), lines: lines() });
/** The route's two steps for a mirrored row: the row check, then the insert (one request transaction). */
const eliminate = (row: string, start = '2026-12-30', end = start, reason: string | null = 'A person eliminated it') => asService(pool, U.ab, co.A, async () => {
  await assertMirroredRowResolvable(co.G, row, start, end);
  return make(row, start, end, reason);
});
const check = (row: string, start: string, end: string) => asService(pool, U.ab, co.A, () => assertMirroredRowResolvable(co.G, row, start, end));
const post = (id: string, confirm = false) => asService(pool, U.ab, co.A, () => svc.postEliminationAdjustment(id, co.G, confirm));
const counted = (from: string, to: string) => asService(pool, U.ab, co.A, () => getPostedEliminations(co.G, from, to));
/** A manual (P1) row of the pair: the same sale as a mirrored invoice of R1 000. */
const manualRow = async (date = '2026-12-30') => (await pool.query(
  `INSERT INTO intercompany_transactions (group_id, source_company_id, target_company_id, transaction_type, amount, transaction_date, description)
   VALUES ($1, $2, $3, 'sale', 1000, $4, 'manual sale of the same invoice') RETURNING id`, [co.G, co.A, co.B, date])).rows[0].id as string;
const stands = (row: string, asat: string) => asService(pool, U.ab, co.A, async (q) =>
  (await q.query('SELECT public.intercompany_mirror_stands($1, $2) AS s', [row, asat])).rows[0].s as boolean);
const block = (from: string) => { const t = readFileSync('scripts/migrations/sql/1019_intercompany_p2_mirror.sql', 'utf8'); const s = t.indexOf(from); return t.slice(s, t.indexOf('END $$;', s) + 'END $$;'.length); };
const PRIV = "DO $$\nBEGIN\n  IF pg_catalog.has_function_privilege('public', 'public.intercompany_auto_accept_queue(integer, boolean)'";
const indexDef = async (name: string) => (await pool.query('SELECT indexdef FROM pg_indexes WHERE indexname = $1', [name])).rows[0]?.indexdef as string | undefined;

describe('M-1: a person\'s elimination of a sale the sender cancelled is not left behind unseen', () => {
  it('listed as stale while it counts (any window holding the row and the elimination), gone once reversed; not listed while the sale stands', async () => {
    const s = await rejected();
    const row = (await L.rows())[0];
    const adj = await eliminate(row.id, '2026-03-01', '2026-03-31', 'Rejected by the receiver');
    await post(adj.id);
    expect(await dropped('2026-01-01', '2026-12-31')).toEqual([]);                       // the sale stands: its elimination is right
    await L.cancelSender(s.inv.id);
    const out = await dropped('2026-01-01', '2026-12-31');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ transactionId: row.id, kind: 'unresolved', code: 'stale' });
    expect(out[0]!.detail).toMatch(/cancelled/);
    expect(out[0]!.detail).toMatch(/reverse/);
    expect(await counted('2026-01-01', '2026-12-31')).toHaveLength(2);                   // it still counts: that is why it is listed
    expect(await dropped('2026-04-01', '2026-12-31')).toEqual([]);                       // a window without the row's date or the elimination's period
    await asService(pool, U.ab, co.A, () => svc.reverseEliminationAdjustment(adj.id, co.G));
    expect(await dropped('2026-01-01', '2026-12-31')).toEqual([]);
    expect(await counted('2026-01-01', '2026-12-31')).toEqual([]);
  });

  it('another group the caller belongs to lists nothing of this group\'s rows', async () => {
    const s = await rejected();
    const row = (await L.rows())[0];
    await post((await eliminate(row.id, '2026-03-01', '2026-03-31', 'Rejected by the receiver')).id);
    await L.cancelSender(s.inv.id);
    const g2 = crypto.randomUUID();
    await pool.query("INSERT INTO company_groups(id, name) VALUES ($1, 'IC round 24 other group')", [g2]);
    await pool.query('INSERT INTO company_group_members(group_id, company_id) VALUES ($1, $2)', [g2, co.A]);   // (U.ab is a member of this group too)
    try {
      const list = (g: string) => asService(pool, U.ab, co.A, async (q) => (await q.query('SELECT transaction_id, reason_code FROM public.intercompany_mirror_unresolved($1, $2, $3)', [g, '2026-01-01', '2026-12-31'])).rows);
      expect(await list(co.G)).toEqual([{ transaction_id: row.id, reason_code: 'stale' }]);
      expect(await list(g2)).toEqual([]);
    } finally {
      await pool.query('DELETE FROM company_group_members WHERE group_id = $1', [g2]);
      await pool.query('DELETE FROM company_groups WHERE id = $1', [g2]);
    }
  });

  it('a DRAFT elimination of a cancelled sale is not stale: it counts nothing', async () => {
    const s = await rejected('2026-03-05');
    const row = (await L.rows())[0];
    await eliminate(row.id, '2026-03-01', '2026-03-31');
    await L.cancelSender(s.inv.id);
    expect((await dropped('2026-01-01', '2026-12-31')).map((d) => d.code)).not.toContain('stale');
  });
});

describe('M-2: a person\'s elimination of a mirrored row and a manual row for the same sale', () => {
  it('(a) the manual row\'s duplicate facts say the mirrored row is eliminated by a person (never "not eliminated"), and the stand predicate holds until reversed', async () => {
    await variance();
    const r = (await L.rows())[0];
    expect(await stands(r.id, '2026-12-31')).toBe(false);
    const eAdj = await eliminate(r.id);
    await post(eAdj.id);
    expect(await stands(r.id, '2026-12-31')).toBe(true);
    const x = await manualRow();
    const xAdj = await asService(pool, U.ab, co.A, () => make(x, '2026-12-30', '2026-12-30', null));
    const err = await post(xAdj.id).then(() => null, (e: Error & { facts?: { mirrors: Array<{ stands: boolean; byPerson?: boolean }> } }) => e);
    expect(err).toMatchObject({ name: 'EliminationPossibleDuplicateError' });
    expect(err!.message).toMatch(/eliminated by a person's adjustment/);
    expect(err!.message).toMatch(/twice/);
    expect(err!.message).not.toMatch(/NOT eliminated/);
    expect(err!.facts!.mirrors[0]).toMatchObject({ stands: true, byPerson: true });
    const listed = (await asService(pool, U.ab, co.A, () => svc.getEliminationAdjustments(co.G, '2026-12-01', '2026-12-31'))).find((a) => a.id === xAdj.id);
    expect(listed).toMatchObject({ mirrorStands: true });
    await asService(pool, U.ab, co.A, () => svc.reverseEliminationAdjustment(eAdj.id, co.G));
    expect(await stands(r.id, '2026-12-31')).toBe(false);
    await expect(post(xAdj.id)).rejects.toThrow(/NOT eliminated automatically/);         // (the mirror does not eliminate it any more: the truth changes with the facts)
  });

  it('(b) a mirrored row a posted manual elimination covers is refused at creation and at post (a draft made earlier); reversing the manual one lifts it', async () => {
    await variance();
    const r = (await L.rows())[0];
    const draft = await eliminate(r.id);                                                 // (made before the manual elimination was posted)
    const x = await manualRow();
    const xAdj = await asService(pool, U.ab, co.A, () => make(x, '2026-12-30', '2026-12-30', null));
    await post(xAdj.id, true);                                                           // (the person confirms the possible duplicate)
    await expect(check(r.id, '2026-12-01', '2026-12-31')).rejects.toMatchObject({ name: 'EliminationAlreadyStandsError' });   // (the draft stands: refused first)
    await asService(pool, U.ab, co.A, () => svc.discardEliminationAdjustment(draft.id, co.G));
    await expect(check(r.id, '2026-12-01', '2026-12-31')).rejects.toMatchObject({ name: 'EliminationCoveredError', message: expect.stringContaining('manual sale of the same invoice') });
    const again = await asService(pool, U.ab, co.A, () => make(r.id, '2026-12-30', '2026-12-30', 'forced past the check'));
    await expect(post(again.id)).rejects.toMatchObject({ name: 'EliminationCoveredError' });
    expect((await L.adjustments()).filter((a) => a.id === again.id).map((a) => a.status)).toEqual(['draft']);
    await asService(pool, U.ab, co.A, () => svc.reverseEliminationAdjustment(xAdj.id, co.G));
    await post(again.id);                                                                // (nothing covers the row now)
    expect(await counted('2026-12-01', '2026-12-31')).toHaveLength(2);
  });
});

describe('M-2: only a POSTED elimination of the manual row covers a mirrored row', () => {
  it('a draft of the manual row\'s elimination does not: the mirrored row can still be eliminated', async () => {
    await variance();
    const r = (await L.rows())[0];
    const x = await manualRow();
    await asService(pool, U.ab, co.A, () => make(x, '2026-12-30', '2026-12-30', null));   // (a draft: it counts nothing)
    await expect(check(r.id, '2026-12-01', '2026-12-31')).resolves.toBeUndefined();
  });
});

describe('L-1: a window holding the row\'s date but not the person\'s whole period says so', () => {
  it('the listing and the "already stands" refusal name the period the person eliminated it for', async () => {
    await rejected('2026-03-12');
    const row = (await L.rows())[0];
    const adj = await eliminate(row.id, '2026-03-01', '2026-03-31', 'Rejected by the receiver');
    await post(adj.id);
    expect(await dropped('2026-03-01', '2026-03-31')).toEqual([]);
    const out = await dropped('2026-03-10', '2026-04-09');
    expect(out.map((d) => d.code)).toEqual(['rejected']);
    expect(out[0]!.detail).toMatch(/eliminated by a person for 2026-03-01 to 2026-03-31/);
    await expect(check(row.id, '2026-03-10', '2026-03-31')).rejects.toMatchObject({ name: 'EliminationAlreadyStandsError', message: expect.stringMatching(/by a person for 2026-03-01 to 2026-03-31/) });
  });
});

describe('L-2: a discard records who did it', () => {
  it('discarded_by and discarded_at are set, the row stays', async () => {
    await variance();
    const row = (await L.rows())[0];
    const adj = await eliminate(row.id);
    await asService(pool, U.ab, co.A, () => svc.discardEliminationAdjustment(adj.id, co.G, U.ab));
    const r = (await pool.query('SELECT status, discarded_by, discarded_at IS NOT NULL AS at FROM consolidation_adjustments WHERE id = $1', [adj.id])).rows[0];
    expect(r).toMatchObject({ status: 'discarded', discarded_by: U.ab, at: true });
  });
});

describe('L-3 / L-4: the indexes', () => {
  const UNIQUE = 'DO $$\nDECLARE\n  v_dups integer;';
  it('an older 1019\'s single-column unique index is replaced by the per-kind one; re-running changes nothing', async () => {
    await pool.query('DROP INDEX IF EXISTS uq_consolidation_adjustments_standing_source');
    await pool.query("CREATE UNIQUE INDEX uq_consolidation_adjustments_standing_source ON consolidation_adjustments (source_intercompany_id) WHERE status IN ('draft', 'posted')");
    expect(await indexDef('uq_consolidation_adjustments_standing_source')).not.toMatch(/manual_reason IS NOT NULL/);
    await pool.query(block(UNIQUE));
    const first = await indexDef('uq_consolidation_adjustments_standing_source');
    expect(first).toMatch(/manual_reason IS NOT NULL/);
    const oid = async () => (await pool.query("SELECT 'uq_consolidation_adjustments_standing_source'::regclass::oid::text AS o")).rows[0].o as string;
    const before = await oid();
    await pool.query(block(UNIQUE));
    expect(await indexDef('uq_consolidation_adjustments_standing_source')).toBe(first);
    expect(await oid()).toBe(before);                                                    // (idempotent: not dropped and rebuilt every run)
  });

  it('the plain index on source_intercompany_id exists, and is not unique', async () => {
    const def = await indexDef('idx_consolidation_adjustments_source');
    expect(def).toMatch(/source_intercompany_id/);
    expect(def).not.toMatch(/UNIQUE/);
    expect(def).toMatch(/WHERE \(source_intercompany_id IS NOT NULL\)/);
  });

  it('it is built even where the unique one is skipped for legacy duplicates', async () => {
    await pool.query('DROP INDEX IF EXISTS uq_consolidation_adjustments_standing_source');
    await pool.query('DROP INDEX IF EXISTS idx_consolidation_adjustments_source');
    try {
      const row = await manualRow();
      for (const status of ['posted', 'draft']) {
        await pool.query(`INSERT INTO consolidation_adjustments(group_id, adjustment_type, description, period_start, period_end, lines, source_intercompany_id, status)
                          VALUES ($1, 'interco_revenue', 'legacy', '2026-01-01', '2026-12-31', '[]'::jsonb, $2, $3)`, [co.G, row, status]);
      }
      await pool.query(block('CREATE INDEX IF NOT EXISTS idx_consolidation_adjustments_source'));   // (the index statement, then the unique index's block)
      expect(await indexDef('uq_consolidation_adjustments_standing_source')).toBeUndefined();
      expect(await indexDef('idx_consolidation_adjustments_source')).toMatch(/source_intercompany_id/);
    } finally {
      await pool.query('DELETE FROM consolidation_adjustments WHERE group_id = $1', [co.G]);
      await pool.query(block('CREATE INDEX IF NOT EXISTS idx_consolidation_adjustments_source'));
    }
  });
});

describe('INFO: the privilege assertion covers the predicate and the cover function', () => {
  it.each(['intercompany_row_manually_eliminated(uuid, date, date)', 'intercompany_manual_cover(uuid)'])('PUBLIC able to execute %s fails the migration\'s own check', async (fn) => {
    const guard = block(PRIV);
    await pool.query(guard);                                                             // (as migrated: passes)
    await pool.query(`GRANT EXECUTE ON FUNCTION public.${fn} TO PUBLIC`);
    try { await expect(pool.query(guard)).rejects.toThrow(/1019: a role it must not reach/); }
    finally { await pool.query(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC`); }
  });
});
