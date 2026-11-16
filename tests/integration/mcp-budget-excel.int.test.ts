/**
 * The MCP budget Excel tools (PR 2) against a real database, through the real registry as app_user:
 * get_budget_template → import_budget_workbook. A dry run writes nothing (cells, token, audit rows, snapshots);
 * the live import applies only its dry run's plan, once (an idempotent replay writes nothing twice) and
 * restore_budget_version undoes it; an .xlsx downloaded before a colleague's save keeps that save (3-way) and
 * lists the conflict; a moved version is refused for the JSON grid and for a stale version_token; decision 4 and
 * the per-row reasons refuse rows, decision 14 cannot be expressed; a budget holder imports only their slices;
 * a locked version and a viewer are refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import ExcelJS from 'exceljs';
import saveRoute from '../../pages/api/accounting/budget-grid/save';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridSaveFixture, type GridWorld } from './helpers/budgetGridSaveFixture';
import type { SetupUser } from './helpers/onboardingSetupFixture';
import { body, mcp, mcpBatch, mcpReads, text } from './helpers/mcpBudgetFixture';
import { editXlsx, gridRows, monthsOf, setMonth } from './helpers/mcpBudgetExcelFixture';

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

describe('dry run, live, replay, restore (JSON grid)', () => {
  it('the dry run writes nothing; the live call applies its plan once; a replay writes nothing twice; restore undoes the import', async () => {
    const v = await fx.version(w);
    await fx.amount(w, v, w.rent, w.months[0]!, 10);
    const { rows, token } = await gridRows(pool, w.u, v);
    setMonth(rows, 'BR-5000', w.months[1]!, '20.00');
    setMonth(rows, 'BR-5000', w.months[0]!, null);
    setMonth(rows, 'GS-4000', w.months[4]!, '300.00');
    const before = await state(v);
    const dry = body(await imp(w.u, { version_id: v, rows, version_token: token, dry_run: true }));
    expect(dry).toMatchObject({ ready: true, import_counts: { added: 2, cleared: 1, changed: 0 } });
    expect(await state(v)).toEqual(before);

    const k = key();
    const live = await mcp(pool, w.u, 'import_budget_workbook', { version_id: v, rows, version_token: token, plan_hash: dry.plan_hash, idempotency_key: k });
    expect(body(live)).toMatchObject({ saved: 2, deleted: 1, snapshot_id: expect.any(String) });
    const after = await state(v);
    expect([...after.cells].sort()).toEqual([`${w.sales}||||${w.months[4]}=300.00`, `${w.rent}||||${w.months[1]}=20.00`].sort());
    expect([after.audits, after.snaps]).toEqual([before.audits + 1, 1]);
    expect((await reads.snapshots(v))[0]).toMatchObject({ tool: 'import_budget_workbook', created_by: w.u.userId });

    const replay = await mcp(pool, w.u, 'import_budget_workbook', { version_id: v, rows, version_token: token, plan_hash: dry.plan_hash, idempotency_key: k });
    expect(text(replay)).toBe(text(live));
    expect(await state(v)).toEqual(after);

    const rdry = body(await mcp(pool, w.u, 'restore_budget_version', { version_id: v, dry_run: true, idempotency_key: key() }));
    expect(body(await mcp(pool, w.u, 'restore_budget_version', { version_id: v, plan_hash: rdry.plan_hash, idempotency_key: key() }))).toMatchObject({ restored: 3 });
    expect(await fx.cells(v)).toEqual(before.cells);
  });
});

describe('a moved version', () => {
  it('an .xlsx downloaded before a colleague\'s save keeps that save, lists the conflict and applies the file\'s value there', async () => {
    const v = await fx.version(w);
    await fx.amount(w, v, w.rent, w.months[0]!, 10);
    const t = body(await mcp(pool, w.u, 'get_budget_template', { version_id: v, format: 'xlsx' }));
    const colleague = await fx.call(w.u, { versionId: v, expectedUpdatedAt: await fx.token(v), cells: [
      { glAccountId: w.rent, month: w.months[0]!, amount: 11 }, { glAccountId: w.rent, month: w.months[1]!, amount: 50 },
    ] });
    expect(colleague.status).toBe(200);
    const file = await editXlsx(String(t.file_base64), (ws) => {
      ws.set('BR-5000', w.months[0]!, 12);
      ws.set('GS-4000', w.months[4]!, 300);
    });
    const dry = body(await imp(w.u, { version_id: v, file_base64: file, dry_run: true }));
    expect(dry).toMatchObject({ format: 'xlsx', conflict_count: 1, conflicts: [{ account: 'BR-5000', month: w.months[0], downloaded: '10.00', current: '11.00', after: '12.00' }] });
    expect(JSON.stringify(dry.warnings)).toMatch(/saved after you downloaded this file/);
    // version_token: the token the file was cut with is refused (the version moved), before anything is written.
    const stale = await imp(w.u, { version_id: v, file_base64: file, plan_hash: dry.plan_hash, version_token: t.version_token });
    expect(text(stale)).toMatch(/changed since your dry run/);
    body(await imp(w.u, { version_id: v, file_base64: file, plan_hash: dry.plan_hash }));
    expect((await fx.cells(v)).sort()).toEqual([`${w.rent}||||${w.months[0]}=12.00`, `${w.rent}||||${w.months[1]}=50.00`, `${w.sales}||||${w.months[4]}=300.00`].sort());
  });

  it('the JSON grid of a version saved since it was read is refused (it carries no _base), and nothing is written', async () => {
    const v = await fx.version(w);
    const { rows, token } = await gridRows(pool, w.u, v);
    await fx.amount(w, v, w.rent, w.months[0]!, 10);
    await pool.query('UPDATE budget_versions SET updated_at = clock_timestamp() WHERE id = $1', [v]);
    setMonth(rows, 'GS-4000', w.months[4]!, '300.00');
    const before = await state(v);
    expect(text(await imp(w.u, { version_id: v, rows, version_token: token, dry_run: true }))).toMatch(/saved after the grid you are importing was read/);
    expect(await state(v)).toEqual(before);
  });
});

describe('the plan_hash binds content, not only the token', () => {
  it('in ONE transaction (the token cannot move) a cell the import changes, changed after its dry run, makes the live call "plan changed"', async () => {
    const v = await fx.version(w);
    const set = (amount: string) => ['set_budget_amounts', { version_id: v, cells: [{ account: 'BR-5000', month: w.months[0]!, amount }], idempotency_key: key() }] as [string, Record<string, unknown>];
    const grid = (r: Parameters<Parameters<typeof mcpBatch>[2][number]>[0]) => {
      const t = JSON.parse(r[1]!.content[0]!.text) as { rows: Array<{ account: string; months: Record<string, string | null> }>; version_token: string };
      setMonth(t.rows, 'BR-5000', w.months[0]!, '77.00');
      return { rows: t.rows, version_token: t.version_token };
    };
    const out = await mcpBatch(pool, w.u, [
      () => set('1.00'), // the token is now this transaction's now(), and stays it
      () => ['get_budget_template', { version_id: v, limit: 80 }],
      (r) => ['import_budget_workbook', { version_id: v, ...grid(r), dry_run: true, idempotency_key: key() }],
      () => set('2.00'),
      (r) => ['import_budget_workbook', { version_id: v, ...grid(r), plan_hash: JSON.parse(r[2]!.content[0]!.text).plan_hash, idempotency_key: key() }],
    ]);
    expect(out.slice(0, 4).map((r) => r.isError ?? false)).toEqual([false, false, false, false]);
    expect(text(out[4]!)).toMatch(/plan changed since your dry run/);
    expect(await fx.cells(v)).toEqual([`${w.rent}||||${w.months[0]}=2.00`]);
  });
});

describe('rows refused per row; decision 4; decision 14', () => {
  it('unknown, balance-sheet, header and inactive accounts, and an account budgeted at another level (decision 4): refused per row, nothing written', async () => {
    const v = await fx.version(w);
    await fx.amount(w, v, w.rent, w.months[0]!, 10);
    const { token } = await gridRows(pool, w.u, v);
    const row = (account: string, extra: Record<string, unknown> = {}) => ({ account, months: monthsOf(w.months, { [w.months[2]!]: '5.00' }), ...extra });
    const company = [row('NOPE-1'), row('GS-1000'), row('GS-6000'), row('GS-6900'), row('GS-6100')];
    const before = await state(v);
    const dry = body(await imp(w.u, { version_id: v, rows: company, version_token: token, dry_run: true }));
    const refused = (dry.cells as Array<{ i: number; status: string; reason: string }>).filter((c) => c.status === 'refused');
    expect(refused.map((c) => [c.i, c.reason])).toEqual([
      [1, 'NOPE-1 is not an account of this company'],
      [2, expect.stringMatching(/^GS-1000 Bank is not a revenue or expense account/)],
      [3, expect.stringMatching(/^GS-6000 Admin costs is a header account with no budget in this version/)],
      [4, expect.stringMatching(/^GS-6900 Old cost is inactive with no budget in this version/)],
    ]);
    const cc1 = [row('BR-5000', { dimension: 'GS-C1' })];
    const grain = body(await imp(w.u, { version_id: v, rows: cc1, grain: 'cc1', version_token: token, dry_run: true }));
    expect(JSON.stringify(grain.cells)).toMatch(/BR-5000 Rent is budgeted by company in this version, not by CC1/);
    expect(text(await imp(w.u, { version_id: v, rows: cc1, grain: 'cc1', version_token: token, plan_hash: 'a'.repeat(64) }))).toMatch(/^1 cell is refused, so nothing was written/);
    // Decision 14: a template row names one dimension; a second one is not a field of it.
    expect(text(await imp(w.u, { version_id: v, rows: [row('GS-6100', { dimension: 'GS-C1', cc2: 'GS-C2' })], grain: 'cc1', version_token: token, dry_run: true })))
      .toMatch(/"cc2" is not a field of a template row/);
    expect(await state(v)).toEqual(before);
  });
});

describe('who may import what', () => {
  it('a budget holder: their template is their slice; an import inside it saves, one outside it is refused whole', async () => {
    const v = await fx.version(w);
    const holder = await fx.member(w.u.homeCompanyId, 'manager');
    await pool.query(`INSERT INTO budget_holders (company_id, version_id, user_id, cc1_id, created_by) VALUES ($1, $2, $3, $4, $5)`, [w.u.homeCompanyId, v, holder.userId, w.cc1, w.u.userId]);
    await pool.query(`INSERT INTO budget_slice_reviews (company_id, version_id, cc1_id, created_by) VALUES ($1, $2, $3, $4)`, [w.u.homeCompanyId, v, w.cc1, w.u.userId]);
    const { rows, token } = await gridRows(pool, holder, v, 'cc1', [w.cc1], 'manager');
    expect(new Set(rows.map((r) => r.dimension))).toEqual(new Set(['GS-C1']));
    setMonth(rows, 'BR-5000', w.months[0]!, '9.00');
    const dry = body(await imp(holder, { version_id: v, rows, grain: 'cc1', version_token: token, dry_run: true }, 'manager'));
    body(await imp(holder, { version_id: v, rows, grain: 'cc1', version_token: token, plan_hash: dry.plan_hash }, 'manager'));
    expect(await fx.cells(v)).toEqual([`${w.rent}|${w.cc1}|||${w.months[0]}=9.00`]);
    const outside = [{ account: 'GS-6100', months: monthsOf(w.months, { [w.months[0]!]: '1.00' }) }];
    const r = await imp(holder, { version_id: v, rows: outside, version_token: await fx.token(v), dry_run: true }, 'manager');
    expect(text(r)).toMatch(/^This file changes cells outside your budget slices/);
    expect(await fx.cells(v)).toEqual([`${w.rent}|${w.cc1}|||${w.months[0]}=9.00`]);
  });

  it('a locked version is refused by the grid save (dry run and live); a viewer is fenced before the handler', async () => {
    const v = await fx.version(w, { status: 'locked' });
    const { rows, token } = await gridRows(pool, w.u, v);
    setMonth(rows, 'BR-5000', w.months[0]!, '9.00');
    expect(text(await imp(w.u, { version_id: v, rows, version_token: token, dry_run: true }))).toMatch(/would be refused: .*locked/i);
    expect(text(await imp(w.u, { version_id: v, rows, version_token: token }))).toMatch(/locked/i);
    const open = await fx.version(w);
    const g = await gridRows(pool, w.u, open);
    setMonth(g.rows, 'BR-5000', w.months[0]!, '9.00');
    const fenced = await imp(viewer, { version_id: open, rows: g.rows, version_token: g.token }, 'viewer');
    expect([fenced.isError, (await reads.toolCalls(w.u.homeCompanyId, 'import_budget_workbook', viewer.userId)).map((c) => c.status)]).toEqual([true, ['rejected']]);
    expect(await fx.cells(open)).toEqual([]);
    expect(ExcelJS).toBeTruthy();
  });
});
