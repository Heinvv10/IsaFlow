/**
 * Budgets P2 PR-B round 2, VER-L2: a save that lands while the import preview reads the version
 * must never make a legitimate file look tampered. The read model's token and cells come from one
 * statement (one snapshot), so a save between reading the version row and reading the cells shows
 * as "saved since you downloaded" (a warning), not as a `_base` that contradicts the version at
 * the same token (a 400). The window is opened by wrapping `@/lib/neon`'s sql and saving through a
 * separate pool right after the version row is read. Round 9: the version's status comes from that
 * statement too, so a status move in the same window never pairs one state's status with another's
 * token.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import templateRoute from '../../pages/api/accounting/budget-grid/template';
import previewRoute from '../../pages/api/accounting/budget-grid/import-preview';
import gridRoute from '../../pages/api/accounting/budget-grid/index';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridFixture, monthsFrom, type GridCo } from './helpers/budgetGridFixture';
import { downloadTemplate, uploadPreview } from './helpers/budgetImportFixture';

const hooks = vi.hoisted(() => ({ afterVersionRead: null as null | (() => Promise<void>), fired: 0 }));

// Every statement runs as before; the one that reads the version row (P1's getVersion counts its
// amounts) runs the hook once after it, before anything else is read.
vi.mock('@/lib/neon', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const realSql = real.sql as (s: TemplateStringsArray, ...v: unknown[]) => unknown;
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    const hook = hooks.afterVersionRead;
    if (!hook || !/FROM budget_versions v/.test(text) || !text.includes('amount_count')) return realSql(strings, ...values);
    hooks.afterVersionRead = null;
    return (async () => {
      const rows = await realSql(strings, ...values);
      hooks.fired++;
      await hook();
      return rows;
    })();
  };
  return { ...real, sql: Object.assign(sql, realSql) };
});

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = budgetGridFixture(pool);
const FY27 = monthsFrom('2026-03');

let A: GridCo;
beforeAll(async () => { A = await fx.company(); }, 120000);
afterAll(async () => { try { await fx.cleanup(); } finally { await pool.end(); } }, 120000);

describe('VER-L2: a save during the preview\'s read', () => {
  it('is a "saved since" warning, never a false "tampered" 400', async () => {
    const v = await fx.version(A, { name: 'Race' });
    await fx.amounts(A, v, A.acct.sales, FY27, 1000);
    const t = await downloadTemplate(templateRoute, A.owner, { version_id: v, grain: 'company' });
    expect(t.status).toBe(200);
    hooks.afterVersionRead = async () => {
      await pool.query(`UPDATE budget_month_amounts SET amount = 5000 WHERE version_id = $1 AND gl_account_id = $2 AND month = $3`, [v, A.acct.sales, `${FY27[0]}-01`]);
      await pool.query(`UPDATE budget_versions SET updated_at = clock_timestamp() WHERE id = $1`, [v]);
    };
    const r = await uploadPreview(previewRoute, A.owner, v, t.file!);
    expect(hooks.fired).toBe(1);
    expect(r.status, JSON.stringify(r.body).slice(0, 400)).toBe(200);
    const p = r.body.data as unknown as { changes: unknown[]; warnings: Array<{ message: string }> };
    expect(p.changes).toEqual([]);
    expect(p.warnings.map((w) => w.message).join(' ')).toMatch(/1 cell .*changed since you downloaded/i);
  });

  it.each([
    ['approved between the statements', 'draft' as const, `UPDATE budget_versions SET status = 'approved', approved_by = $2, approved_at = clock_timestamp() WHERE id = $1`],
    ['locked between the statements', 'approved' as const, `UPDATE budget_versions SET status = 'locked', locked_by = $2, locked_at = clock_timestamp() WHERE id = $1`],
  ])('round 9: the read model\'s status and token come from one statement (%s)', async (_label, from, move) => {
    const v = await fx.version(A, { name: `Race status ${from}`, status: from });
    const firedBefore = hooks.fired;
    hooks.afterVersionRead = async () => { await pool.query(move, [v, A.user]); };
    const r = await fx.call(gridRoute, '/api/accounting/budget-grid', A.owner, 'GET', { version_id: v });
    expect(hooks.fired).toBe(firedBefore + 1);
    expect(r.status).toBe(200);
    const m = r.body.data as unknown as { updatedAt: string; version: { status: string; updatedAt: string } };
    const now = (await pool.query(`SELECT status, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') t FROM budget_versions WHERE id = $1`, [v])).rows[0];
    expect({ status: m.version.status, token: m.updatedAt, versionToken: m.version.updatedAt }).toEqual({ status: now.status, token: now.t, versionToken: now.t });
  });
});
