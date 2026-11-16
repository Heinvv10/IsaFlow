/**
 * The MCP budget Excel tools (PR 2) against a real database, through the real registry as app_user:
 * get_budget_template → import_budget_workbook. A dry run writes nothing (cells, token, audit rows, snapshots);
 * the live import applies only its dry run's plan, once (an idempotent replay writes nothing twice) and
 * restore_budget_version undoes it; an .xlsx downloaded before a colleague's save keeps that save (3-way) and
 * lists the conflict; so does the JSON grid, whose rows carry their signed base (review round 1, HIGH: rows read on
 * pages at different tokens, or sent with a later import's reply token, reverted a colleague's save); a stale
 * version_token refuses the live call; an .xlsx without _base is refused; inside one transaction only the
 * plan_hash can tell the dry run's plan from the live one. Rows, holders, locks: mcp-budget-excel-rows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import saveRoute from '../../pages/api/accounting/budget-grid/save';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridSaveFixture, type GridWorld } from './helpers/budgetGridSaveFixture';
import type { SetupUser } from './helpers/onboardingSetupFixture';
import { body, mcp, mcpBatch, mcpReads, text } from './helpers/mcpBudgetFixture';
import { editXlsx, gridRows, setMonth, type GridRow } from './helpers/mcpBudgetExcelFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetGridSaveFixture(pool, saveRoute, '/api/accounting/budget-grid/save');
const reads = mcpReads(pool);

let w: GridWorld;
beforeAll(async () => { w = await fx.world(); }, 120000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM mcp_tool_calls WHERE company_id = $1', [w.u.homeCompanyId]);
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
    const { rows } = await gridRows(pool, w.u, v);
    setMonth(rows, 'BR-5000', w.months[1]!, '20.00');
    setMonth(rows, 'BR-5000', w.months[0]!, null);
    setMonth(rows, 'GS-4000', w.months[4]!, '300.00');
    const before = await state(v);
    const dry = body(await imp(w.u, { version_id: v, rows, dry_run: true }));
    expect(dry).toMatchObject({ ready: true, import_counts: { added: 2, cleared: 1, changed: 0 } });
    expect(await state(v)).toEqual(before);

    const k = key();
    const live = await mcp(pool, w.u, 'import_budget_workbook', { version_id: v, rows, plan_hash: dry.plan_hash, idempotency_key: k });
    expect(body(live)).toMatchObject({ saved: 2, deleted: 1, snapshot_id: expect.any(String) });
    const after = await state(v);
    expect([...after.cells].sort()).toEqual([`${w.sales}||||${w.months[4]}=300.00`, `${w.rent}||||${w.months[1]}=20.00`].sort());
    expect([after.audits, after.snaps]).toEqual([before.audits + 1, 1]);
    expect((await reads.snapshots(v))[0]).toMatchObject({ tool: 'import_budget_workbook', created_by: w.u.userId });

    const replay = await mcp(pool, w.u, 'import_budget_workbook', { version_id: v, rows, plan_hash: dry.plan_hash, idempotency_key: k });
    expect(text(replay)).toBe(text(live));
    expect(await state(v)).toEqual(after);

    const rdry = body(await mcp(pool, w.u, 'restore_budget_version', { version_id: v, dry_run: true, idempotency_key: key() }));
    expect(body(await mcp(pool, w.u, 'restore_budget_version', { version_id: v, plan_hash: rdry.plan_hash, idempotency_key: key() }))).toMatchObject({ restored: 3 });
    expect(await fx.cells(v)).toEqual(before.cells);
  });
});

describe('a version saved since the rows were read keeps that save', () => {
  it('an .xlsx downloaded before a colleague\'s save keeps that save, lists the conflict and applies the file\'s value there; a stale version_token refuses the live call', async () => {
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
    expect(dry).toMatchObject({ format: 'xlsx', conflict_count: 1, conflicts: [{ account: 'BR-5000', dimension: null, month: w.months[0], downloaded: '10.00', current: '11.00', after: '12.00' }] });
    expect(JSON.stringify(dry.warnings)).toMatch(/saved after you downloaded this file/);
    const stale = await imp(w.u, { version_id: v, file_base64: file, plan_hash: dry.plan_hash, version_token: t.version_token });
    expect(text(stale)).toMatch(/changed since your dry run/);
    body(await imp(w.u, { version_id: v, file_base64: file, plan_hash: dry.plan_hash }));
    expect((await fx.cells(v)).sort()).toEqual([`${w.rent}||||${w.months[0]}=12.00`, `${w.rent}||||${w.months[1]}=50.00`, `${w.sales}||||${w.months[4]}=300.00`].sort());
  });

  it('breaker B-int: page 1 read at T0, a colleague saves a page-1 row, page 2 read at T1; all rows imported with T1 keep the colleague\'s save', async () => {
    const v = await fx.version(w);
    await fx.amount(w, v, w.rent, w.months[0]!, 10);
    const p1 = body(await mcp(pool, w.u, 'get_budget_template', { version_id: v, limit: 2, offset: 0 }));
    const rows1 = p1.rows as GridRow[];
    expect(rows1.map((r) => r.account)).toContain('BR-5000');
    expect((await fx.call(w.u, { versionId: v, expectedUpdatedAt: await fx.token(v), cells: [{ glAccountId: w.rent, month: w.months[0]!, amount: 999 }] })).status).toBe(200);
    const p2 = body(await mcp(pool, w.u, 'get_budget_template', { version_id: v, limit: 50, offset: 2 }));
    expect(p2.version_token).not.toBe(p1.version_token);
    const rows = [...rows1, ...(p2.rows as GridRow[])];
    setMonth(rows, 'GS-4000', w.months[4]!, '300.00');
    const dry = body(await imp(w.u, { version_id: v, rows, version_token: p2.version_token, dry_run: true }));
    expect([dry.counts, dry.conflict_count]).toEqual([expect.objectContaining({ added: 1, changed: 0, removed: 0 }), 0]);
    expect(JSON.stringify(dry.warnings)).toMatch(/1 cell in them changed since these rows were read/);
    body(await imp(w.u, { version_id: v, rows, version_token: p2.version_token, plan_hash: dry.plan_hash }));
    expect((await fx.cells(v)).sort()).toEqual([`${w.rent}||||${w.months[0]}=999.00`, `${w.sales}||||${w.months[4]}=300.00`].sort());
  });

  it('rows read before a colleague\'s save, sent with the version_token a later live import answered, keep that save; a cell edited on both sides is a conflict', async () => {
    const v = await fx.version(w);
    await fx.amount(w, v, w.rent, w.months[0]!, 10);
    const { rows } = await gridRows(pool, w.u, v);
    expect((await fx.call(w.u, { versionId: v, expectedUpdatedAt: await fx.token(v), cells: [{ glAccountId: w.rent, month: w.months[0]!, amount: 999 }] })).status).toBe(200);
    const sales = rows.filter((r) => r.account === 'GS-4000').map((r) => ({ ...r, months: { ...r.months, [w.months[4]!]: '300.00' } }));
    const first = body(await imp(w.u, { version_id: v, rows: sales }));
    setMonth(rows, 'GS-4000', w.months[4]!, '300.00');
    setMonth(rows, 'GS-4000', w.months[5]!, '50.00');
    setMonth(rows, 'BR-5000', w.months[1]!, '20.00');
    const dry = body(await imp(w.u, { version_id: v, rows, version_token: first.version_token, dry_run: true }));
    expect(dry.conflict_count).toBe(0);
    body(await imp(w.u, { version_id: v, rows, version_token: first.version_token, plan_hash: dry.plan_hash }));
    expect((await fx.cells(v)).sort()).toEqual([
      `${w.rent}||||${w.months[0]}=999.00`, `${w.rent}||||${w.months[1]}=20.00`, `${w.sales}||||${w.months[4]}=300.00`, `${w.sales}||||${w.months[5]}=50.00`,
    ].sort());
    setMonth(rows, 'BR-5000', w.months[0]!, '12.00'); // edited where the colleague saved too
    const c = body(await imp(w.u, { version_id: v, rows, dry_run: true }));
    expect(c.conflicts).toEqual([{ account: 'BR-5000', dimension: null, month: w.months[0], downloaded: '10.00', current: '999.00', after: '12.00' }]);
  });

  it('an .xlsx without its _base sheet is refused, even one of this version\'s templates; nothing is written', async () => {
    const v = await fx.version(w);
    const t = body(await mcp(pool, w.u, 'get_budget_template', { version_id: v, format: 'xlsx' }));
    const file = await editXlsx(String(t.file_base64), (ws) => { ws.set('BR-5000', w.months[0]!, 1); ws.sheet.workbook.removeWorksheet('_base'); });
    const before = await state(v);
    expect(text(await imp(w.u, { version_id: v, file_base64: file, dry_run: true }))).toMatch(/^This workbook has no _base sheet/);
    expect(text(await imp(w.u, { version_id: v, file_base64: file }))).toMatch(/^This workbook has no _base sheet/);
    expect(await state(v)).toEqual(before);
  });
});

describe('the plan_hash binds content, not only the token', () => {
  it('in ONE transaction (the token cannot move) a cell the import changes, changed after its dry run, makes the live call "plan changed"', async () => {
    const v = await fx.version(w);
    const set = (amount: string) => ['set_budget_amounts', { version_id: v, cells: [{ account: 'BR-5000', month: w.months[0]!, amount }], idempotency_key: key() }] as [string, Record<string, unknown>];
    const grid = (r: Parameters<Parameters<typeof mcpBatch>[2][number]>[0]) => {
      const t = JSON.parse(r[1]!.content[0]!.text) as { rows: GridRow[] };
      setMonth(t.rows, 'BR-5000', w.months[0]!, '77.00');
      return { rows: t.rows };
    };
    const out = await mcpBatch(pool, w.u, [
      () => set('1.00'), // the token is now this transaction's now(), and stays it
      () => ['get_budget_template', { version_id: v, limit: 50 }],
      (r) => ['import_budget_workbook', { version_id: v, ...grid(r), dry_run: true, idempotency_key: key() }],
      () => set('2.00'),
      (r) => ['import_budget_workbook', { version_id: v, ...grid(r), plan_hash: JSON.parse(r[2]!.content[0]!.text).plan_hash, idempotency_key: key() }],
    ]);
    expect(out.slice(0, 4).map((r) => r.isError ?? false)).toEqual([false, false, false, false]);
    expect(text(out[4]!)).toMatch(/plan changed since your dry run/);
    expect(await fx.cells(v)).toEqual([`${w.rent}||||${w.months[0]}=2.00`]);
  });
});
