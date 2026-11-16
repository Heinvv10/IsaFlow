/**
 * MCP budget writes where the version token cannot tell calls apart, against a real database as app_user:
 *  - ONE transaction (a JSON-RPC batch): every budget write sets updated_at to the same now(). A second restore
 *    in the batch must not undo the earlier write too, and a dry run's plan_hash must not apply after another
 *    call in the batch changed its cells.
 *  - Drivers: the dry run shows what the save actually leaves (an override cleared resets to its driver value;
 *    a dependent on another account is recomputed), and a restore puts a driver cell back as a driver cell.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import saveRoute from '../../pages/api/accounting/budget-grid/save';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridSaveFixture, type GridWorld } from './helpers/budgetGridSaveFixture';
import { body, mcp, mcpBatch, mcpReads, text } from './helpers/mcpBudgetFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetGridSaveFixture(pool, saveRoute, '/api/accounting/budget-grid/save');
const reads = mcpReads(pool);

let w: GridWorld;
beforeAll(async () => { w = await fx.world(); }, 120000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM mcp_tool_calls WHERE company_id = $1', [w.u.homeCompanyId]);
    await pool.query('DELETE FROM budget_driver_lines WHERE company_id = $1', [w.u.homeCompanyId]);
    await fx.cleanup();
  } finally {
    await pool.end();
  }
}, 120000);

const key = () => `k-${crypto.randomUUID()}`;
const cell = (account: string, month: string, amount: string | null) => ({ account, month, amount });
const hashOf = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text).plan_hash as string;

describe('one transaction (a JSON-RPC batch)', () => {
  it('[write A, write B, restore, restore]: the second restore is refused, A stays', async () => {
    const v = await fx.version(w);
    const A = [cell('BR-5000', w.months[0]!, '1.00'), cell('BR-5000', w.months[1]!, '1.00')];
    const B = [cell('GS-4000', w.months[0]!, '2.00'), cell('GS-4000', w.months[1]!, '2.00')];
    const out = await mcpBatch(pool, w.u, [
      () => ['set_budget_amounts', { version_id: v, cells: A, dry_run: true, idempotency_key: key() }],
      (r) => ['set_budget_amounts', { version_id: v, cells: A, plan_hash: hashOf(r[0]!), idempotency_key: key() }],
      () => ['set_budget_amounts', { version_id: v, cells: B, dry_run: true, idempotency_key: key() }],
      (r) => ['set_budget_amounts', { version_id: v, cells: B, plan_hash: hashOf(r[2]!), idempotency_key: key() }],
      () => ['restore_budget_version', { version_id: v, dry_run: true, idempotency_key: key() }],
      (r) => ['restore_budget_version', { version_id: v, plan_hash: hashOf(r[4]!), idempotency_key: key() }],
      () => ['restore_budget_version', { version_id: v, dry_run: true, idempotency_key: key() }],
    ]);
    expect(out.slice(0, 6).map((r) => r.isError ?? false)).toEqual([false, false, false, false, false, false]);
    expect(text(out[6]!)).toMatch(/already restored; an earlier write cannot be restored/);
    expect(await fx.cells(v)).toEqual([`${w.rent}||||${w.months[0]}=1.00`, `${w.rent}||||${w.months[1]}=1.00`].sort());
  });

  it('B2: [write, approve, restore] in one batch: the restore is refused (the status moved since the write)', async () => {
    const v = await fx.version(w);
    const A = [cell('BR-5000', w.months[0]!, '1.00'), cell('BR-5000', w.months[1]!, '1.00')];
    const out = await mcpBatch(pool, w.u, [
      () => ['set_budget_amounts', { version_id: v, cells: A, dry_run: true, idempotency_key: key() }],
      (r) => ['set_budget_amounts', { version_id: v, cells: A, plan_hash: hashOf(r[0]!), idempotency_key: key() }],
      () => ['approve_budget_version', { version_id: v, idempotency_key: key() }],
      () => ['restore_budget_version', { version_id: v, dry_run: true, idempotency_key: key() }],
    ]);
    expect(out.slice(0, 3).map((r) => r.isError ?? false)).toEqual([false, false, false]);
    expect(text(out[3]!)).toMatch(/status changed since that write/);
    expect((await fx.cells(v)).length).toBe(2);
  });

  it('a dry run\'s plan_hash is refused after another call in the same batch changed its cells', async () => {
    const v = await fx.version(w);
    const B = [cell('BR-5000', w.months[0]!, '5.00'), cell('BR-5000', w.months[1]!, '5.00')];
    const out = await mcpBatch(pool, w.u, [
      () => ['set_budget_amounts', { version_id: v, cells: B, dry_run: true, idempotency_key: key() }],
      () => ['set_budget_amounts', { version_id: v, cells: [cell('BR-5000', w.months[0]!, '9.00')], idempotency_key: key() }],
      (r) => ['set_budget_amounts', { version_id: v, cells: B, plan_hash: hashOf(r[0]!), idempotency_key: key() }],
    ]);
    expect(out[1]!.isError ?? false).toBe(false);
    expect(text(out[2]!)).toMatch(/plan changed since your dry run/);
    expect(await fx.cells(v)).toEqual([`${w.rent}||||${w.months[0]}=9.00`]);
  });
});

describe('drivers', () => {
  /** A rent cell pinned as an override AT the driver's own value (50). */
  const pinAtDriverValue = (v: string, month: string) => pool.query(
    `UPDATE budget_month_amounts SET amount_source = 'override' WHERE version_id = $1 AND gl_account_id = $2 AND month = $3::DATE`, [v, w.rent, `${month}-01`]);

  async function driverVersion(): Promise<string> {
    const v = await fx.version(w);
    const line = (acct: string, kind: string, amount: number | null, pct: number | null, ref: string | null) => pool.query(
      `INSERT INTO budget_driver_lines (company_id, version_id, gl_account_id, kind, from_month, to_month, amount, pct, ref_gl_account_id, created_by)
       VALUES ($1, $2, $3, $4, $5::DATE, $6::DATE, $7, $8, $9, $10)`,
      [w.u.homeCompanyId, v, acct, kind, `${w.months[0]}-01`, `${w.months[2]}-01`, amount, pct, ref, w.u.userId]);
    await line(w.rent, 'fixed', 50, null, null);
    await line(w.sales, 'pct_of_line', null, 10, w.rent);
    for (const m of w.months.slice(0, 3)) {
      await pool.query(
        `INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount, amount_source)
         VALUES ($1, $2, $3, $4::DATE, 50, 'driver'), ($1, $2, $5, $4::DATE, 5, 'driver')`,
        [w.u.homeCompanyId, v, w.rent, `${m}-01`, w.sales]);
    }
    return v;
  }

  it('typing over a driver cell: the dry run lists the recomputed dependent; restore puts the driver cell back', async () => {
    const v = await driverVersion();
    const dry = body(await mcp(pool, w.u, 'set_budget_amounts', { version_id: v, cells: [cell('BR-5000', w.months[0]!, '70.00')], dry_run: true, idempotency_key: key() }));
    expect(dry.cells).toEqual([
      expect.objectContaining({ i: 0, account: 'BR-5000', status: 'changed', before: '50.00', after: '70.00', source: 'override' }),
      expect.objectContaining({ i: null, account: 'GS-4000', month: w.months[0], status: 'recomputed', before: '5.00', after: '7.00', source: 'driver' }),
    ]);
    const live = body(await mcp(pool, w.u, 'set_budget_amounts', { version_id: v, cells: [cell('BR-5000', w.months[0]!, '70.00')], plan_hash: dry.plan_hash, idempotency_key: key() }));
    expect(live).toMatchObject({ saved: 1, counts: { recomputed: 1 } });
    expect((await reads.snapshots(v))[0]!.cells).toEqual([{ a: w.rent, c1: null, c2: null, b: null, m: w.months[0], before: '50.00', after: '70.00', bs: 'driver', as: 'override' }]);

    const clear = body(await mcp(pool, w.u, 'set_budget_amounts', { version_id: v, cells: [cell('BR-5000', w.months[0]!, null)], dry_run: true, idempotency_key: key() }));
    expect(clear.cells).toEqual(expect.arrayContaining([expect.objectContaining({ i: 0, status: 'changed', before: '70.00', after: '50.00', source: 'driver' })]));

    expect(body(await mcp(pool, w.u, 'restore_budget_version', { version_id: v, idempotency_key: key() }))).toMatchObject({ restored: expect.any(Number) });
    const src = (await pool.query(
      `SELECT gl_account_id::text AS a, amount::text AS amount, amount_source FROM budget_month_amounts WHERE version_id = $1 AND month = $2::DATE ORDER BY 1`,
      [v, `${w.months[0]}-01`])).rows;
    expect(src).toEqual(expect.arrayContaining([{ a: w.rent, amount: '50.00', amount_source: 'driver' }, { a: w.sales, amount: '5.00', amount_source: 'driver' }]));
  });

  it('B1: restoring an override equal to the driver value is refused with the reason (single cell and with a second cell); nothing changes', async () => {
    const v = await driverVersion();
    await pinAtDriverValue(v, w.months[0]!);
    expect(body(await mcp(pool, w.u, 'set_budget_amounts', { version_id: v, cells: [cell('BR-5000', w.months[0]!, null)], idempotency_key: key() }))).toMatchObject({ deleted: 1 });
    const single = await mcp(pool, w.u, 'restore_budget_version', { version_id: v, idempotency_key: key() });
    expect(text(single)).toMatch(/override .* its driver now computes the same value/);

    const v2 = await driverVersion();
    await pinAtDriverValue(v2, w.months[0]!);
    const two = [cell('BR-5000', w.months[0]!, null), cell('BR-5000', w.months[1]!, '60.00')];
    const dry = body(await mcp(pool, w.u, 'set_budget_amounts', { version_id: v2, cells: two, dry_run: true, idempotency_key: key() }));
    body(await mcp(pool, w.u, 'set_budget_amounts', { version_id: v2, cells: two, plan_hash: dry.plan_hash, idempotency_key: key() }));
    const before = await fx.cells(v2);
    expect(text(await mcp(pool, w.u, 'restore_budget_version', { version_id: v2, dry_run: true, idempotency_key: key() }))).toMatch(/override .* its driver now computes the same value/);
    expect(await fx.cells(v2)).toEqual(before);
    expect((await reads.snapshots(v2))[0]!.restored_at).toBeNull();
  });
});
