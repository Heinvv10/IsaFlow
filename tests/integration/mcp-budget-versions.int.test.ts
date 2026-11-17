/**
 * The MCP budget version tools against a real database, as app_user through the real registry: create, copy,
 * delete (the app's rules), reforecast, note, seed with adjustments (dry run writes nothing and frees its key;
 * the live seed replays; flat seasonality fills every month from a sparse source), the annual spread, and
 * list_budget_versions' last edit (the audit row the write left, as the token user).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import saveRoute from '../../pages/api/accounting/budget-grid/save';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridSaveFixture, type GridWorld } from './helpers/budgetGridSaveFixture';
import { body, mcp, text } from './helpers/mcpBudgetFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetGridSaveFixture(pool, saveRoute, '/api/accounting/budget-grid/save');

let w: GridWorld;
beforeAll(async () => { w = await fx.world(); }, 120000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM mcp_tool_calls WHERE company_id = $1', [w.u.homeCompanyId]);
    await pool.query('DELETE FROM budget_rolling_forecasts WHERE company_id = $1', [w.u.homeCompanyId]);
    await fx.cleanup();
  } finally {
    await pool.end();
  }
}, 120000);

const key = () => crypto.randomUUID();
const versionsOfYear = async () => Number((await pool.query('SELECT COUNT(*)::int AS n FROM budget_versions WHERE company_id = $1', [w.u.homeCompanyId])).rows[0].n);

describe('version tools', () => {
  it('create, copy, note and list with the last edit', async () => {
    const created = body(await mcp(pool, w.u, 'create_budget_version', { fiscal_year: w.label, name: 'MCP blank', kind: 'scenario', idempotency_key: key() }));
    const v = (created.version as { id: string }).id;
    expect(created.version).toMatchObject({ status: 'draft', is_primary: false, cells: 0, total: '0.00' });
    await fx.amount(w, v, w.rent, w.months[0]!, 12.5);
    const copy = body(await mcp(pool, w.u, 'copy_budget_version', { version_id: v, name: 'MCP copy', kind: 'scenario', idempotency_key: key() }));
    expect(copy.version).toMatchObject({ based_on_version_id: v, cells: 1, total: '12.50' });

    expect(body(await mcp(pool, w.u, 'add_budget_note', { version_id: v, account: 'BR-5000', note: '  Lease renews in June  ', idempotency_key: key() })))
      .toMatchObject({ note: 'Lease renews in June' });
    expect(text(await mcp(pool, w.u, 'add_budget_note', { version_id: v, account: 'GS-6000', note: 'x', idempotency_key: key() }))).toMatch(/header account/);

    const list = body(await mcp(pool, w.u, 'list_budget_versions', { fiscal_year: w.label }));
    const mine = (list.items as Array<{ id: string; last_edit: { by: string; action: string } | null }>).find((i) => i.id === v)!;
    expect(mine.last_edit).toMatchObject({ by: w.u.userId, action: 'update' });
  });

  it('seed_budget: the dry run writes nothing; the live seed applies section / account uplifts and a fixed annual amount', async () => {
    const source = await fx.version(w, { name: 'seed source' });
    await fx.amount(w, source, w.rent, w.months[0]!, 100);
    await fx.amount(w, source, w.rent, w.months[1]!, 300);
    await fx.amount(w, source, w.sales, w.months[0]!, 1000);
    await fx.amount(w, source, w.child1, w.months[0]!, 50);
    const args = {
      fiscal_year: w.label, name: 'MCP seed', kind: 'scenario', source: 'version', source_version_id: source, uplift_pct: 5,
      section_uplifts: [{ section: 'turnover', uplift_pct: 20 }], account_uplifts: [{ account: 'GS-6100', uplift_pct: -10 }],
      fixed_annual: [{ account: 'BR-5000', amount: '1000.00' }],
    };
    const before = await versionsOfYear();
    const k = key();
    const dry = body(await mcp(pool, w.u, 'seed_budget', { ...args, dry_run: true, idempotency_key: k }));
    expect(dry).toMatchObject({ dry_run: true, cells: 4 });
    expect(await versionsOfYear()).toBe(before);
    const first = await mcp(pool, w.u, 'seed_budget', { ...args, idempotency_key: k });
    const live = body(first);
    expect(text(await mcp(pool, w.u, 'seed_budget', { ...args, idempotency_key: k }))).toBe(text(first));
    expect(await versionsOfYear()).toBe(before + 1);
    const audit = (await fx.audits(String(live.version_id))).find((a) => a.changes.metadata?.seed === 'version')!;
    expect(audit.changes.metadata).toMatchObject({ seasonality: 'actuals', sectionUplifts: 'turnover:20', fixedAnnual: `${w.rent}:1000.00` });
    const rows = (await fx.cells(String(live.version_id))).map((r) => r.replace(/^[^|]*/, (id) => ({ [w.rent]: 'rent', [w.sales]: 'sales', [w.child1]: 'child1' })[id] ?? id));
    expect(rows.sort()).toEqual([
      `child1||||${w.months[0]}=45.00`, `rent||||${w.months[0]}=250.00`, `rent||||${w.months[1]}=750.00`, `sales||||${w.months[0]}=1200.00`,
    ].sort());
  });

  it('set_budget_annual: flat spread with the residue on the last month; prior_year refuses a row with no activity', async () => {
    const v = await fx.version(w);
    const refused = body(await mcp(pool, w.u, 'set_budget_annual', { version_id: v, rows: [{ account: 'GS-4000', amount: '1200', spread: 'prior_year' }], dry_run: true, idempotency_key: key() }));
    expect(refused).toMatchObject({ ready: false, counts: { refused: 1 } });
    const rows = [{ account: 'GS-4000', amount: '1000.00', spread: 'flat' }];
    const dry = body(await mcp(pool, w.u, 'set_budget_annual', { version_id: v, rows, dry_run: true, idempotency_key: key() }));
    body(await mcp(pool, w.u, 'set_budget_annual', { version_id: v, rows, plan_hash: dry.plan_hash, idempotency_key: key() }));
    const amounts = (await fx.cells(v)).map((r) => r.slice(r.indexOf('=') + 1));
    expect(amounts).toEqual([...Array(11).fill('83.00'), '87.00']);
  });

  it('seed_budget with seasonality flat fills EVERY month of the year from a sparse version source', async () => {
    const source = await fx.version(w, { name: 'sparse source' });
    await fx.amount(w, source, w.rent, w.months[2]!, 600);
    await fx.amount(w, source, w.rent, w.months[9]!, 600);
    const out = body(await mcp(pool, w.u, 'seed_budget', {
      fiscal_year: w.label, name: 'MCP flat', kind: 'scenario', source: 'version', source_version_id: source, seasonality: 'flat', idempotency_key: key(),
    }));
    const amounts = (await fx.cells(String(out.version_id))).map((r) => r.slice(r.indexOf('=') + 1));
    expect(amounts).toEqual(Array(12).fill('100.00'));
  });

  it('delete_budget_version: the dry run deletes nothing and frees its key; the primary is refused; a draft is deleted', async () => {
    const v = await fx.version(w, { name: 'to delete' });
    const primary = await fx.version(w, { name: 'the primary', primary: true });
    expect(text(await mcp(pool, w.u, 'delete_budget_version', { version_id: primary, idempotency_key: key() }))).toMatch(/primary budget cannot be deleted/);
    const k = key();
    expect(body(await mcp(pool, w.u, 'delete_budget_version', { version_id: v, dry_run: true, idempotency_key: k }))).toMatchObject({ dry_run: true, name: 'to delete' });
    expect((await pool.query('SELECT 1 FROM budget_versions WHERE id = $1', [v])).rowCount).toBe(1);
    expect(body(await mcp(pool, w.u, 'delete_budget_version', { version_id: v, idempotency_key: k }))).toMatchObject({ deleted: true });
    expect((await pool.query('SELECT 1 FROM budget_versions WHERE id = $1', [v])).rowCount).toBe(0);
    await pool.query('UPDATE budget_versions SET is_primary = false WHERE id = $1', [primary]);
  });

  it('create_reforecast: a draft reforecast based on the source, as the app makes it', async () => {
    const source = await fx.version(w, { name: 'rf source' });
    await fx.amount(w, source, w.rent, w.months[0]!, 10);
    const out = body(await mcp(pool, w.u, 'create_reforecast', { version_id: source, name: 'MCP reforecast', idempotency_key: key() }));
    expect(out.version).toMatchObject({ kind: 'reforecast', status: 'draft', based_on_version_id: source });
    expect(out.rolling).toBe(false);
  });
});
