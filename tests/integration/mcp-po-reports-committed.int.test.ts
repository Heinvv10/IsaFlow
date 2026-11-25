/**
 * committed_spend (docs/design/mcp-po-reports.md, tests 1, 2 and 4), real PostgreSQL, through the real registry as app_user:
 *   - for every (account, month, budget-level slice) the tool's rows add up to budget_remaining's `committed`, to the cent, across partial
 *     bills, a header-only bill (#1703), a negative bill line, a PO closed by billing and then under-billed, a cancelled PO, a manual
 *     short-close, two POs on one account and month in different CC2, an off-slice line;
 *   - every group_by adds up to the ungrouped total; account-less lines are their own section;
 *   - another company's POs never appear, for a user who belongs to both companies, and not on a connection that bypasses RLS.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture } from './helpers/budgetBillFixture';
import { body, mcp, text } from './helpers/mcpBudgetFixture';
import { mkPo, seedWorld, type World } from './helpers/poReportsWorld';
import { als } from '@/lib/als';
import { committedSpendReport } from '@/modules/accounting/services/budgets/committedSpend';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let w: World;
let other: World;

beforeAll(async () => {
  w = await seedWorld(pool, 'po-rep-a');
  other = await seedWorld(pool, 'po-rep-b');
  // One person in both companies: the owner of A is also a member of B.
  await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner')", [other.f.co, w.f.owner]);
}, 120_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM company_users WHERE company_id = $1 AND user_id = $2', [other.f.co, w.f.owner]);
    for (const x of [w, other]) {
      await pool.query('DELETE FROM mcp_tool_calls WHERE company_id = $1', [x.f.co]);
      await dropBillFixture(pool, x.f);
    }
  } finally { await pool.end(); }
}, 120_000);

type Dim = { id: string; code?: string; name: string } | null;
interface Row { supplier?: Dim; cc1?: Dim; cc2?: Dim; bu?: Dim; account?: Dim; month?: string; committed: string; po_lines: number; pos: number }
interface Out { rows: Row[]; groups_total: number; next_offset: number | null; total: Money; no_account: Money; page_committed: string }
type Money = { committed: string; po_lines: number; pos: number };

const READ = { role: 'owner', scopes: ['read:reports'] };
const cents = (v: string) => Math.round(Number(v) * 100);
const spend = async (args: Record<string, unknown> = {}, u = w.u, opts = READ) =>
  body(await mcp(pool, u, 'committed_spend', { from_month: '2026-06', to_month: '2026-06', ...args }, opts)) as unknown as Out;
const remaining = async (lines: Array<Record<string, unknown>>) =>
  (body(await mcp(pool, w.u, 'budget_remaining', { lines }, READ)).lines as Array<Record<string, unknown>>);

describe('committed_spend equals budget_remaining committed, to the cent', () => {
  it('the cases add up to the figures worked by hand', async () => {
    const out = await spend({ group_by: ['account'] });
    const byCode = Object.fromEntries(out.rows.map((r) => [r.account!.code, r.committed]));
    // opex: partial 300-40 + closed-by-billing 400-150 + off-slice 90+60; travel: header 300-120 + negative (100 less 70 billed, + 100) + 200 + 300.
    expect(byCode).toEqual({ 'BB-6100': '660.00', 'BB-6200': '810.00' });
    expect(out.total).toEqual({ committed: '1470.00', po_lines: 10, pos: 7 });
    expect(out.no_account).toEqual({ committed: '55.00', po_lines: 1, pos: 1 });
  });

  it('per (account, month, slice) the rows sum to budget_remaining committed', async () => {
    const out = await spend({ group_by: ['account', 'month', 'cc1', 'cc2', 'bu'] });
    expect(out.rows.length).toBeGreaterThan(5);
    const asked = out.rows.map((r) => ({ account: r.account!.id, month: r.month, ...(r.cc1 ? { cc1: r.cc1.id } : {}), ...(r.cc2 ? { cc2: r.cc2.id } : {}), ...(r.bu ? { bu: r.bu.id } : {}) }));
    const answers = await remaining(asked);
    const bySlice = new Map<string, { summed: number; reported: number; rows: number }>();
    out.rows.forEach((r, i) => {
      const a = answers[i]!;
      const key = JSON.stringify([r.account!.id, r.month, a.grain, a.slice]);
      const cur = bySlice.get(key) ?? { summed: 0, reported: cents(String(a.committed)), rows: 0 };
      cur.summed += cents(r.committed);
      cur.rows += 1;
      expect(cents(String(a.committed)), `row ${i} reads one slice figure`).toBe(cur.reported);
      bySlice.set(key, cur);
    });
    expect(bySlice.size).toBeGreaterThan(3);
    for (const [key, v] of bySlice) expect(v.summed, key).toBe(v.reported);
    // Some slice holds more than one row: the CC2 split inside one CC1 / company slice is what the sum has to carry.
    expect([...bySlice.values()].some((v) => v.rows > 1)).toBe(true);
  });

  it('a cancelled PO, a short-close, a draft and a PO outside the months commit nothing', async () => {
    const out = await spend({ group_by: ['month'] });
    expect(out.rows).toEqual([expect.objectContaining({ month: '2026-06', committed: '1470.00' })]);
    const wide = await spend({ from_month: '2026-03', to_month: '2027-02', group_by: ['month'] });
    expect(wide.rows.map((r) => [r.month, r.committed])).toEqual([['2026-06', '1470.00'], ['2026-07', '80.00'], ['2027-01', '70.00']]);
  });

  it('the filters (supplier, account by code, cc2 by code) narrow the same figures', async () => {
    expect((await spend({ supplier_id: w.sup2, group_by: [] })).total.committed).toBe('300.00');
    expect((await spend({ account: 'BB-6100', group_by: [] })).total.committed).toBe('660.00');
    expect((await spend({ cc2: 'C2A', group_by: [] })).total.committed).toBe('590.00');
    expect((await spend({ cc2: 'C2A', account: 'BB-6200', supplier_id: w.f.supplier, group_by: [] })).total.committed).toBe('330.00');
  });
});

describe('group_by', () => {
  it.each([[['supplier']], [['cc2']], [['account']], [['cc1']], [['bu']], [['month']], [['supplier', 'cc2', 'account']], [['account', 'month', 'cc1', 'cc2', 'bu', 'supplier']], [[]]])(
    '%j adds up to the ungrouped total', async (group_by) => {
      const grouped = await spend({ group_by, limit: 200 });
      const flat = await spend({ group_by: [] });
      expect(grouped.next_offset).toBeNull();
      expect(grouped.rows.reduce((s, r) => s + cents(r.committed), 0)).toBe(cents(flat.total.committed));
      expect(grouped.rows.reduce((s, r) => s + r.po_lines, 0)).toBe(flat.total.po_lines);
      expect(grouped.total).toEqual(flat.total);
      expect(flat.rows).toHaveLength(1);
    });

  it('defaults to supplier, then cc2, then account; the account-less line is reported apart, not in a group', async () => {
    const out = await spend();
    expect(out.rows[0]).toHaveProperty('supplier');
    expect(out.rows[0]).toHaveProperty('cc2');
    expect(out.rows[0]).toHaveProperty('account');
    expect(out.rows.reduce((s, r) => s + cents(r.committed), 0)).toBe(147000);
    expect(out.no_account.committed).toBe('55.00');
    expect(out.rows.every((r) => r.account !== null)).toBe(true);
  });

  it('pages: next_offset walks every group once, in a fixed order', async () => {
    const all = await spend({ limit: 200 });
    const seen: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page: Out = await spend({ limit: 2, offset });
      expect(page.groups_total).toBe(all.groups_total);
      seen.push(...page.rows.map((r) => JSON.stringify(r)));
      offset = page.next_offset;
    }
    expect(seen).toEqual(all.rows.map((r) => JSON.stringify(r)));
  });
});

describe('refusals', () => {
  it('a viewer, a missing scope, a bad window and an account that is not the company\'s are refused', async () => {
    expect(text(await mcp(pool, w.u, 'committed_spend', { from_month: '2026-06', to_month: '2026-06' }, { role: 'viewer', scopes: ['read:reports'] }))).toMatch(/owners, admins and managers/);
    expect((await mcp(pool, w.u, 'committed_spend', { from_month: '2026-06', to_month: '2026-06' }, { role: 'owner', scopes: ['read:invoices'] })).isError).toBe(true);
    expect(text(await mcp(pool, w.u, 'committed_spend', { from_month: '2026-06', to_month: '2027-06' }, READ))).toMatch(/span at most 12 months/);
    expect(text(await mcp(pool, w.u, 'committed_spend', { from_month: '2026-07', to_month: '2026-06' }, READ))).toMatch(/from_month must not be after to_month/);
    expect(text(await mcp(pool, w.u, 'committed_spend', { from_month: '2026-06', to_month: '2026-06', group_by: ['colour'] }, READ))).toMatch(/group_by/);
    const theirs = text(await mcp(pool, w.u, 'committed_spend', { from_month: '2026-06', to_month: '2026-06', account: other.f.acc.opex }, READ));
    const nobody = text(await mcp(pool, w.u, 'committed_spend', { from_month: '2026-06', to_month: '2026-06', account: crypto.randomUUID() }, READ));
    expect(theirs.replace(/[0-9a-f-]{36}/, 'ID')).toBe(nobody.replace(/[0-9a-f-]{36}/, 'ID'));
  });

  it('a manager is admitted, as budget_remaining admits one', async () => {
    const mgr = { userId: w.f.manager, homeCompanyId: w.f.co, token: '' };
    expect((await spend({ group_by: [] }, mgr, { role: 'manager', scopes: ['read:reports'] })).total.committed).toBe('1470.00');
  });
});

describe('another company\'s POs never appear', () => {
  it('a user in both companies sees only the token company\'s POs, whichever company they ask from', async () => {
    const extra = await mkPo(pool, other.f, { month: '2026-06', lines: [{ acct: other.f.acc.travel, price: 7777 }] });
    expect(extra.items).toHaveLength(1);
    const mine = await spend({ group_by: ['supplier'] });
    expect(mine.total.committed).toBe('1470.00');
    expect(JSON.stringify(mine)).not.toContain(other.f.supplier);
    // The same person asking as the other company sees that company's figure (7777 more than its own world's 1470), not A's.
    const there = await spend({ group_by: [] }, { userId: w.f.owner, homeCompanyId: other.f.co, token: '' });
    expect(there.total.committed).toBe('9247.00');
    expect((await spend({ supplier_id: other.f.supplier, group_by: [] })).total.committed).toBe('0.00');
  });

  it('the service\'s own company predicate holds on a connection that bypasses RLS', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const run = <T>(companyId: string, fn: () => Promise<T>) => als.run({ client, companyId, userId: w.f.owner, claims: {} } as never, fn);
      const a = await run(w.f.co, () => committedSpendReport(w.f.co, { fromMonth: '2026-06', toMonth: '2026-06', groupBy: [] }));
      expect(a.total.cents).toBe(147000);
      const b = await run(w.f.co, () => committedSpendReport(w.f.co, { fromMonth: '2026-06', toMonth: '2026-06', groupBy: ['supplier'], supplierId: other.f.supplier }));
      expect(b.total.cents).toBe(0);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
});
