/**
 * MCP budget writes against a real database, as app_user: the undo snapshot (migration 999k) is written with
 * the write (values and sources), stamped by the database (session user, clock), and app_user can neither
 * forge its stamps, change its payload, delete it, nor mark it restored without the restore's own save;
 * restore_budget_version puts the before-values back through the grid save (one more audit row), marks the
 * snapshot restored, and is refused once anything changed the version since (naming the cells that differ),
 * for an older snapshot, and for anyone but the write's author or an owner / admin. Restore's dry run frees
 * its key and its live call replays.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import saveRoute from '../../pages/api/accounting/budget-grid/save';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridSaveFixture, type GridWorld } from './helpers/budgetGridSaveFixture';
import type { SetupUser } from './helpers/onboardingSetupFixture';
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
    await fx.cleanup();
  } finally {
    await pool.end();
  }
}, 120000);

const key = () => `k-${crypto.randomUUID()}`;
const cell = (account: string, month: string, amount: string | null, dims: Record<string, string> = {}) => ({ account, month, amount, ...dims });

/** Dry run, then apply with its plan_hash: the two-step the tools teach. */
async function write(versionId: string, cells: unknown[], mode = 'merge', u: SetupUser = w.u, role = 'owner') {
  const dry = body(await mcp(pool, u, 'set_budget_amounts', { version_id: versionId, mode, cells, dry_run: true, idempotency_key: key() }, { role }));
  return body(await mcp(pool, u, 'set_budget_amounts', { version_id: versionId, mode, cells, plan_hash: dry.plan_hash, idempotency_key: key() }, { role }));
}
async function restore(versionId: string, u: SetupUser = w.u, role = 'owner', extra: Record<string, unknown> = {}) {
  const dry = await mcp(pool, u, 'restore_budget_version', { version_id: versionId, dry_run: true, idempotency_key: key(), ...extra }, { role });
  if (dry.isError) return dry;
  return mcp(pool, u, 'restore_budget_version', { version_id: versionId, plan_hash: body(dry).plan_hash, idempotency_key: key(), ...extra }, { role });
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
    expect(snap!.cells).toEqual(expect.arrayContaining([{ a: w.rent, c1: null, c2: null, b: null, m: w.months[0], before: '10.00', after: null, bs: 'manual', as: null }]));

    const audits = (await fx.audits(v)).length;
    const k = key();
    const dry = body(await mcp(pool, w.u, 'restore_budget_version', { version_id: v, dry_run: true, idempotency_key: k }));
    expect(dry).toMatchObject({ dry_run: true, cells: 3, plan_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((await reads.snapshots(v))[0]!.restored_at).toBeNull();
    // The dry run left the key free: the live call under the SAME key restores, and its replay restores nothing more.
    const args = { version_id: v, snapshot_id: snap!.id, plan_hash: dry.plan_hash, idempotency_key: k };
    const live = await mcp(pool, w.u, 'restore_budget_version', args);
    expect(body(live)).toMatchObject({ restored: 3 });
    expect(await fx.cells(v)).toEqual(original);
    expect((await fx.audits(v)).length).toBe(audits + 1);
    expect((await reads.snapshots(v))[0]).toMatchObject({ restored_by: w.u.userId, restored_at: expect.any(Date) });
    expect(text(await mcp(pool, w.u, 'restore_budget_version', args))).toBe(text(live));
    expect((await fx.audits(v)).length).toBe(audits + 1);
    expect(text(await restore(v))).toMatch(/already restored; an earlier write cannot be restored/);
  });

  it('a later edit makes the restore refuse, naming the cells that differ; nothing changes', async () => {
    const v = await fx.version(w);
    const out = await write(v, [cell('BR-5000', w.months[0]!, '5.00'), cell('BR-5000', w.months[1]!, '6.00')]);
    const ui = await fx.call(w.u, { versionId: v, expectedUpdatedAt: out.version_token, cells: [{ glAccountId: w.rent, month: w.months[1]!, amount: 7 }] });
    expect(ui.status).toBe(200);
    const before = await fx.cells(v);
    const r = await mcp(pool, w.u, 'restore_budget_version', { version_id: v, dry_run: true, idempotency_key: key() });
    expect(text(r)).toMatch(/changed since that write.*1 of its 2 cells differ now/);
    expect(text(r)).toContain(w.months[1]!);
    expect(await fx.cells(v)).toEqual(before);
    expect((await reads.snapshots(v))[0]!.restored_at).toBeNull();
  });

  it('after two MCP writes, the older snapshot named explicitly is refused; the newer restores', async () => {
    const v = await fx.version(w);
    await write(v, [cell('BR-5000', w.months[0]!, '1.00'), cell('BR-5000', w.months[1]!, '1.00')]);
    await write(v, [cell('GS-4000', w.months[0]!, '2.00'), cell('GS-4000', w.months[1]!, '2.00')]);
    const [older, newer] = await reads.snapshots(v);
    expect(text(await restore(v, w.u, 'owner', { snapshot_id: older!.id }))).toMatch(/Only the most recent MCP write of this version can be restored/);
    expect(body(await restore(v, w.u, 'owner', { snapshot_id: newer!.id }))).toMatchObject({ restored: 2 });
    expect(text(await restore(v))).toMatch(/already restored/);
  });

  it('only the author, or an owner or admin, restores a write', async () => {
    const v = await fx.version(w);
    const author = await fx.member(w.u.homeCompanyId, 'manager');
    const other = await fx.member(w.u.homeCompanyId, 'manager');
    const admin = await fx.member(w.u.homeCompanyId, 'admin');
    await write(v, [cell('BR-5000', w.months[0]!, '3.00')], 'merge', author, 'manager');
    expect(text(await restore(v, other, 'manager'))).toMatch(/Only the person whose connection made that write, or an owner or admin/);
    expect(body(await restore(v, admin, 'admin'))).toMatchObject({ restored: 1 });
    await write(v, [cell('BR-5000', w.months[0]!, '4.00')], 'merge', author, 'manager');
    expect(body(await restore(v, author, 'manager'))).toMatchObject({ restored: 1 });
  });

  it('app_user cannot forge a stamp, rewrite, delete, or mark a snapshot restored outside a restore', async () => {
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
    expect(await asApp('UPDATE budget_write_snapshots SET restored_at = now() WHERE id = $1', [snap!.id])).toBe('23514');
  });
});
