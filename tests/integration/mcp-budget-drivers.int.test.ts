/**
 * set_budget_drivers and get_budget_drivers against a real database, through the real registry as app_user:
 *  - every refusal (shape per change, decision 14, decision 4 by the app's own driver check, a loop, a locked
 *    version, a stale token, a moved plan, a holder outside their slice) leaves cells, drivers, hires, token,
 *    audit rows and snapshots exactly as they were;
 *  - a viewer is fenced before the handler (audited rejected); the dry run frees the key, the live call writes
 *    once, its replay writes nothing more;
 *  - a live write records a set_budget_drivers snapshot of every changed cell (recomputed dependents included)
 *    and one audit row per change as the token user;
 *  - get_budget_drivers: per_head rates for budget writers only (#979).
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetDriverRouteFixture, type DriverWorld } from './helpers/budgetDriverRouteFixture';
import type { SetupUser } from './helpers/onboardingSetupFixture';
import { body, mcp, mcpBatch, mcpReads, text } from './helpers/mcpBudgetFixture';

/** Review round 1 (M1): a hire service that refuses on demand AFTER the dry run, so a live call is refused at its second change. */
const failHire = vi.hoisted(() => ({ on: false }));
vi.mock('@/modules/accounting/services/budgets/drivers/plannedHireService', async (orig) => {
  const real = await orig<typeof import('@/modules/accounting/services/budgets/drivers/plannedHireService')>();
  const { BudgetVersionError } = await import('@/modules/accounting/services/budgets/budgetVersionTypes');
  return { ...real, createHire: async (...a: Parameters<typeof real.createHire>) => {
    if (failHire.on) throw new BudgetVersionError('BUDGET_VERSION_LOCKED', 'This budget version is locked');
    return real.createHire(...a);
  } };
});

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetDriverRouteFixture(pool);
const reads = mcpReads(pool);

let w: DriverWorld;
let viewer: SetupUser;
let manager: SetupUser;

beforeAll(async () => {
  w = await fx.world();
  viewer = await fx.member(w.u.homeCompanyId, 'viewer');
  manager = await fx.member(w.u.homeCompanyId, 'manager');
}, 120_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM mcp_tool_calls WHERE company_id = $1', [w.u.homeCompanyId]);
    await pool.query('DELETE FROM budget_slice_reviews WHERE company_id = $1', [w.u.homeCompanyId]);
    await pool.query('DELETE FROM budget_holders WHERE company_id = $1', [w.u.homeCompanyId]);
    await pool.query('DELETE FROM user_notifications WHERE company_id = $1', [w.u.homeCompanyId]);
    await fx.cleanup();
  } finally { await pool.end(); }
}, 120_000);

let seq = 0;
const key = () => `kd-${++seq}-${crypto.randomUUID().slice(0, 8)}`;
const state = async (v: string) => ({ ...(await fx.state(v)), snaps: (await reads.snapshots(v)).length });
const cogs = (over: Record<string, unknown> = {}) => ({
  op: 'set_driver', account: 'GS-5100', kind: 'pct_of_line', pct: 38, from_month: w.months[0], to_month: w.months[11], ref: { account: 'GS-4000' }, ...over,
});
/** A version with Sales 1 000 in months 0-2 (written directly). */
async function salesVersion(opts: { locked?: boolean } = {}): Promise<string> {
  const v = await fx.version(w);
  for (const m of w.months.slice(0, 3)) await fx.amount(w, v, w.sales, m, 1000);
  if (opts.locked) {
    await pool.query(`UPDATE budget_versions SET status = 'approved', approved_by = $2, approved_at = clock_timestamp() WHERE id = $1`, [v, w.u.userId]);
    await pool.query(`UPDATE budget_versions SET status = 'locked', locked_by = $2, locked_at = clock_timestamp() WHERE id = $1`, [v, w.u.userId]);
  }
  return v;
}
const dry = async (v: string, changes: unknown[], u: SetupUser = w.u, role = 'owner') =>
  mcp(pool, u, 'set_budget_drivers', { version_id: v, changes, dry_run: true, idempotency_key: key() }, { role });
async function apply(v: string, changes: unknown[]) {
  const d = body(await dry(v, changes));
  return mcp(pool, w.u, 'set_budget_drivers', { version_id: v, changes, plan_hash: d.plan_hash, idempotency_key: key() });
}

describe('refusals write nothing', () => {
  it.each([
    ['an unknown account', () => cogs({ account: 'NOPE-1' }), /not an account of this company/],
    ['two dimensions (decision 14)', () => cogs({ cc1: 'GS-C1', bu: 'GS-BU' }), /at most one dimension/],
    ['a header', () => cogs({ account: 'GS-6000' }), /header account/],
    ['an amount as a number', () => ({ op: 'set_driver', account: 'BR-5000', kind: 'fixed', amount: 10, from_month: w.months[0], to_month: w.months[1] }), /decimal strings/],
    ['a hire with no month', () => ({ op: 'add_hire', label: 'Rep' }), /start_month must be YYYY-MM/],
  ])('%s: listed by the dry run, refused live', async (_n, bad, why) => {
    const v = await salesVersion();
    const before = await state(v);
    const d = body(await dry(v, [bad()]));
    expect([d.ready, JSON.stringify(d.refusals)]).toEqual([false, expect.stringMatching(why)]);
    expect(text(await mcp(pool, w.u, 'set_budget_drivers', { version_id: v, changes: [bad()], plan_hash: 'a'.repeat(64), idempotency_key: key() })))
      .toMatch(/refused, so nothing was written/);
    expect(await state(v)).toEqual(before);
  });

  it('decision 4: a second driver of the account at another level is refused by the app\'s driver check (not the database backstop)', async () => {
    const v = await salesVersion();
    expect((await apply(v, [cogs()])).isError).toBeUndefined();
    const before = await state(v);
    expect(text(await dry(v, [cogs({ cc1: 'GS-C1' })]))).toMatch(/would be refused: change 0 \(set_driver\): Account GS-5100 Cost of sales already has a driver at another level in this version/);
    expect(await state(v)).toEqual(before);
  });

  it('a loop through the row is refused with its path; a locked version is refused', async () => {
    const v = await salesVersion();
    expect((await apply(v, [cogs()])).isError).toBeUndefined();
    const before = await state(v);
    const loop = { op: 'set_driver', account: 'GS-4000', kind: 'pct_of_line', pct: 10, from_month: w.months[0], to_month: w.months[11], ref: { account: 'GS-5100' } };
    expect(text(await dry(v, [loop]))).toMatch(/This driver makes a loop: GS-4000 Sales .*GS-5100 Cost of sales/);
    expect(await state(v)).toEqual(before);
    const locked = await salesVersion({ locked: true });
    const lockedBefore = await state(locked);
    expect(text(await dry(locked, [cogs()]))).toMatch(/would be refused: change 0 \(set_driver\): .*locked/);
    expect(await state(locked)).toEqual(lockedBefore);
  });

  it('a stale version_token, a missing or moved plan_hash: nothing written', async () => {
    const v = await salesVersion();
    const d = body(await dry(v, [cogs()]));
    const before = await state(v);
    const live = (extra: Record<string, unknown>) => mcp(pool, w.u, 'set_budget_drivers', { version_id: v, changes: [cogs()], idempotency_key: key(), ...extra });
    expect(text(await live({}))).toMatch(/plan_hash is required/);
    expect(text(await live({ plan_hash: d.plan_hash, version_token: '2020-01-01T00:00:00.000001Z' }))).toMatch(/its version_token moved/);
    expect(text(await live({ plan_hash: body(await dry(v, [cogs({ pct: 39 })])).plan_hash }))).toMatch(/plan changed since your dry run/);
    // A save between the dry run and the apply moves the plan (the hash binds the cells it starts from).
    await fx.call.save(w.u, v, [{ glAccountId: w.sales, month: w.months[5], amount: 7 }]);
    const moved = await state(v);
    expect(text(await live({ plan_hash: d.plan_hash }))).toMatch(/plan changed/);
    expect(await state(v)).toEqual(moved);
    expect(moved.cells.length).toBe(before.cells.length + 1);
  });

  it('a budget holder\'s driver outside their slice is refused by the slice check, naming the driver', async () => {
    const v = await salesVersion();
    await pool.query(`INSERT INTO budget_holders (company_id, version_id, user_id, cc1_id, created_by) VALUES ($1, $2, $3, $4, 'x')`, [w.u.homeCompanyId, v, manager.userId, w.cc1]);
    await pool.query(`INSERT INTO budget_slice_reviews (company_id, version_id, cc1_id, created_by) VALUES ($1, $2, $3, 'x')`, [w.u.homeCompanyId, v, w.cc1]);
    const before = await state(v);
    const r = await mcp(pool, manager, 'set_budget_drivers', { version_id: v, changes: [{ op: 'set_driver', account: 'GS-6100', kind: 'fixed', amount: '5.00', from_month: w.months[0], to_month: w.months[1] }], dry_run: true, idempotency_key: key() }, { role: 'manager' });
    expect(text(r)).toMatch(/would be refused: change 0 \(set_driver\): The driver on GS-6100 Stationery is outside your budget slices; ask an owner or admin to change it/);
    expect(await state(v)).toEqual(before);
  });
});

describe('the plan_hash inside one transaction', () => {
  it('binds the version status (review round 1, F3): an approve between dry run and apply, same token, refuses the apply', async () => {
    const v = await salesVersion();
    const before = await state(v);
    const out = await mcpBatch(pool, w.u, [
      () => ['set_budget_amounts', { version_id: v, cells: [{ account: 'GS-4000', month: w.months[0], amount: '1100.00' }], idempotency_key: key() }],
      () => ['set_budget_drivers', { version_id: v, changes: [cogs()], dry_run: true, idempotency_key: key() }],
      () => ['approve_budget_version', { version_id: v, idempotency_key: key() }],
      (b) => ['set_budget_drivers', { version_id: v, changes: [cogs()], plan_hash: body(b[1]!).plan_hash, idempotency_key: key() }],
    ]);
    expect((body(out[2]!).version as { version_token: string }).version_token).toBe(body(out[1]!).version_token);
    expect(text(out[3]!)).toMatch(/plan changed since your dry run/);
    expect((await fx.state(v)).drivers).toEqual(before.drivers);
  });

  it('a refusal at the SECOND change rolls the first one back (the registry savepoint): nothing kept (review round 1, M1)', async () => {
    const v = await salesVersion();
    const changes = [cogs(), { op: 'add_hire', label: 'Rep', start_month: w.months[0] }];
    const d = body(await dry(v, changes));
    const before = await state(v);
    failHire.on = true;
    try {
      const r = await mcp(pool, w.u, 'set_budget_drivers', { version_id: v, changes, plan_hash: d.plan_hash, idempotency_key: key() });
      expect(text(r)).toBe('Change 1 (add_hire) was refused: This budget version is locked. Nothing was written: a call is all or nothing (the earlier changes were rolled back).');
    } finally { failHire.on = false; }
    expect(await state(v)).toEqual(before);
  });

  it('a percent past 4 decimals and an FTE past 2 are refused by the services, never rounded', async () => {
    const v = await salesVersion();
    const before = await state(v);
    expect(text(await dry(v, [cogs({ pct: 38.12345 })]))).toMatch(/would be refused: change 0 \(set_driver\): .*at most 4 decimals/);
    expect(text(await dry(v, [{ op: 'add_hire', label: 'Rep', start_month: w.months[0], fte: 1.234 }]))).toMatch(/would be refused: change 0 \(add_hire\): FTE must be .*at most 2 decimals/);
    expect(await state(v)).toEqual(before);
  });

  it('inside one transaction (the token cannot move) the plan_hash still binds the cells: a save between dry run and apply refuses it', async () => {
    const v = await salesVersion();
    const before = await state(v);
    const sales = (amount: string) => ['set_budget_amounts', { version_id: v, cells: [{ account: 'GS-4000', month: w.months[0], amount }], idempotency_key: key() }] as [string, Record<string, unknown>];
    const out = await mcpBatch(pool, w.u, [
      () => sales('1100.00'),
      () => ['set_budget_drivers', { version_id: v, changes: [cogs()], dry_run: true, idempotency_key: key() }],
      () => sales('1200.00'),
      (b) => ['set_budget_drivers', { version_id: v, changes: [cogs()], plan_hash: body(b[1]!).plan_hash, idempotency_key: key() }],
    ]);
    expect(body(out[2]!).version_token).toBe(body(out[1]!).version_token);
    expect(text(out[3]!)).toMatch(/plan changed since your dry run/);
    expect((await fx.state(v)).drivers).toEqual(before.drivers);
  });
});

describe('who may call, keys, replays', () => {
  it('a viewer is fenced before the handler: nothing written, audited rejected', async () => {
    const v = await salesVersion();
    const before = await state(v);
    const r = await mcp(pool, viewer, 'set_budget_drivers', { version_id: v, changes: [cogs()], dry_run: true, idempotency_key: key() }, { role: 'viewer' });
    expect(text(r)).toMatch(/only the owner, admin and manager roles/);
    expect(await state(v)).toEqual(before);
    expect(await reads.toolCalls(w.u.homeCompanyId, 'set_budget_drivers', viewer.userId)).toEqual([{ status: 'rejected', idempotency_key: null }]);
  });

  it('the dry run frees the key; the live call with that key writes once; its replay writes nothing more', async () => {
    const v = await salesVersion();
    const k = key();
    const d = body(await mcp(pool, w.u, 'set_budget_drivers', { version_id: v, changes: [cogs()], dry_run: true, idempotency_key: k }));
    const args = { version_id: v, changes: [cogs()], plan_hash: d.plan_hash, idempotency_key: k };
    const first = await mcp(pool, w.u, 'set_budget_drivers', args);
    expect(body(first)).toMatchObject({ restorable: false, counts: { added: 12 } });
    const after = await state(v);
    const replay = await mcp(pool, w.u, 'set_budget_drivers', args);
    expect(text(replay)).toBe(text(first));
    expect(await state(v)).toEqual(after);
  });
});

describe('what a live write leaves', () => {
  it('the dry run lists the recomputed cells; the live write leaves exactly them, one audit row per change, a snapshot of every changed cell', async () => {
    const v = await salesVersion();
    const changes = [cogs(), { op: 'add_hire', label: 'Sales rep', start_month: w.months[3], fte: 1.5, cost_centre: 'GS-C1' }];
    const d = body(await dry(v, changes));
    expect(d).toMatchObject({ ready: true, counts: { added: 12, changed: 0, removed: 0 } });
    expect(await state(v)).toMatchObject({ audits: 0, snaps: 0 });
    const live = body(await mcp(pool, w.u, 'set_budget_drivers', { version_id: v, changes, plan_hash: d.plan_hash, idempotency_key: key() }));
    expect(live.cells).toEqual(d.cells);
    const cells = await fx.cells(v);
    expect(cells.filter((c) => c.startsWith(w.cogs))).toHaveLength(12);
    expect(cells.find((c) => c.startsWith(`${w.cogs}||||${w.months[0]}`))).toBe(`${w.cogs}||||${w.months[0]}=380.00:driver`);
    const audits = await fx.audits(v);
    expect(audits.map((a) => a.changes.metadata?.driverAction)).toEqual(['driver_saved', 'hire_created']);
    const snaps = await reads.snapshots(v);
    expect(snaps).toHaveLength(1);
    expect([snaps[0]!.tool, snaps[0]!.cells.length, snaps[0]!.created_by]).toEqual(['set_budget_drivers', 12, w.u.userId]);
    const versions = body(await mcp(pool, w.u, 'list_budget_versions', { fiscal_year: w.label }));
    expect((versions.items as Array<{ id: string; last_edit: { by: string } }>).find((x) => x.id === v)?.last_edit.by).toBe(w.u.userId);
  });
});

describe('get_budget_drivers', () => {
  it('a per_head rate for budget writers only; a viewer gets the line without it and no headcount counts', async () => {
    const v = await salesVersion();
    const perHead = { op: 'set_driver', account: 'BR-5000', kind: 'per_head', amount: '41666.67', headcount_cost_centre: 'GS-C1', from_month: w.months[0], to_month: w.months[11] };
    expect((await apply(v, [perHead])).isError).toBeUndefined();
    const asViewer = body(await mcp(pool, viewer, 'get_budget_drivers', { version_id: v }, { role: 'viewer', scopes: ['read:reports'] }));
    expect(asViewer.drivers).toEqual([expect.objectContaining({ kind: 'per_head', per_head_restricted: true })]);
    expect(JSON.stringify(asViewer)).not.toMatch(/41666/);
    expect(asViewer.headcount).toMatchObject({ per_head_restricted: true });
    const asManager = body(await mcp(pool, manager, 'get_budget_drivers', { version_id: v }, { role: 'manager', scopes: ['read:reports'] }));
    expect(asManager.drivers).toEqual([expect.objectContaining({ kind: 'per_head', amount: '41666.67', headcount_cost_centre: 'GS-C1' })]);
    expect((asManager.headcount as { months: unknown[] }).months).toHaveLength(12);
  });

  it('a batch: set_budget_amounts then set_budget_drivers in one transaction; restore of the amount write is refused (drivers changed)', async () => {
    const v = await salesVersion();
    const cells = [{ account: 'BR-5000', month: w.months[0], amount: '10.00' }];
    const hire = [{ op: 'add_hire', label: 'Clerk', start_month: w.months[0] }];
    const out = await mcpBatch(pool, w.u, [
      () => ['set_budget_amounts', { version_id: v, cells, idempotency_key: key() }],
      () => ['set_budget_drivers', { version_id: v, changes: hire, dry_run: true, idempotency_key: key() }],
      (b) => ['set_budget_drivers', { version_id: v, changes: hire, plan_hash: body(b[1]!).plan_hash, idempotency_key: key() }],
      () => ['restore_budget_version', { version_id: v, dry_run: true, idempotency_key: key() }],
    ]);
    // The hire changed no cell (no per_head driver): no driver snapshot, and the token cannot move inside one transaction.
    expect(body(out[2]!).snapshot_id).toBeNull();
    expect(text(out[3]!)).toMatch(/The drivers of this version changed since that write/);
  });
});
