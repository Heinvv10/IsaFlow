/**
 * The three-way MCP tools against a real database, through the real registry as app_user (MCP budget tools PR 3):
 *  - refusals (the company's flag off, a viewer's derive or write, a stale assumptions_token, a locked version, a
 *    money field sent as a number, an unknown key) leave the stored row, its token, the version token and the
 *    audit rows exactly as they were;
 *  - EQUIVALENCE: PUT budget-three-way/assumptions as a person against set_three_way_assumptions (dry run, then live)
 *    on a twin version: the same stored document, row author, untouched version token and audit rows, twice (an
 *    insert, then an update with the token); POST …/derive and GET /budget-three-way against derive_three_way and
 *    get_three_way: the same figures, as decimal text (the tools' only difference: rand text for cents).
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { defaultAssumptions } from '@/modules/accounting/services/budgets/threeWay/assumptionsDefaults';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { monthsFrom } from './helpers/budgetGridFixture';
import { budgetThreeWayFixture, dataOf, type ThreeWayCo } from './helpers/budgetThreeWayFixture';
import { body, mcp, mcpReads, text } from './helpers/mcpBudgetFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetThreeWayFixture(pool);
const reads = mcpReads(pool);
const FY = monthsFrom('2026-03');

let A: ThreeWayCo;
let off: ThreeWayCo;
beforeAll(async () => {
  A = await fx.company();
  off = await fx.company({ flag: false });
}, 120_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM mcp_tool_calls WHERE company_id = ANY($1)', [[A.id, off.id]]);
    await fx.cleanup();
  } finally { await pool.end(); }
}, 120_000);

const key = () => crypto.randomUUID();
/**
 * An INDEPENDENT conversion (review round 1, M3: not the tool's own converter): every number of a run section is cents
 * as rand text; for the evidence, the counts the test names are kept.
 */
const asRand = (x: unknown, keep: readonly string[] = []): unknown =>
  JSON.parse(JSON.stringify(x), (k, v) => (typeof v === 'number' && !keep.includes(k) ? (v / 100).toFixed(2) : v));
const doc = (capex: string | number = '1500.00', debtorDays = 45) => {
  const d = defaultAssumptions({ priorYearEnd: '2026-02', entityType: 'pty_ltd', vat: { registered: false, cadence: 'bi-monthly', alignment: 'odd', basis: 'invoice' } });
  d.workingCapital.debtorDays = { value: debtorDays, source: 'manual' };
  return { ...d, minimumCash: { value: '0.00', source: 'derived' }, capex: [{ id: 'cx1', month: FY[3]!, amountExVat: capex, vatClaimable: false, description: 'Laptop' }] };
};
/** The same document as the app sends it: cents. */
const appDoc = (cents = 150000, debtorDays = 45) => ({ ...doc(cents, debtorDays), minimumCash: { value: 0, source: 'derived' } });
const set = (c: ThreeWayCo, v: string, extra: Record<string, unknown>, role = 'owner') =>
  mcp(pool, role === 'viewer' ? c.viewer : c.owner, 'set_three_way_assumptions', { version_id: v, doc: doc(), assumptions_token: null, idempotency_key: key(), ...extra }, { role });
const sales = async (c: ThreeWayCo, v: string) => {
  for (const [i, m] of FY.entries()) {
    await pool.query(`INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount) VALUES ($1, $2, $3, $4, $5)`, [c.id, v, c.acct.sales, `${m}-01`, 1000 + i]);
  }
};
/** What the save's audit rows say, the version id left out (each version is its own row). */
const auditOf = async (v: string) => (await fx.state(v)).audits.map((a) => ({ action: a.action, fields: a.changes.fields, metadata: a.changes.metadata }));

describe('refusals write nothing', () => {
  it('the flag off: all three refused before any service', async () => {
    const v = await fx.version(off);
    const before = await fx.state(v);
    for (const [tool, args] of [['get_three_way', { version_id: v }], ['derive_three_way', { version_id: v }], ['set_three_way_assumptions', { version_id: v, doc: doc(), assumptions_token: null, idempotency_key: key() }]] as const) {
      expect(text(await mcp(pool, off.owner, tool, args))).toBe('The balance sheet and cash budget is not enabled for this company');
    }
    expect(await fx.state(v)).toEqual(before);
  });

  it('a viewer: the write fenced before the handler (audited rejected), derive refused as in the app', async () => {
    const v = await fx.version(A);
    const before = await fx.state(v);
    expect(text(await set(A, v, {}, 'viewer'))).toMatch(/only the owner, admin and manager roles/);
    expect(await reads.toolCalls(A.id, 'set_three_way_assumptions', A.viewer.userId)).toEqual([{ status: 'rejected', idempotency_key: null }]);
    expect(text(await mcp(pool, A.viewer, 'derive_three_way', { version_id: v }, { role: 'viewer', scopes: ['read:reports'] }))).toMatch(/owners, admins and managers/);
    expect(await fx.state(v)).toEqual(before);
  });

  it('money as a number, an unknown key, a stale token, a locked version: refused, nothing written', async () => {
    const v = await fx.version(A);
    body(await set(A, v, {}));
    const before = await fx.state(v);
    expect(text(await set(A, v, { doc: doc(1500), assumptions_token: before.row.token }))).toMatch(/capex\[0\]\.amountExVat: amounts are decimal strings/);
    expect(text(await set(A, v, { doc: { ...doc(), colour: 'red' }, assumptions_token: before.row.token }))).toMatch(/assumptions document is invalid: .*colour/i);
    expect(text(await set(A, v, { doc: doc('9.00'), assumptions_token: null }))).toMatch(new RegExp(`changed since you opened them.*assumptions_token is now ${before.row.token}`));
    expect(text(await set(A, v, { doc: doc('9.00'), assumptions_token: null, dry_run: true }))).toMatch(/The save would be refused: These assumptions changed/);
    expect(await fx.state(v)).toEqual(before);
    const locked = await fx.version(A, { status: 'locked' });
    const lockedBefore = await fx.state(locked);
    expect(text(await set(A, locked, {}))).toMatch(/This budget version is locked/);
    expect(await fx.state(locked)).toEqual(lockedBefore);
  });
});

describe('equivalence with the app', () => {
  it('PUT assumptions vs set_three_way_assumptions (insert, then update with the token): same row, author, version token, audit', async () => {
    const ui = await fx.version(A);
    const viaMcp = await fx.version(A);
    const uiBefore = await fx.state(ui);
    const first = await fx.routes.put(A.owner, { version_id: ui, doc: appDoc(), expected_updated_at: null });
    expect(first.status, JSON.stringify(first.body).slice(0, 300)).toBe(200);
    const dry = await set(A, viaMcp, { dry_run: true });
    expect(body(dry)).toMatchObject({ dry_run: true, previous: null });
    expect((await fx.state(viaMcp)).row).toBeNull();
    const live = body(await set(A, viaMcp, {}));
    const [u1, m1] = [await fx.state(ui), await fx.state(viaMcp)];
    expect(m1.row.doc).toEqual(u1.row.doc);
    expect(m1.row.updated_by).toBe(u1.row.updated_by);
    expect(live.assumptions_token).toBe(m1.row.token);
    expect([u1.versionToken, m1.versionToken !== '']).toEqual([uiBefore.versionToken, true]);
    expect(await auditOf(viaMcp)).toEqual(await auditOf(ui));

    const second = await fx.routes.put(A.owner, { version_id: ui, doc: appDoc(250000, 60), expected_updated_at: u1.row.token });
    expect(second.status).toBe(200);
    const again = body(await set(A, viaMcp, { doc: doc('2500.00', 60), assumptions_token: m1.row.token }));
    expect(again).toMatchObject({ changed_sections: ['capex', 'workingCapital'], previous: { capex: [{ amountExVat: '1500.00' }] } });
    expect((await fx.state(viaMcp)).row.doc).toEqual((await fx.state(ui)).row.doc);
    expect(await auditOf(viaMcp)).toEqual(await auditOf(ui));
  });

  it('POST derive and GET /budget-three-way vs derive_three_way and get_three_way: the same figures as decimal text', async () => {
    const v = await fx.version(A);
    await sales(A, v);
    body(await set(A, v, {}));
    const derived = await fx.routes.derive(A.owner, { version_id: v });
    expect(derived.status).toBe(200);
    const d = dataOf<{ assumptions: unknown; evidence: unknown }>(derived);
    const viaMcp = body(await mcp(pool, A.owner, 'derive_three_way', { version_id: v }));
    const da = d.assumptions as { capex: Array<{ amountExVat: number }>; minimumCash: { value: number }; workingCapital: unknown };
    const ma = viaMcp.assumptions as { capex: unknown[]; minimumCash: { value: string }; workingCapital: unknown };
    expect([ma.capex, ma.minimumCash.value, ma.workingCapital]).toEqual([asRand(da.capex, ['usefulLifeYears']), (da.minimumCash.value / 100).toFixed(2), da.workingCapital]);
    expect(viaMcp.evidence).toEqual(asRand(d.evidence, ['months', 'days']));

    const run = await fx.routes.index(A.owner, { version_id: v });
    expect(run.status).toBe(200);
    const r = dataOf<{ pnl: Array<{ turnover: number }>; balanceSheet: unknown; cashFlow: unknown; runway: unknown; assumptions: { resolved: unknown } }>(run);
    const tw = body(await mcp(pool, A.owner, 'get_three_way', { version_id: v }));
    expect(r.pnl[0]!.turnover).toBe(100000);
    expect((tw.pnl as Array<{ turnover: string }>)[0]!.turnover).toBe('1000.00');
    expect(tw.pnl).toEqual(asRand(r.pnl));
    expect(tw.balance_sheet).toEqual(asRand(r.balanceSheet));
    expect(tw.cash_flow).toEqual(asRand(r.cashFlow));
    expect(tw.runway).toEqual(asRand(r.runway));
    expect((tw.assumptions as { resolved: { capex: Array<{ amountExVat: string }> } }).resolved.capex[0]!.amountExVat).toBe('1500.00');
  });
});
