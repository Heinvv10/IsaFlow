/**
 * Budgets P4 recompute (spec §1.1, §1.2, §5, §9 `budget-drivers-recompute`): a driver saved through
 * PUT /api/accounting/budget-drivers computes its row; a grid save (P2's saveCells, through its
 * route) that edits a referenced cell updates the dependent driver cells in the SAME transaction;
 * an override cell is never touched; an unchanged cell is not rewritten (its xmin and updated_at
 * stay); a typed cell inside a driver range becomes 'override'; reset-to-driver and driver delete
 * move the sources. The save hook's refusals and warnings: budget-drivers-grid-hook. Real members
 * through withAuth.
 *
 * Expected figures are worked by hand: COGS = 38% of Sales, Sales 1 000 → 380, 2 000 → 760,
 * 3 000 → 1 140, rounded to R1 (no residue).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetDriverRouteFixture, dataOf, type DriverWorld } from './helpers/budgetDriverRouteFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetDriverRouteFixture(pool);
let w: DriverWorld;

beforeAll(async () => { w = await fx.world(); }, 120000);
afterAll(async () => {
  try { await fx.cleanup(); } finally { await pool.end(); }
}, 120000);

const cell = (glAccountId: string, month: string, amount: number | null) =>
  ({ glAccountId, cc1Id: null, cc2Id: null, buId: null, month, amount, ...(amount === null ? { clear: true } : {}) });
const dump = (r: { status: number; body: unknown }) => `${r.status} ${JSON.stringify(r.body).slice(0, 400)}`;

/** COGS = 38% of Sales (1 000 in months 0-2), and the PUT's answer. */
async function cogsOfSales() {
  const { v, put } = await fx.cogsOfSales(w);
  return { v, put: dataOf<{ recomputed: number; warnings: Array<{ code: string }>; updatedAt: string; driver: { id: string } }>(put) };
}

describe('budget drivers: recompute', () => {
  it('a saved driver computes its whole range as driver cells, warns once for months its reference lacks, and answers the token', async () => {
    const { v, put } = await cogsOfSales();
    const cogs = await fx.row(v, w.cogs);
    expect([...cogs.keys()]).toEqual(w.months);
    expect(w.months.map((m) => `${cogs.get(m)!.amount}:${cogs.get(m)!.source}`)).toEqual([
      '380.00:driver', '380.00:driver', '380.00:driver', ...Array(9).fill('0.00:driver'),
    ]);
    expect(put.recomputed).toBe(12);
    expect(put.warnings.map((x) => x.code)).toEqual(['REF_MISSING']);
    expect(put.updatedAt).toBe(await fx.token(v));
    const audits = await fx.audits(v);
    expect(audits.at(-1)!.changes.metadata).toMatchObject({ driverAction: 'driver_saved', kind: 'pct_of_line', recomputed: '12', replaced: 'false' });
  });

  it('a grid save editing the referenced cell updates the dependent cell in the same transaction, and rewrites nothing else', async () => {
    const { v } = await cogsOfSales();
    const [m0, m1] = w.months;
    const before = await fx.row(v, w.cogs);
    const salesBefore = await fx.row(v, w.sales);
    const r = await fx.call.save(w.u, v, [cell(w.sales, m1!, 2000)]);
    expect(r.status, dump(r)).toBe(200);
    expect(dataOf<{ saved: number; recomputed: number }>(r)).toMatchObject({ saved: 1, recomputed: 1 });
    const after = await fx.row(v, w.cogs);
    const salesAfter = await fx.row(v, w.sales);
    expect(after.get(m1!)).toMatchObject({ amount: '760.00', source: 'driver' });
    // One transaction wrote the edited Sales cell and its COGS dependant.
    expect(after.get(m1!)!.xmin).toBe(salesAfter.get(m1!)!.xmin);
    // Every other COGS cell, and the Sales cells the save did not name, are untouched.
    for (const m of w.months.filter((x) => x !== m1)) {
      expect(after.get(m), m).toEqual(before.get(m));
    }
    expect(salesAfter.get(m0!)).toEqual(salesBefore.get(m0!));
    const audit = (await fx.audits(v)).at(-1)!;
    expect(audit.changes.metadata).toMatchObject({ upserts: '1', recomputed: '1', overrides: '0' });
  });

  it('a typed cell inside the driver range becomes an override, which a later recompute never touches; reset brings the driver back', async () => {
    const { v } = await cogsOfSales();
    const [m0] = w.months;
    const typed = await fx.call.save(w.u, v, [cell(w.cogs, m0!, 500)]);
    expect(typed.status, dump(typed)).toBe(200);
    expect((await fx.row(v, w.cogs)).get(m0!)).toMatchObject({ amount: '500.00', source: 'override' });
    expect((await fx.audits(v)).at(-1)!.changes.metadata).toMatchObject({ overrides: '1', recomputed: '0' });

    const pinned = (await fx.row(v, w.cogs)).get(m0!)!;
    const edit = await fx.call.save(w.u, v, [cell(w.sales, m0!, 3000)]);
    expect(edit.status, dump(edit)).toBe(200);
    expect(dataOf<{ recomputed: number }>(edit).recomputed).toBe(0);
    expect((await fx.row(v, w.cogs)).get(m0!)).toEqual(pinned);

    const reset = await fx.call.override(w.u, { versionId: v, glAccountId: w.cogs, month: m0 });
    expect(reset.status, dump(reset)).toBe(200);
    expect(dataOf<{ reset: number; recomputed: number }>(reset)).toMatchObject({ reset: 1, recomputed: 1 });
    expect((await fx.row(v, w.cogs)).get(m0!)).toMatchObject({ amount: '1140.00', source: 'driver' });
  });

  it('deleting the driver sets its driver and override cells back to manual, values kept, and moves no amount', async () => {
    const { v, put } = await cogsOfSales();
    const [m0] = w.months;
    expect((await fx.call.save(w.u, v, [cell(w.cogs, m0!, 500)])).status).toBe(200);
    const values = [...(await fx.row(v, w.cogs)).values()].map((c) => c.amount);
    const r = await fx.call.drivers(w.u, 'DELETE', undefined, { versionId: v, id: put.driver.id });
    expect(r.status, dump(r)).toBe(200);
    // 11 driver cells re-sourced by the engine; the override released by the delete itself.
    expect(dataOf(r)).toMatchObject({ deleted: true, id: put.driver.id, recomputed: 11 });
    const after = [...(await fx.row(v, w.cogs)).values()];
    expect(after.map((c) => c.amount)).toEqual(values);
    expect(new Set(after.map((c) => c.source))).toEqual(new Set(['manual']));
    expect((await pool.query('SELECT count(*)::int AS n FROM budget_driver_lines WHERE version_id = $1', [v])).rows[0].n).toBe(0);
    expect((await fx.audits(v)).at(-1)!.changes.metadata).toMatchObject({ driverAction: 'driver_deleted', recomputed: '11', releasedOverrides: '1' });
  });

  it('narrowing a driver range sets its driver cells outside it back to manual; an override outside it stays', async () => {
    const { v } = await cogsOfSales();
    expect((await fx.call.save(w.u, v, [cell(w.cogs, w.months[5]!, 42)])).status).toBe(200);
    const r = await fx.call.drivers(w.u, 'PUT', {
      versionId: v, glAccountId: w.cogs, kind: 'pct_of_line', pct: 38, fromMonth: w.months[0], toMonth: w.months[1],
      ref: { glAccountId: w.sales },
    });
    expect(r.status, dump(r)).toBe(200);
    const cogs = await fx.row(v, w.cogs);
    expect(w.months.map((m) => cogs.get(m)!.source)).toEqual(['driver', 'driver', 'manual', 'manual', 'manual', 'override', ...Array(6).fill('manual')]);
    expect(cogs.get(w.months[5]!)!.amount).toBe('42.00');
    expect((await fx.audits(v)).at(-1)!.changes.metadata).toMatchObject({ replaced: 'true', recomputed: '9' });
  });

  it('the grid read model carries each cell source and the version drivers', async () => {
    const { v, put } = await cogsOfSales();
    const r = await fx.call.grid(w.u, v);
    expect(r.status, dump(r)).toBe(200);
    const m = dataOf<{ cells: Array<{ glAccountId: string; month: string; source: string }>; drivers: Array<{ id: string; kind: string; pct: number }> }>(r);
    expect(new Set(m.cells.filter((c) => c.glAccountId === w.cogs).map((c) => c.source))).toEqual(new Set(['driver']));
    expect(new Set(m.cells.filter((c) => c.glAccountId === w.sales).map((c) => c.source))).toEqual(new Set(['manual']));
    expect(m.drivers).toEqual([expect.objectContaining({ id: put.driver.id, kind: 'pct_of_line', pct: 38 })]);
  });
});
