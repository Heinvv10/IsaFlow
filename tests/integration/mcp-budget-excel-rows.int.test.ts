/**
 * import_budget_workbook against a real database, through the real registry as app_user: what refuses a ROW
 * (an .xlsx row added for an unknown, balance-sheet, header or inactive account; decision 4, an account budgeted
 * at another level since the JSON rows were read: each with its reason, all or nothing), what refuses the WHOLE
 * import (decision 14, at most one dimension per amount, cannot be expressed: a template row names one dimension
 * and a second is not one of its fields), and who may import what (a budget holder only their slices, a locked
 * version, a viewer fenced before the handler).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import saveRoute from '../../pages/api/accounting/budget-grid/save';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridSaveFixture, type GridWorld } from './helpers/budgetGridSaveFixture';
import type { SetupUser } from './helpers/onboardingSetupFixture';
import { body, mcp, mcpReads, text } from './helpers/mcpBudgetFixture';
import { editXlsx, gridRows, setMonth } from './helpers/mcpBudgetExcelFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetGridSaveFixture(pool, saveRoute, '/api/accounting/budget-grid/save');
const reads = mcpReads(pool);

let w: GridWorld;
let viewer: SetupUser;
beforeAll(async () => { w = await fx.world(); viewer = await fx.member(w.u.homeCompanyId, 'viewer'); }, 120000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM mcp_tool_calls WHERE company_id = $1', [w.u.homeCompanyId]);
    await pool.query('DELETE FROM budget_holders WHERE company_id = $1', [w.u.homeCompanyId]);
    await pool.query('DELETE FROM budget_slice_reviews WHERE company_id = $1', [w.u.homeCompanyId]);
    await fx.cleanup();
  } finally {
    await pool.end();
  }
}, 120000);

const key = () => `k-${crypto.randomUUID()}`;
const state = async (v: string) => ({ cells: await fx.cells(v), token: await fx.token(v), audits: (await fx.audits(v)).length, snaps: (await reads.snapshots(v)).length });
const imp = (u: SetupUser, args: Record<string, unknown>, role?: string) => mcp(pool, u, 'import_budget_workbook', { idempotency_key: key(), ...args }, role ? { role } : {});
const refusedOf = (dry: Record<string, unknown>) => (dry.cells as Array<{ i: number; status: string; reason: string }>).filter((c) => c.status === 'refused').map((c) => [c.i, c.reason]);

describe('rows refused per row; decision 4; decision 14', () => {
  it('.xlsx rows added for unknown, balance-sheet, header and inactive accounts: refused per row with the reason, nothing written', async () => {
    const v = await fx.version(w);
    await fx.amount(w, v, w.rent, w.months[0]!, 10);
    const t = body(await mcp(pool, w.u, 'get_budget_template', { version_id: v, format: 'xlsx' }));
    const file = await editXlsx(String(t.file_base64), (ws) => {
      ws.set('BR-5000', w.months[2]!, 5);
      for (const code of ['NOPE-1', 'GS-1000', 'GS-6000', 'GS-6900']) ws.sheet.addRow(['Operating expenses', code, code, 5]);
    });
    const before = await state(v);
    const dry = body(await imp(w.u, { version_id: v, file_base64: file, dry_run: true }));
    const first = Number(refusedOf(dry)[0]?.[0]);
    expect(refusedOf(dry)).toEqual([
      [first, 'NOPE-1 is not an account of this company'],
      [first + 1, expect.stringMatching(/^GS-1000 Bank is not a revenue or expense account/)],
      [first + 2, expect.stringMatching(/^GS-6000 Admin costs is a header account with no budget in this version/)],
      [first + 3, expect.stringMatching(/^GS-6900 Old cost is inactive with no budget in this version/)],
    ]);
    expect(text(await imp(w.u, { version_id: v, file_base64: file, plan_hash: 'a'.repeat(64) }))).toMatch(/^4 cells are refused, so nothing was written/);
    expect(await state(v)).toEqual(before);
  });

  it('decision 4: JSON rows read at the CC1 level, the account budgeted at company level since: refused per row; nothing written', async () => {
    const v = await fx.version(w);
    const { rows } = await gridRows(pool, w.u, v, 'cc1', [w.cc1]);
    setMonth(rows, 'BR-5000', w.months[2]!, '5.00', 'GS-C1');
    expect((await fx.call(w.u, { versionId: v, expectedUpdatedAt: await fx.token(v), cells: [{ glAccountId: w.rent, month: w.months[0]!, amount: 10 }] })).status).toBe(200);
    const before = await state(v);
    const dry = body(await imp(w.u, { version_id: v, rows, grain: 'cc1', dry_run: true }));
    expect(JSON.stringify(refusedOf(dry))).toMatch(/BR-5000 Rent is budgeted by company in this version, not by CC1/);
    expect(text(await imp(w.u, { version_id: v, rows, grain: 'cc1', plan_hash: 'a'.repeat(64) }))).toMatch(/cells? (is|are) refused, so nothing was written/);
    expect(await state(v)).toEqual(before);
  });

  it('decision 14 (one dimension per amount) cannot be expressed: a second dimension is not a field of a template row', async () => {
    const v = await fx.version(w);
    const { rows } = await gridRows(pool, w.u, v, 'cc1', [w.cc1]);
    const r = await imp(w.u, { version_id: v, rows: [{ ...rows[0]!, cc2: 'GS-C2' }], grain: 'cc1', dry_run: true });
    expect(text(r)).toMatch(/row 1: "cc2" is not a field of a template row/);
    expect(await fx.cells(v)).toEqual([]);
  });
});

describe('who may import what', () => {
  it('a budget holder: their template is their slice; an import inside it saves, a row outside it refuses the whole import', async () => {
    const v = await fx.version(w);
    const holder = await fx.member(w.u.homeCompanyId, 'manager');
    await pool.query(`INSERT INTO budget_holders (company_id, version_id, user_id, cc1_id, created_by) VALUES ($1, $2, $3, $4, $5)`, [w.u.homeCompanyId, v, holder.userId, w.cc1, w.u.userId]);
    await pool.query(`INSERT INTO budget_slice_reviews (company_id, version_id, cc1_id, created_by) VALUES ($1, $2, $3, $4)`, [w.u.homeCompanyId, v, w.cc1, w.u.userId]);
    const { rows } = await gridRows(pool, holder, v, 'cc1', [w.cc1], 'manager');
    expect(new Set(rows.map((r) => r.dimension))).toEqual(new Set(['GS-C1']));
    setMonth(rows, 'BR-5000', w.months[0]!, '9.00', 'GS-C1');
    const dry = body(await imp(holder, { version_id: v, rows, grain: 'cc1', dry_run: true }, 'manager'));
    body(await imp(holder, { version_id: v, rows, grain: 'cc1', plan_hash: dry.plan_hash }, 'manager'));
    expect(await fx.cells(v)).toEqual([`${w.rent}|${w.cc1}|||${w.months[0]}=9.00`]);
    const company = await gridRows(pool, holder, v, 'company', undefined, 'manager');
    setMonth(company.rows, 'GS-6100', w.months[0]!, '1.00');
    const r = await imp(holder, { version_id: v, rows: company.rows, dry_run: true }, 'manager');
    expect(text(r)).toMatch(/^This file changes cells outside your budget slices/);
    expect(await fx.cells(v)).toEqual([`${w.rent}|${w.cc1}|||${w.months[0]}=9.00`]);
  });

  it('a locked version is refused by the grid save (dry run and live); a viewer is fenced before the handler', async () => {
    const v = await fx.version(w, { status: 'locked' });
    const { rows } = await gridRows(pool, w.u, v);
    setMonth(rows, 'BR-5000', w.months[0]!, '9.00');
    expect(text(await imp(w.u, { version_id: v, rows, dry_run: true }))).toMatch(/would be refused: .*locked/i);
    expect(text(await imp(w.u, { version_id: v, rows }))).toMatch(/locked/i);
    const open = await fx.version(w);
    const g = await gridRows(pool, w.u, open);
    setMonth(g.rows, 'BR-5000', w.months[0]!, '9.00');
    const fenced = await imp(viewer, { version_id: open, rows: g.rows }, 'viewer');
    expect([fenced.isError, (await reads.toolCalls(w.u.homeCompanyId, 'import_budget_workbook', viewer.userId)).map((c) => c.status)]).toEqual([true, ['rejected']]);
    expect(await fx.cells(open)).toEqual([]);
  });
});
