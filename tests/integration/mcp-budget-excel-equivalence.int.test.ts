/**
 * EQUIVALENCE (MCP budget tools PR 2): one edit of a budget template, committed three times from versions holding
 * the same amounts: through the app as a person (GET budget-grid/template → the user's Excel edit →
 * POST budget-grid/import-preview → POST budget-grid/save with the preview's cells and token), through
 * import_budget_workbook with the same edit of the template get_budget_template answers as an .xlsx, and with the
 * same edit of its JSON grid. The versions must hold the same amount rows (account, dimensions, month, amount,
 * source, author) and carry the same audit rows.
 *
 * Ignored, and why: ids and timestamps (new each time); the version name (two versions of one year cannot share
 * one) and so the audit `entity_id`. The versions are inserted directly, so their only audit rows are the saves.
 * MCP-only rows, by design outside the compared tables: `mcp_tool_calls` and `budget_write_snapshots`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import saveRoute from '../../pages/api/accounting/budget-grid/save';
import templateRoute from '../../pages/api/accounting/budget-grid/template';
import previewRoute from '../../pages/api/accounting/budget-grid/import-preview';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridSaveFixture, type GridWorld } from './helpers/budgetGridSaveFixture';
import { downloadTemplate, editWorkbook, setCell, uploadPreview } from './helpers/budgetImportFixture';
import { body, mcp } from './helpers/mcpBudgetFixture';
import { editXlsx, gridRows, setMonth } from './helpers/mcpBudgetExcelFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetGridSaveFixture(pool, saveRoute, '/api/accounting/budget-grid/save');

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

const amountRows = async (versionId: string) => (await pool.query(
  `SELECT gl_account_id, cc1_id, cc2_id, bu_id, to_char(month, 'YYYY-MM') AS month, amount::text AS amount, amount_source, created_by
     FROM budget_month_amounts WHERE version_id = $1
    ORDER BY gl_account_id, month, cc1_id NULLS FIRST, cc2_id NULLS FIRST, bu_id NULLS FIRST`, [versionId])).rows;

const auditRows = async (versionId: string) => (await pool.query(
  `SELECT action, entity_type, user_id, user_email, entity_ref, changes, ip_address, user_agent, session_id
     FROM audit_log WHERE entity_type = 'budget' AND entity_id = $1 ORDER BY created_at`, [versionId])).rows;

/** The one edit: a changed amount, a cleared month, a budgeted zero, a new cell on an account holding none. */
const EDITS = (m: string[]) => [
  { account: 'BR-5000', month: m[0]!, xlsx: 150, json: '150.00' },
  { account: 'BR-5000', month: m[1]!, xlsx: null, json: null },
  { account: 'GS-4000', month: m[2]!, xlsx: 0, json: '0.00' },
  { account: 'GS-6200', month: m[3]!, xlsx: 45.67, json: '45.67' },
];

describe('an edited template committed through the app and through import_budget_workbook is the same commit', () => {
  it('same amount rows (with source and author) and the same audit rows, .xlsx and JSON grid alike', async () => {
    const versions: Record<'ui' | 'xlsx' | 'json', string> = { ui: await fx.version(w), xlsx: await fx.version(w), json: await fx.version(w) };
    for (const v of Object.values(versions)) {
      await fx.amount(w, v, w.rent, w.months[0]!, 100);
      await fx.amount(w, v, w.rent, w.months[1]!, 200);
      await fx.amount(w, v, w.sales, w.months[0]!, 500);
      await fx.amount(w, v, w.child1, w.months[5]!, 12.34);
    }
    const edits = EDITS(w.months);

    const t = await downloadTemplate(templateRoute, w.u, { version_id: versions.ui, grain: 'company' });
    expect(t.status).toBe(200);
    const file = await editWorkbook(t.file!, (wb) => { for (const e of edits) setCell(wb.getWorksheet('Budget')!, e.account, e.month, e.xlsx); });
    const preview = await uploadPreview(previewRoute, w.u, versions.ui, file);
    expect(preview.status, JSON.stringify(preview.body).slice(0, 300)).toBe(200);
    const p = preview.body.data as { updatedAt: string; cells: unknown[]; errorCount: number };
    expect([p.errorCount, p.cells.length]).toEqual([0, 4]);
    const saved = await fx.call(w.u, { versionId: versions.ui, expectedUpdatedAt: p.updatedAt, cells: p.cells });
    expect(saved.status, JSON.stringify(saved.body).slice(0, 300)).toBe(200);

    const x = body(await mcp(pool, w.u, 'get_budget_template', { version_id: versions.xlsx, format: 'xlsx' }));
    const xfile = await editXlsx(String(x.file_base64), (ws) => { for (const e of edits) ws.set(e.account, e.month, e.xlsx); });
    const xdry = body(await mcp(pool, w.u, 'import_budget_workbook', { version_id: versions.xlsx, file_base64: xfile, dry_run: true, idempotency_key: crypto.randomUUID() }));
    body(await mcp(pool, w.u, 'import_budget_workbook', { version_id: versions.xlsx, file_base64: xfile, plan_hash: xdry.plan_hash, idempotency_key: crypto.randomUUID() }));

    const g = await gridRows(pool, w.u, versions.json);
    for (const e of edits) setMonth(g.rows, e.account, e.month, e.json);
    const jdry = body(await mcp(pool, w.u, 'import_budget_workbook', { version_id: versions.json, rows: g.rows, version_token: g.token, dry_run: true, idempotency_key: crypto.randomUUID() }));
    body(await mcp(pool, w.u, 'import_budget_workbook', { version_id: versions.json, rows: g.rows, version_token: g.token, plan_hash: jdry.plan_hash, idempotency_key: crypto.randomUUID() }));

    const uiRows = await amountRows(versions.ui);
    expect(uiRows).toHaveLength(5); // Rent M0 150, Sales M0 500, Sales M2 0, Stationery M5 12.34, Postage M3 45.67 (Rent M1 cleared)
    const uiAudit = await auditRows(versions.ui);
    expect(uiAudit.map((a) => a.action)).toEqual(['update']);
    for (const v of [versions.xlsx, versions.json]) {
      expect(await amountRows(v)).toEqual(uiRows);
      expect(await auditRows(v)).toEqual(uiAudit);
    }
  });
});
