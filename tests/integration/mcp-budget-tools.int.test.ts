/**
 * The MCP budget tools against a real database, through the real registry as app_user (the bearer pipeline's
 * transaction shape): every refusal leaves the version, its amounts, its token and its audit rows exactly as
 * they were; an idempotent replay writes nothing twice; a dry run frees the key for the live call; a stale
 * token is refused cleanly; a viewer is fenced before the handler; only an owner's token approves, locks,
 * unlocks or sets primary; budget figures need read:reports.
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
let viewer: SetupUser;
let admin: SetupUser;

beforeAll(async () => {
  w = await fx.world();
  viewer = await fx.member(w.u.homeCompanyId, 'viewer');
  admin = await fx.member(w.u.homeCompanyId, 'admin');
}, 120000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM mcp_tool_calls WHERE company_id = $1', [w.u.homeCompanyId]);
    await fx.cleanup();
  } finally {
    await pool.end();
  }
}, 120000);

let seq = 0;
const key = () => `k-${++seq}-${crypto.randomUUID().slice(0, 8)}`;
const cell = (account: string, month: string, amount: string | null, dims: Record<string, string> = {}) => ({ account, month, amount, ...dims });
const state = async (v: string) => ({ cells: await fx.cells(v), token: await fx.token(v), audits: (await fx.audits(v)).length, snaps: (await reads.snapshots(v)).length });

describe('refusals write nothing', () => {
  it.each([
    ['an unknown account', () => cell('NOPE-1', w.months[1]!, '1'), /not an account of this company/],
    ['a header (decision 18)', () => cell('GS-6000', w.months[1]!, '1'), /header account/],
    ['an inactive account with no amounts', () => cell('GS-6900', w.months[1]!, '1'), /inactive/],
    ['a balance-sheet account', () => cell('GS-1000', w.months[1]!, '1'), /not a revenue or expense account/],
    ['two dimensions (decision 14)', () => cell('BR-5000', w.months[1]!, '1', { cc1: 'GS-C1', bu: 'GS-BU' }), /at most one dimension/],
    ['a month outside the year', () => cell('BR-5000', '1999-01', '1'), /not a month of FY/],
    ['three decimals', () => cell('BR-5000', w.months[1]!, '1.005'), /at most 2 decimals/],
  ])('%s: refused per row in the dry run and by the live call', async (_n, bad, why) => {
    const v = await fx.version(w);
    await fx.amount(w, v, w.rent, w.months[0]!, 10);
    const before = await state(v);
    const cells = [cell('BR-5000', w.months[2]!, '5.00'), bad()];
    const dry = body(await mcp(pool, w.u, 'set_budget_amounts', { version_id: v, cells, dry_run: true, idempotency_key: key() }));
    expect(dry.ready).toBe(false);
    expect(JSON.stringify(dry.cells)).toMatch(why);
    const live = await mcp(pool, w.u, 'set_budget_amounts', { version_id: v, cells, version_token: dry.version_token, idempotency_key: key() });
    expect(live.isError).toBe(true);
    expect(text(live)).toMatch(/refused, so nothing was written/);
    expect(await state(v)).toEqual(before);
  });

  it('decision 4: a cell at another level than the account holds is refused by the save (dry run and live)', async () => {
    const v = await fx.version(w);
    await fx.amount(w, v, w.rent, w.months[0]!, 10);
    const before = await state(v);
    const args = { version_id: v, cells: [cell('BR-5000', w.months[1]!, '7', { cc1: 'GS-C1' })] };
    // The save's own check answers, naming the account (the exclusion constraint is only its backstop).
    expect(text(await mcp(pool, w.u, 'set_budget_amounts', { ...args, dry_run: true, idempotency_key: key() }))).toMatch(/would be refused: Account BR-5000 Rent is budgeted at one level per version/);
    expect(text(await mcp(pool, w.u, 'set_budget_amounts', { ...args, idempotency_key: key() }))).toMatch(/^Account BR-5000 Rent is budgeted at one level per version/);
    expect(await state(v)).toEqual(before);
  });

  it("another company's version id is the shared Not found", async () => {
    const theirs = await fx.world();
    const v = await fx.version(theirs);
    expect(text(await mcp(pool, w.u, 'set_budget_amounts', { version_id: v, cells: [cell('BR-5000', w.months[0]!, '1')], idempotency_key: key() }))).toBe('Not found');
    expect(text(await mcp(pool, w.u, 'get_budget', { version_id: v }))).toBe('Not found');
  });
});

describe('idempotency, dry run and the version token', () => {
  it('dry run frees the key; the live call with the same key writes once; a replay of it writes nothing more', async () => {
    const v = await fx.version(w);
    const k = key();
    const cells = [cell('BR-5000', w.months[0]!, '100.10'), cell('GS-4000', w.months[0]!, '-20.00')];
    const dry = body(await mcp(pool, w.u, 'set_budget_amounts', { version_id: v, cells, dry_run: true, idempotency_key: k }));
    expect(await state(v)).toMatchObject({ cells: [], audits: 0, snaps: 0 });
    const args = { version_id: v, cells, version_token: dry.version_token, idempotency_key: k };
    const first = await mcp(pool, w.u, 'set_budget_amounts', args);
    expect(body(first)).toMatchObject({ saved: 2, deleted: 0 });
    const after = await state(v);
    expect(after).toMatchObject({ audits: 1, snaps: 1 });
    const replay = await mcp(pool, w.u, 'set_budget_amounts', args);
    expect(text(replay)).toBe(text(first));
    expect(await state(v)).toEqual(after);
    expect((await reads.toolCalls(w.u.homeCompanyId, 'set_budget_amounts')).filter((c) => c.idempotency_key === k)).toEqual([{ status: 'ok', idempotency_key: k }]);
  });

  it('a save landing after the dry run makes the live call refuse: "budget changed since your dry run"; nothing of it is written', async () => {
    const v = await fx.version(w);
    const cells = [cell('BR-5000', w.months[0]!, '1'), cell('BR-5000', w.months[1]!, '2')];
    const dry = body(await mcp(pool, w.u, 'set_budget_amounts', { version_id: v, cells, dry_run: true, idempotency_key: key() }));
    const ui = await fx.call(w.u, { versionId: v, expectedUpdatedAt: dry.version_token, cells: [{ glAccountId: w.sales, month: w.months[3]!, amount: 9 }] });
    expect(ui.status).toBe(200);
    const before = await state(v);
    const r = await mcp(pool, w.u, 'set_budget_amounts', { version_id: v, cells, version_token: dry.version_token, idempotency_key: key() });
    expect(text(r)).toMatch(/changed since your dry run.*Dry-run again/);
    expect(await state(v)).toEqual(before);
  });

  it('a bulk live write without the token is refused', async () => {
    const v = await fx.version(w);
    const r = await mcp(pool, w.u, 'set_budget_amounts', { version_id: v, cells: [cell('BR-5000', w.months[0]!, '1'), cell('BR-5000', w.months[1]!, '1')], idempotency_key: key() });
    expect(text(r)).toMatch(/version_token is required/);
  });
});

describe('who may call', () => {
  it('a viewer is fenced by the registry before the handler: nothing written, the call audited rejected', async () => {
    const v = await fx.version(w);
    const k = key();
    const r = await mcp(pool, viewer, 'set_budget_amounts', { version_id: v, cells: [cell('BR-5000', w.months[0]!, '1')], idempotency_key: k }, { role: 'viewer' });
    expect(text(r)).toMatch(/only the owner, admin and manager roles/);
    expect(await state(v)).toMatchObject({ cells: [], audits: 0 });
  });

  it.each(['approve_budget_version', 'lock_budget_version', 'unlock_budget_version', 'set_primary_budget_version'])('%s: an admin token is told a person must approve; nothing moves', async (tool) => {
    const v = await fx.version(w, { status: tool === 'unlock_budget_version' ? 'locked' : tool === 'lock_budget_version' ? 'approved' : 'draft' });
    const before = await reads.status(v);
    const r = await mcp(pool, admin, tool, { version_id: v, reason: 'r', idempotency_key: key() }, { role: 'admin' });
    expect(text(r)).toBe('A person must approve this budget in IsaFlow');
    expect(await reads.status(v)).toBe(before);
  });

  it('the owner approves, locks, unlocks (with a reason) and sets primary through the app services', async () => {
    const v = await fx.version(w);
    expect(body(await mcp(pool, w.u, 'approve_budget_version', { version_id: v, idempotency_key: key() }))).toMatchObject({ version: { status: 'approved' } });
    expect(body(await mcp(pool, w.u, 'lock_budget_version', { version_id: v, idempotency_key: key() }))).toMatchObject({ version: { status: 'locked' } });
    expect(text(await mcp(pool, w.u, 'unlock_budget_version', { version_id: v, reason: '   ', idempotency_key: key() }))).toMatch(/needs a reason/);
    expect(body(await mcp(pool, w.u, 'unlock_budget_version', { version_id: v, reason: 'Board asked for a change', idempotency_key: key() })))
      .toMatchObject({ version: { status: 'approved', unlock_reason: 'Board asked for a change', unlocked_by: w.u.userId } });
    expect(body(await mcp(pool, w.u, 'set_primary_budget_version', { version_id: v, idempotency_key: key() }))).toMatchObject({ version: { is_primary: true } });
    const actions = (await fx.audits(v)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['approve', 'update']));
  });
});

describe('figures need read:reports', () => {
  it('get_budget is refused without read:reports; a write dry run shows no amount', async () => {
    const v = await fx.version(w);
    await fx.amount(w, v, w.rent, w.months[0]!, 4321.5);
    expect(text(await mcp(pool, w.u, 'get_budget', { version_id: v }, { scopes: ['write:budgets'] }))).toMatch(/requires read:reports/);
    const dry = body(await mcp(pool, w.u, 'set_budget_amounts', { version_id: v, cells: [cell('BR-5000', w.months[0]!, '1234.00')], dry_run: true, idempotency_key: key() }, { scopes: ['write:budgets'] }));
    expect(JSON.stringify(dry)).not.toMatch(/4321|1234/);
    expect(dry.figures_hidden).toMatch(/read:reports/);
    const read = body(await mcp(pool, w.u, 'get_budget', { version_id: v }));
    expect(read.rows).toEqual([expect.objectContaining({ account: 'BR-5000', months: { [w.months[0]!]: '4321.50' }, total: '4321.50' })]);
  });
});
