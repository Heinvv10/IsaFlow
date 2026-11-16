/**
 * MCP budget writes against a real database, as app_user: the undo snapshot (migration 999f) is written with
 * the write, stamped by the database (session user, clock), and app_user can neither forge its stamps, change
 * its payload nor delete it; restore_budget_version puts the before-values back through the grid save (one more
 * audit row), marks the snapshot restored, and is refused once anything changed the version since (naming the
 * cells that differ); a budget holder writes only inside their slice, exactly as in the grid.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import saveRoute from '../../pages/api/accounting/budget-grid/save';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridSaveFixture, type GridWorld } from './helpers/budgetGridSaveFixture';
import { body, mcp, mcpReads, text } from './helpers/mcpBudgetFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetGridSaveFixture(pool, saveRoute, '/api/accounting/budget-grid/save');
const reads = mcpReads(pool);

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
const cell = (account: string, month: string, amount: string | null, dims: Record<string, string> = {}) => ({ account, month, amount, ...dims });

/** Dry run, then apply with its token: the two-step the tools teach. */
async function write(versionId: string, cells: unknown[], mode = 'merge') {
  const dry = body(await mcp(pool, w.u, 'set_budget_amounts', { version_id: versionId, mode, cells, dry_run: true, idempotency_key: key() }));
  return body(await mcp(pool, w.u, 'set_budget_amounts', { version_id: versionId, mode, cells, version_token: dry.version_token, idempotency_key: key() }));
}

describe('snapshot and restore', () => {
  it('a write records its snapshot (stamped by the database); restore puts every before-value back and marks it restored', async () => {
    const v = await fx.version(w);
    await fx.amount(w, v, w.rent, w.months[0]!, 10);
    await fx.amount(w, v, w.rent, w.months[1]!, 20);
    const original = await fx.cells(v);
    const out = await write(v, [cell('BR-5000', w.months[2]!, '30.00')], 'replace');
    expect(out).toMatchObject({ saved: 1, deleted: 2 });
    const [snap] = await reads.snapshots(v);
    expect(snap).toMatchObject({ id: out.snapshot_id, tool: 'set_budget_amounts', token_jti: 'jti-mcp-budget', token_after: out.version_token, created_by: w.u.userId, restored_at: null });
    expect(snap!.cells).toHaveLength(3);
    expect(snap!.cells).toEqual(expect.arrayContaining([{ a: w.rent, c1: null, c2: null, b: null, m: w.months[0], before: '10.00', after: null }]));

    const audits = (await fx.audits(v)).length;
    const dry = body(await mcp(pool, w.u, 'restore_budget_version', { version_id: v, dry_run: true, idempotency_key: key() }));
    expect(dry).toMatchObject({ dry_run: true, cells: 3 });
    expect((await reads.snapshots(v))[0]!.restored_at).toBeNull();
    const restored = body(await mcp(pool, w.u, 'restore_budget_version', { version_id: v, snapshot_id: snap!.id, idempotency_key: key() }));
    expect(restored).toMatchObject({ restored: 3 });
    expect(await fx.cells(v)).toEqual(original);
    expect((await fx.audits(v)).length).toBe(audits + 1);
    expect((await reads.snapshots(v))[0]).toMatchObject({ restored_by: w.u.userId, restored_at: expect.any(Date) });
    expect(text(await mcp(pool, w.u, 'restore_budget_version', { version_id: v, idempotency_key: key() }))).toMatch(/no MCP write left to restore/);
  });

  it('a later edit makes the restore refuse, naming the cells that differ; nothing changes', async () => {
    const v = await fx.version(w);
    const out = await write(v, [cell('BR-5000', w.months[0]!, '5.00'), cell('BR-5000', w.months[1]!, '6.00')]);
    const ui = await fx.call(w.u, { versionId: v, expectedUpdatedAt: out.version_token, cells: [{ glAccountId: w.rent, month: w.months[1]!, amount: 7 }] });
    expect(ui.status).toBe(200);
    const before = await fx.cells(v);
    const r = await mcp(pool, w.u, 'restore_budget_version', { version_id: v, idempotency_key: key() });
    expect(text(r)).toMatch(/changed since that write.*1 of its 2 cells differ now/);
    expect(text(r)).toContain(w.months[1]!);
    expect(await fx.cells(v)).toEqual(before);
    expect((await reads.snapshots(v))[0]!.restored_at).toBeNull();
  });

  it('app_user cannot forge a stamp, rewrite a snapshot or delete one (column grants + trigger)', async () => {
    const v = await fx.version(w);
    await write(v, [cell('BR-5000', w.months[0]!, '1.00')]);
    const [snap] = await reads.snapshots(v);
    const asApp = async (q: string, params: unknown[]) => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE app_user');
        await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: w.u.userId })]);
        await c.query("SELECT set_config('app.current_company_id', $1, true)", [w.u.homeCompanyId]);
        await c.query(q, params);
        return 'ok';
      } catch (err) {
        return (err as { code?: string }).code;
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    };
    expect(await asApp('UPDATE budget_write_snapshots SET cells = $2::JSONB WHERE id = $1', [snap!.id, '[]'])).toBe('42501');
    expect(await asApp('UPDATE budget_write_snapshots SET created_by = $2 WHERE id = $1', [snap!.id, 'someone'])).toBe('42501');
    expect(await asApp('DELETE FROM budget_write_snapshots WHERE id = $1', [snap!.id])).toBe('42501');
    expect(await asApp(`INSERT INTO budget_write_snapshots (company_id, version_id, tool, token_before, token_after, cells, created_by)
      VALUES ($1, $2, 't', 'a', 'b', '[{}]', 'forged')`, [w.u.homeCompanyId, v])).toBe('42501');
  });
});

describe('budget holders (P5-6) through the tools', () => {
  it('a manager holding the CC1 slice writes inside it; a cell outside it is refused and nothing is written', async () => {
    const v = await fx.version(w);
    const holder = await fx.member(w.u.homeCompanyId, 'manager');
    await pool.query(
      `INSERT INTO budget_holders (company_id, version_id, user_id, cc1_id, created_by) VALUES ($1, $2, $3, $4, $5)`,
      [w.u.homeCompanyId, v, holder.userId, w.cc1, w.u.userId]);
    await pool.query(
      `INSERT INTO budget_slice_reviews (company_id, version_id, cc1_id, created_by) VALUES ($1, $2, $3, $4)`, [w.u.homeCompanyId, v, w.cc1, w.u.userId]);
    const as = { role: 'manager' };
    const outside = await mcp(pool, holder, 'set_budget_amounts', { version_id: v, cells: [cell('BR-5000', w.months[0]!, '9.00')], idempotency_key: key() }, as);
    expect(outside.isError).toBe(true);
    expect(text(outside)).toMatch(/slice/i);
    expect(await fx.cells(v)).toEqual([]);
    const inside = body(await mcp(pool, holder, 'set_budget_amounts', { version_id: v, cells: [cell('BR-5000', w.months[0]!, '9.00', { cc1: 'GS-C1' })], idempotency_key: key() }, as));
    expect(inside).toMatchObject({ saved: 1 });
    expect(await fx.cells(v)).toEqual([`${w.rent}|${w.cc1}|||${w.months[0]}=9.00`]);
  });
});
