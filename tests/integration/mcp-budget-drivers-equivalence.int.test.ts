/**
 * EQUIVALENCE (MCP budget tools PR 3): the same driver edits and the same slice submit made through the app's routes
 * as a person (real withAuth) and through the MCP tools as the same person's token leave the same budget.
 * (1) PUT budget-drivers (COGS = 38% of Sales), POST planned-hires, a grid save over a driver cell (an override),
 *     POST budget-drivers/override (reset it), PUT a fixed Rent driver, DELETE it; against set_budget_drivers
 *     (dry run + apply each time) with set_budget_amounts for the typed cell.
 * (2) POST budgets/slices/[id]/submit as the slice's holder; against submit_budget_for_review by version.
 * Compared: every budget_month_amounts row (account, dimensions, month, amount, source, created_by), every driver
 * line and planned hire (content, created_by / updated_by), the version's state, the slice review's state, and the
 * audit rows of the version (action, user, fields, metadata) and the owner's notifications.
 * Ignored, and why: ids and timestamps (new each time); the version name (two versions of a year cannot share one);
 * a planned hire's id and a slice's id in audit metadata and notification keys (new rows); the order of audit rows
 * (one MCP call carrying two changes writes both in one transaction: same created_at), so rows compare as a sorted set.
 * MCP-only rows by design: mcp_tool_calls and budget_write_snapshots.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import sliceRoute from '../../pages/api/accounting/budgets/slices/[id]/[action]';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetDriverRouteFixture, dataOf, type DriverWorld } from './helpers/budgetDriverRouteFixture';
import { budgetsRouteFixture } from './helpers/budgetsRouteFixture';
import type { SetupUser } from './helpers/onboardingSetupFixture';
import { body, mcp } from './helpers/mcpBudgetFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetDriverRouteFixture(pool);
const slices = budgetsRouteFixture(pool, sliceRoute, '/api/accounting/budgets/slices/submit');

let w: DriverWorld;
let holder: SetupUser;
beforeAll(async () => {
  w = await fx.world();
  holder = await fx.member(w.u.homeCompanyId, 'manager');
}, 120_000);
afterAll(async () => {
  try {
    for (const t of ['mcp_tool_calls', 'budget_slice_reviews', 'budget_holders', 'user_notifications']) {
      await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [w.u.homeCompanyId]);
    }
    await fx.cleanup();
  } finally { await pool.end(); }
}, 120_000);

const key = () => crypto.randomUUID();
const q = async (sql: string, v: string) => (await pool.query(sql, [v])).rows;
const amounts = (v: string) => q(`SELECT gl_account_id, cc1_id, cc2_id, bu_id, to_char(month, 'YYYY-MM') AS m, amount::text AS amount, amount_source, created_by
  FROM budget_month_amounts WHERE version_id = $1 ORDER BY gl_account_id, month, cc1_id NULLS FIRST`, v);
const drivers = (v: string) => q(`SELECT gl_account_id, cc1_id, cc2_id, bu_id, kind, from_month::text, to_month::text, amount::text, pct::text,
  ref_gl_account_id, ref_cc1_id, ref_cc2_id, ref_bu_id, ref_section, ref_scope, base_month::text, headcount_cost_centre_id, rounding_unit, created_by, updated_by
  FROM budget_driver_lines WHERE version_id = $1 ORDER BY gl_account_id, cc1_id NULLS FIRST`, v);
const hires = (v: string) => q(`SELECT label, cost_centre_id, start_month::text, end_month::text, fte::text, created_by FROM budget_planned_hires WHERE version_id = $1 ORDER BY label`, v);
const versionState = async (v: string) => (await q(`SELECT company_id, fiscal_year, kind, status, based_on_version_id, is_primary, created_by, approved_by, locked_by FROM budget_versions WHERE id = $1`, v))[0];

/** Audit rows of the version as a sorted set, with the new rows' ids (hire, slice) masked. */
async function auditRows(v: string) {
  const rows = await q(`SELECT action, entity_type, user_id, user_email, entity_ref, changes, ip_address, user_agent, session_id FROM audit_log WHERE entity_type = 'budget' AND entity_id = $1`, v);
  const mask = (c: { metadata?: Record<string, unknown> }) => ({
    ...c, metadata: Object.fromEntries(Object.entries(c.metadata ?? {}).map(([k, x]) => [k, ['hireId', 'sliceId', 'headcountAsOf'].includes(k) ? '(new)' : x])),
  });
  return rows.map((r) => JSON.stringify({ ...r, changes: mask(r.changes as never) })).sort();
}

describe('the same driver edits through the app and through MCP leave the same budget', () => {
  it('drivers, a planned hire, an override and its reset, a driver set and deleted: same rows, lines, hires, state, audit', async () => {
    const make = async (name: string) => {
      const v = await fx.version(w, { name });
      for (const m of w.months.slice(0, 3)) await fx.amount(w, v, w.sales, m, 1000);
      return v;
    };
    const ui = await make('EQD app');
    const viaMcp = await make('EQD mcp');
    const [m0, m1, m3, m11] = [w.months[0]!, w.months[1]!, w.months[3]!, w.months[11]!];

    const ok = (r: { status: number; body: unknown }) => expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    ok(await fx.call.drivers(w.u, 'PUT', { versionId: ui, glAccountId: w.cogs, kind: 'pct_of_line', pct: 38, fromMonth: m0, toMonth: m11, ref: { glAccountId: w.sales } }));
    ok(await fx.call.hires(w.u, 'POST', { versionId: ui, label: 'Sales rep', costCentreId: w.cc1, startMonth: m3, fte: 1.5 }));
    ok(await fx.call.save(w.u, ui, [{ glAccountId: w.cogs, month: m1, amount: 500 }]));
    ok(await fx.call.override(w.u, { versionId: ui, glAccountId: w.cogs, month: m1 }));
    const rent = await fx.call.drivers(w.u, 'PUT', { versionId: ui, glAccountId: w.rent, kind: 'fixed', amount: 100, fromMonth: m0, toMonth: m1 });
    ok(rent);
    ok(await fx.call.drivers(w.u, 'DELETE', undefined, { versionId: ui, id: String(dataOf<{ driver: { id: string } }>(rent).driver.id) }));

    const drive = async (changes: unknown[]) => {
      const d = body(await mcp(pool, w.u, 'set_budget_drivers', { version_id: viaMcp, changes, dry_run: true, idempotency_key: key() }));
      body(await mcp(pool, w.u, 'set_budget_drivers', { version_id: viaMcp, changes, plan_hash: d.plan_hash, idempotency_key: key() }));
    };
    await drive([
      { op: 'set_driver', account: 'GS-5100', kind: 'pct_of_line', pct: 38, from_month: m0, to_month: m11, ref: { account: 'GS-4000' } },
      { op: 'add_hire', label: 'Sales rep', cost_centre: 'GS-C1', start_month: m3, fte: 1.5 },
    ]);
    body(await mcp(pool, w.u, 'set_budget_amounts', { version_id: viaMcp, cells: [{ account: 'GS-5100', month: m1, amount: '500.00' }], idempotency_key: key() }));
    await drive([{ op: 'reset_override', account: 'GS-5100', month: m1 }]);
    await drive([{ op: 'set_driver', account: 'BR-5000', kind: 'fixed', amount: '100.00', from_month: m0, to_month: m1 }]);
    await drive([{ op: 'delete_driver', account: 'BR-5000' }]);

    const uiRows = await amounts(ui);
    expect(uiRows.filter((r) => r.amount_source === 'driver').length).toBe(12);
    expect(uiRows.some((r) => r.gl_account_id === w.rent && r.amount_source === 'manual')).toBe(true);
    expect(await amounts(viaMcp)).toEqual(uiRows);
    expect(await drivers(viaMcp)).toEqual(await drivers(ui));
    expect(await hires(viaMcp)).toEqual(await hires(ui));
    expect(await versionState(viaMcp)).toEqual(await versionState(ui));
    const uiAudit = await auditRows(ui);
    expect(uiAudit).toHaveLength(6);
    expect(await auditRows(viaMcp)).toEqual(uiAudit);
  });
});

describe('the same slice submit through the app and through MCP', () => {
  it('a holder submits their CC1 slice: same slice state, same audit row, same notification to the owner', async () => {
    const setup = async (name: string) => {
      const v = await fx.version(w, { name });
      await pool.query(`INSERT INTO budget_holders (company_id, version_id, user_id, cc1_id, created_by) VALUES ($1, $2, $3, $4, $5)`, [w.u.homeCompanyId, v, holder.userId, w.cc1, w.u.userId]);
      const slice = String((await pool.query(`INSERT INTO budget_slice_reviews (company_id, version_id, cc1_id, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
        [w.u.homeCompanyId, v, w.cc1, w.u.userId])).rows[0].id);
      return { v, slice };
    };
    const ui = await setup('EQS app');
    const viaMcp = await setup('EQS mcp');
    const r = await slices.call(holder, 'POST', {}, { id: ui.slice, action: 'submit' });
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    const dry = await mcp(pool, holder, 'submit_budget_for_review', { version_id: viaMcp.v, dry_run: true, idempotency_key: key() }, { role: 'manager' });
    expect(body(dry)).toMatchObject({ dry_run: true, slice: { status: 'open' } });
    expect(body(await mcp(pool, holder, 'submit_budget_for_review', { version_id: viaMcp.v, idempotency_key: key() }, { role: 'manager' })))
      .toMatchObject({ slice: { id: viaMcp.slice, status: 'submitted' } });

    const review = async (id: string) => (await q(`SELECT status, submitted_by, decided_by, decision_note, due_date, cc1_id, cc2_id, bu_id FROM budget_slice_reviews WHERE id = $1`, id))[0];
    expect(await review(ui.slice)).toMatchObject({ status: 'submitted', submitted_by: holder.userId });
    expect(await review(viaMcp.slice)).toEqual(await review(ui.slice));
    expect(await auditRows(viaMcp.v)).toEqual(await auditRows(ui.v));
    const notes = async (slice: string, name: string) => (await pool.query(
      `SELECT user_id, kind, title, href, replace(body, $3, '(name)') AS body FROM user_notifications WHERE company_id = $1 AND ref_id = $2 ORDER BY user_id`,
      [w.u.homeCompanyId, slice, name])).rows;
    const uiNotes = await notes(ui.slice, 'EQS app');
    expect(uiNotes.map((n) => n.user_id)).toEqual([w.u.userId]);
    expect(await notes(viaMcp.slice, 'EQS mcp')).toEqual(uiNotes);
  });
});
