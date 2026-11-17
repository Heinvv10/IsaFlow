/**
 * Budget holders (P5-6) through the MCP budget tools, against a real database as app_user: a manager holding
 * the CC1 slice writes inside it (set_budget_amounts and set_budget_annual) and restores their own write; a
 * cell outside it is refused by the save's own holder check (naming the cell) and nothing is written.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import saveRoute from '../../pages/api/accounting/budget-grid/save';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridSaveFixture, type GridWorld } from './helpers/budgetGridSaveFixture';
import type { SetupUser } from './helpers/onboardingSetupFixture';
import { body, mcp, text } from './helpers/mcpBudgetFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetGridSaveFixture(pool, saveRoute, '/api/accounting/budget-grid/save');

let w: GridWorld;
beforeAll(async () => { w = await fx.world(); }, 120000);
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
const as = { role: 'manager' };

async function holderOf(v: string): Promise<SetupUser> {
  const holder = await fx.member(w.u.homeCompanyId, 'manager');
  await pool.query(`INSERT INTO budget_holders (company_id, version_id, user_id, cc1_id, created_by) VALUES ($1, $2, $3, $4, $5)`,
    [w.u.homeCompanyId, v, holder.userId, w.cc1, w.u.userId]);
  await pool.query(`INSERT INTO budget_slice_reviews (company_id, version_id, cc1_id, created_by) VALUES ($1, $2, $3, $4)`, [w.u.homeCompanyId, v, w.cc1, w.u.userId]);
  return holder;
}

describe('budget holders through the tools', () => {
  it('set_budget_amounts: inside the CC1 slice saves; outside it is refused by the save\'s own check; nothing is written', async () => {
    const v = await fx.version(w);
    const holder = await holderOf(v);
    const outside = await mcp(pool, holder, 'set_budget_amounts', { version_id: v, cells: [{ account: 'BR-5000', month: w.months[0]!, amount: '9.00' }], idempotency_key: key() }, as);
    expect(text(outside)).toMatch(/^You can change only your own budget slices: account BR-5000 Rent month \S+ is outside them/);
    expect(await fx.cells(v)).toEqual([]);
    const inside = body(await mcp(pool, holder, 'set_budget_amounts', { version_id: v, cells: [{ account: 'BR-5000', month: w.months[0]!, amount: '9.00', cc1: 'GS-C1' }], idempotency_key: key() }, as));
    expect(inside).toMatchObject({ saved: 1 });
    expect(await fx.cells(v)).toEqual([`${w.rent}|${w.cc1}|||${w.months[0]}=9.00`]);
  });

  it('set_budget_annual inside the slice, then the holder restores their own write', async () => {
    const v = await fx.version(w);
    const holder = await holderOf(v);
    const rows = [{ account: 'BR-5000', amount: '1200.00', spread: 'flat', cc1: 'GS-C1' }];
    const outside = await mcp(pool, holder, 'set_budget_annual', { version_id: v, rows: [{ account: 'BR-5000', amount: '1200.00', spread: 'flat' }], dry_run: true, idempotency_key: key() }, as);
    expect(text(outside)).toMatch(/would be refused: You can change only your own budget slices/);
    const dry = body(await mcp(pool, holder, 'set_budget_annual', { version_id: v, rows, dry_run: true, idempotency_key: key() }, as));
    expect(body(await mcp(pool, holder, 'set_budget_annual', { version_id: v, rows, plan_hash: dry.plan_hash, idempotency_key: key() }, as))).toMatchObject({ saved: 12 });
    expect((await fx.cells(v)).length).toBe(12);
    const rdry = body(await mcp(pool, holder, 'restore_budget_version', { version_id: v, dry_run: true, idempotency_key: key() }, as));
    expect(body(await mcp(pool, holder, 'restore_budget_version', { version_id: v, plan_hash: rdry.plan_hash, idempotency_key: key() }, as))).toMatchObject({ restored: 12 });
    expect(await fx.cells(v)).toEqual([]);
  });
});
