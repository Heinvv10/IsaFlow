/**
 * import_budget_workbook and budget drivers against a real database (review round 2, the breaker's D1, made
 * permanent): the agent reads the JSON template while COGS is a driver at 38% of Sales; a colleague moves the driver
 * to 50% (the cells recompute); the agent then types one COGS month. That one cell is a conflict (read 380, now 500,
 * typed 400): the live call without its dry run's plan_hash is refused and writes nothing; the dry run lists the
 * conflict; only the live call with that plan_hash writes it (an override of the driver).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetDriverRouteFixture, type DriverWorld } from './helpers/budgetDriverRouteFixture';
import { body, mcp, text } from './helpers/mcpBudgetFixture';
import { gridRows, setMonth } from './helpers/mcpBudgetExcelFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetDriverRouteFixture(pool);
let w: DriverWorld;
beforeAll(async () => { w = await fx.world(); }, 120000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM mcp_tool_calls WHERE company_id = $1', [w.u.homeCompanyId]);
    await fx.cleanup();
  } finally {
    await pool.end();
  }
}, 120000);

const imp = (args: Record<string, unknown>) => mcp(pool, w.u, 'import_budget_workbook', { idempotency_key: crypto.randomUUID(), ...args });
const cogs = async (v: string) => [...(await fx.row(v, w.cogs))].slice(0, 2).map(([m, c]) => `${m}=${c.amount}:${c.source}`);

describe('a colleague\'s driver change and a one-cell import', () => {
  it('D1: the one-cell conflict is refused live without the dry run\'s plan_hash, listed by the dry run, written only with it', async () => {
    const { v } = await fx.cogsOfSales(w);
    const { rows } = await gridRows(pool, w.u, v);
    const put = await fx.call.drivers(w.u, 'PUT', { versionId: v, glAccountId: w.cogs, kind: 'pct_of_line', pct: 50, fromMonth: w.months[0], toMonth: w.months[11], ref: { glAccountId: w.sales } });
    expect(put.status).toBe(200);
    const recomputed = await cogs(v);
    expect(recomputed).toEqual([`${w.months[0]}=500.00:driver`, `${w.months[1]}=500.00:driver`]);
    setMonth(rows, 'GS-5100', w.months[0]!, '400.00');
    const sel = rows.filter((r) => r.account === 'GS-5100');
    const before = await fx.state(v);

    expect(text(await imp({ version_id: v, rows: sel }))).toMatch(/plan_hash is required/);
    expect(await fx.state(v)).toEqual(before);

    const dry = body(await imp({ version_id: v, rows: sel, dry_run: true }));
    expect(dry).toMatchObject({ conflict_count: 1, conflicts: [{ account: 'GS-5100', dimension: null, month: w.months[0], downloaded: '380.00', current: '500.00', after: '400.00' }] });
    expect(await fx.state(v)).toEqual(before);

    body(await imp({ version_id: v, rows: sel, plan_hash: dry.plan_hash }));
    expect(await cogs(v)).toEqual([`${w.months[0]}=400.00:override`, `${w.months[1]}=500.00:driver`]);
  });
});
