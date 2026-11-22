/**
 * Intercompany P2: a person's elimination of a MIRRORED row is not supported yet (docs/plans/2026-11-22-intercompany-manual-elimination-of-mirrored-rows.md;
 * review rounds 22-24 kept finding neighbours of that one feature, so it was descoped). Against the real route and service on the disposable cluster:
 *  - the create-elimination route answers 400 to a body naming an intercompany row, a listed (unresolved) mirrored row included, and writes nothing;
 *  - createEliminationAdjustment refuses a mirrored source row on its own (a caller that does not come through the route), writing nothing;
 *  - what stays: a plain manual elimination (no row), and the generator's own row-carrying draft for a manual (P1) row, are stored as before;
 *  - the listing is unchanged by a refused attempt: the row is still listed, informational, with its reason code.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { callRoute } from '../r035-approval.helpers';
import consolidatedReports from '../../../pages/api/accounting/consolidated-reports';
import { createEliminationAdjustment } from '../../../src/modules/accounting/services/reports/consolidatedReportingService';
import { EliminationMirroredRowUnsupportedError, MIRRORED_ROW_MANUAL_ELIMINATION_DOC } from '../../../src/modules/accounting/services/reports/eliminationErrors';
import { getMirroredEliminations, type DroppedMirroredElimination } from '../../../src/modules/accounting/services/reports/mirrorEliminations';
import { asService, co, groupAccounts, tokens, U } from './mirror.helpers';
import { makeLedger } from './ledger.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const L = makeLedger(pool);
beforeAll(async () => {
  await L.setup();
  await L.monthly(co.A, 2026); await L.monthly(co.B, 2026); await L.monthly(co.B, 2027);
}, 90000);
afterAll(L.cleanup, 60000);
beforeEach(L.reset);

/** The sender sold on 30 Dec 2026 and the receiver booked it on 2 Jan 2027: a variance (cut-off), listed as having no elimination. */
async function variance() {
  const m = await L.accepted({ date: '2026-12-30' });
  await pool.query("UPDATE supplier_invoices SET invoice_date = '2027-01-02', due_date = '2027-02-01' WHERE id = $1", [m.bill]);
  await L.approveBill(m.bill);
  return m;
}
async function dropped() {
  const out: DroppedMirroredElimination[] = [];
  await asService(pool, U.ab, co.A, () => getMirroredEliminations(co.G, '2026-12-01', '2026-12-31', out));
  return out;
}
const count = async () => Number((await pool.query('SELECT count(*) AS n FROM consolidation_adjustments WHERE group_id = $1', [co.G])).rows[0].n);
const lines = () => [{ groupAccountId: groupAccounts.rev, debit: 1000, credit: 0, description: 'Eliminate revenue' }, { groupAccountId: groupAccounts.exp, debit: 0, credit: 1000, description: 'Eliminate expense' }];
const body = (extra: Record<string, unknown> = {}) => ({ action: 'create-elimination', adjustmentType: 'interco_revenue', description: 'Manual elimination of the sale',
  periodStart: '2026-12-30', periodEnd: '2026-12-30', manualReason: 'The receiver booked it in January', lines: lines(), ...extra });
const post = (b: unknown) => callRoute(consolidatedReports, tokens[U.ab]!, co.A, 'POST', b, '/api/accounting/consolidated-reports', { group_id: co.G });

describe('the create-elimination route', () => {
  it('refuses a listed mirrored row with 400, the reason code and the design doc, and writes nothing', async () => {
    await variance();
    const row = await L.groupRow();
    expect((await dropped()).map((d) => d.code)).toEqual(['variance']);

    const res = await post(body({ sourceIntercompanyId: row.id }));
    expect(res.state.statusCode).toBe(400);
    const err = (res.state.body as { error: { message: string; details: { reason: string; doc: string } } }).error;
    expect(err.details.reason).toBe('mirrored_row_manual_elimination_unsupported');
    expect(err.details.doc).toBe(MIRRORED_ROW_MANUAL_ELIMINATION_DOC);
    expect(err.message).toMatch(/not supported yet/);
    expect(err.message).toMatch(/Correct or re-accept the receiving company's document \(or cancel the sale\) so that mirroring eliminates it/);
    expect(await count()).toBe(0);
    expect((await dropped()).map((d) => d.code)).toEqual(['variance']);   // (still listed: informational)
  });

  it('refuses any named row, a made-up id included, before reading anything else (400, nothing written)', async () => {
    const res = await post(body({ sourceIntercompanyId: crypto.randomUUID(), lines: [] }));
    expect(res.state.statusCode).toBe(400);
    expect(JSON.stringify(res.state.body)).toContain('mirrored_row_manual_elimination_unsupported');
    expect(await count()).toBe(0);
  });

  it('a plain manual elimination (no row) is still stored, as a draft carrying no row', async () => {
    const res = await post(body());
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const rows = (await pool.query('SELECT status, source_intercompany_id, manual_reason FROM consolidation_adjustments WHERE group_id = $1', [co.G])).rows;
    expect(rows).toEqual([{ status: 'draft', source_intercompany_id: null, manual_reason: 'The receiver booked it in January' }]);
  });
});

describe('createEliminationAdjustment', () => {
  const create = (row: string | null) => asService(pool, U.ab, co.A, () => createEliminationAdjustment(co.G, {
    adjustmentType: 'interco_revenue', description: 'Manual elimination', periodStart: '2026-12-30', periodEnd: '2026-12-30', lines: lines(),
    ...(row ? { sourceIntercompanyId: row } : {}),
  }));

  it('refuses a mirrored source row itself (a caller that bypasses the route) and writes nothing', async () => {
    await variance();
    const row = await L.groupRow();
    await expect(create(row.id)).rejects.toBeInstanceOf(EliminationMirroredRowUnsupportedError);
    expect(await count()).toBe(0);
  });

  it('still stores a draft that carries a MANUAL (P1) row, as the generator does', async () => {
    await variance();                                                    // (a mirrored row exists in the group too: only the named row decides)
    const manual = (await pool.query(
      `INSERT INTO intercompany_transactions (group_id, source_company_id, target_company_id, transaction_type, amount, transaction_date, description)
       VALUES ($1, $2, $3, 'sale', 50, '2026-12-05', 'plain manual row') RETURNING id`, [co.G, co.A, co.B])).rows[0].id as string;
    const adj = await create(manual);
    expect(adj.sourceIntercompanyId).toBe(manual);
    expect(await count()).toBe(1);
  });
});
