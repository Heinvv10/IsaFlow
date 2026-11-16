/**
 * EQUIVALENCE: one budget built twice from the same source, once through the app's routes as a person
 * (POST budget-grid/seed, then POST budget-grid/save, real withAuth) and once through the MCP tools as the
 * same person's token (seed_budget, then set_budget_amounts dry run + apply). The two versions must hold the
 * same amount rows, be in the same state, and carry the same audit rows.
 *
 * Ignored, and why:
 *  - ids (version id, row ids, audit ids) and timestamps (created_at / updated_at, the version token): new each time;
 *  - the version NAME and the audit `entity_ref` of the create row ('FY<year> <name>'): two versions of one year
 *    cannot share a name (budget_versions_name_per_year);
 *  - `entity_id` of the audit rows: it is the version's id (compared through which version the rows belong to).
 * MCP-only rows, outside the compared tables by design: `mcp_tool_calls` (the registry's call audit) and
 * `budget_write_snapshots` (the undo record of set_budget_amounts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import saveRoute from '../../pages/api/accounting/budget-grid/save';
import seedRoute from '../../pages/api/accounting/budget-grid/seed';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridSaveFixture, type GridWorld } from './helpers/budgetGridSaveFixture';
import { budgetsRouteFixture } from './helpers/budgetsRouteFixture';
import { body, mcp } from './helpers/mcpBudgetFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetGridSaveFixture(pool, saveRoute, '/api/accounting/budget-grid/save');
const seedCall = budgetsRouteFixture(pool, seedRoute, '/api/accounting/budget-grid/seed');

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

async function amountRows(versionId: string) {
  return (await pool.query(
    `SELECT gl_account_id, cc1_id, cc2_id, bu_id, to_char(month, 'YYYY-MM') AS month, amount::text AS amount, amount_source, created_by
       FROM budget_month_amounts WHERE version_id = $1
      ORDER BY gl_account_id, month, cc1_id NULLS FIRST, cc2_id NULLS FIRST, bu_id NULLS FIRST`, [versionId])).rows;
}

async function versionState(versionId: string) {
  const r = (await pool.query(
    `SELECT company_id, fiscal_year, kind, status, based_on_version_id, is_primary, created_by, approved_by, locked_by, unlocked_by, unlock_reason
       FROM budget_versions WHERE id = $1`, [versionId])).rows[0];
  return r;
}

async function auditRows(versionId: string) {
  const rows = (await pool.query(
    `SELECT action, entity_type, user_id, user_email, entity_ref, changes, ip_address, user_agent, session_id, created_at
       FROM audit_log WHERE entity_type = 'budget' AND entity_id = $1`, [versionId])).rows as Array<Record<string, unknown>>;
  // Rows of one transaction share created_at (now()); within it they are ordered by content, never by the random id.
  const at = (r: Record<string, unknown>) => (r.created_at as Date).getTime();
  rows.sort((a, b) => at(a) - at(b) || JSON.stringify([a.action, a.changes]).localeCompare(JSON.stringify([b.action, b.changes])));
  // entity_ref of the create row carries the version name (ignored, see the header); the others are 'FY<year> budget'.
  return rows.map(({ entity_ref, created_at: _at, ...r }) => ({ ...r, entity_ref: String(entity_ref).startsWith(`FY${w.label} budget`) ? entity_ref : '(name)' }));
}

describe('a budget built through the app and through MCP is the same budget', () => {
  it('seed from a version +10%, then a batch of cell edits: same rows, same state, same audit', async () => {
    const source = await fx.version(w, { name: 'EQ source' });
    await fx.amount(w, source, w.rent, w.months[0]!, 1000);
    await fx.amount(w, source, w.rent, w.months[1]!, 333.33);
    await fx.amount(w, source, w.sales, w.months[0]!, -500.55, { cc1: w.cc1 });
    await fx.amount(w, source, w.child1, w.months[5]!, 12.34);

    const ui = await seedCall.call(w.u, 'POST', {
      fiscalYear: w.label, name: 'EQ app', kind: 'scenario', makePrimary: false, roundingUnit: 1,
      source: { type: 'version', versionId: source, upliftPct: 10 },
    });
    expect(ui.status, JSON.stringify(ui.body).slice(0, 300)).toBe(200);
    const uiVersion = String((ui.body.data as { versionId: string }).versionId);
    const viaMcp = body(await mcp(pool, w.u, 'seed_budget', {
      fiscal_year: w.label, name: 'EQ mcp', kind: 'scenario', source: 'version', source_version_id: source, uplift_pct: 10, idempotency_key: crypto.randomUUID(),
    }));
    const mcpVersion = String(viaMcp.version_id);

    const uiSave = await fx.call(w.u, {
      versionId: uiVersion, expectedUpdatedAt: await fx.token(uiVersion), cells: [
        { glAccountId: w.rent, month: w.months[2]!, amount: 1234.56 },
        { glAccountId: w.rent, month: w.months[1]!, amount: null, clear: true },
        { glAccountId: w.child2, month: w.months[3]!, amount: 0 },
      ],
    });
    expect(uiSave.status, JSON.stringify(uiSave.body).slice(0, 300)).toBe(200);
    const cells = [
      { account: 'BR-5000', month: w.months[2]!, amount: '1234.56' },
      { account: 'BR-5000', month: w.months[1]!, amount: null },
      { account: 'GS-6200', month: w.months[3]!, amount: '0.00' },
    ];
    const dry = body(await mcp(pool, w.u, 'set_budget_amounts', { version_id: mcpVersion, cells, dry_run: true, idempotency_key: crypto.randomUUID() }));
    body(await mcp(pool, w.u, 'set_budget_amounts', { version_id: mcpVersion, cells, version_token: dry.version_token, idempotency_key: crypto.randomUUID() }));

    const uiRows = await amountRows(uiVersion);
    expect(uiRows.length).toBeGreaterThan(3);
    expect(await amountRows(mcpVersion)).toEqual(uiRows);
    expect(await versionState(mcpVersion)).toEqual(await versionState(uiVersion));
    const uiAudit = await auditRows(uiVersion);
    expect(uiAudit.map((a) => a.action).sort()).toEqual(['create', 'update', 'update']);
    expect(await auditRows(mcpVersion)).toEqual(uiAudit);
  });
});
