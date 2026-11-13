/** Adversarial round 2 (breaker). Throwaway. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { defaultAssumptions } from '@/modules/accounting/services/budgets/threeWay/assumptionsDefaults';
import type { ThreeWayView } from '@/modules/accounting/services/budgets/threeWay/threeWayViews';
import { readOpening } from '@/modules/accounting/services/budgets/threeWay/openingBalances';
import { getBalanceSheet, getEquityBases } from '@/modules/accounting/services/reports/balanceSheetService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetThreeWayFixture, code, dataOf, details, type RouteOut, type ThreeWayCo } from './helpers/budgetThreeWayFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetThreeWayFixture(pool);
const dump = (r: RouteOut) => JSON.stringify(r.body).slice(0, 600);
const fullDoc = () => defaultAssumptions({ priorYearEnd: '2026-02', entityType: 'pty_ltd', vat: { registered: false, cadence: 'bi-monthly', alignment: 'odd', basis: 'invoice' } });
const tokenOf = (r: RouteOut) => String((r.body.data as { updatedAt: string }).updatedAt);

let A: ThreeWayCo;
const acct = async (c: ThreeWayCo, code: string, type: string, subtype: string | null, level: number, opts: { parent?: string; active?: boolean } = {}) => String((await pool.query(
  `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, level, is_active, parent_account_id)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
  [c.id, code, `acct ${code}`, type, subtype, type === 'asset' || type === 'expense' ? 'debit' : 'credit', level, opts.active ?? true, opts.parent ?? null])).rows[0].id);

beforeAll(async () => { A = await fx.company(); }, 90000);
afterAll(async () => { try { await fx.cleanup(); } finally { await pool.end(); } });

describe('opening parity on a hostile chart', () => {
  it('totals and equity equal getBalanceSheet / getEquityBases', async () => {
    const h1 = await acct(A, '2550', 'liability', null, 1);                         // level-1 header with a child
    const c2 = await acct(A, '2551', 'liability', null, 2, { parent: h1 });        // level-2 leaf
    const h3 = await acct(A, '1550', 'asset', 'fixed_asset', 3);                    // level-3 with a level-4 child: both count
    const c4 = await acct(A, '1551', 'asset', 'fixed_asset', 4, { parent: h3 });
    const inact = await acct(A, '1650', 'asset', null, 3, { active: false });
    const revH = await acct(A, '4950', 'revenue', null, 1);                          // revenue header, still in derived RE
    await acct(A, '4951', 'revenue', null, 2, { parent: revH });
    const eqH = await acct(A, '3950', 'equity', null, 1);                            // equity header: in posted, not in BS lines
    await acct(A, '3951', 'equity', null, 2, { parent: eqH });
    await fx.journal(A, '2026-01-05', [{ acct: h1, credit: 1111.11 }]);
    await fx.journal(A, '2026-01-06', [{ acct: c2, credit: 222.22 }]);
    await fx.journal(A, '2026-01-07', [{ acct: h3, debit: 3333.33 }, { acct: c4, debit: 444.44 }]);
    await fx.journal(A, '2026-01-08', [{ acct: inact, debit: 55.55 }]);
    await fx.journal(A, '2026-01-09', [{ acct: revH, credit: 666.66 }]);
    await fx.journal(A, '2026-01-10', [{ acct: eqH, credit: 77.77 }]);
    await fx.journal(A, '2026-02-28', [{ acct: A.acct.sales, debit: 9999 }, { acct: A.re, credit: 9999 }], { source: 'year_end' });
    await fx.journal(A, '2026-02-28', [{ acct: A.capital, credit: 88.88 }]);
    const res = await fx.direct(A, async () => {
      const o = await readOpening(A.id, '2026-03', '2026-11-13');
      const bs = await getBalanceSheet(A.id, o.asAt);
      const eb = await getEquityBases(A.id, o.asAt);
      return { o, bs, eb };
    });
    const c = (r: number) => Math.round(r * 100);
    process.stderr.write(`P totals=${JSON.stringify(res.o.totals)} bs=${c(res.bs.totalAssets)},${c(res.bs.totalLiabilities)},${c(res.bs.totalEquity)} eq=${JSON.stringify(res.o.equity)} eb=${c(res.eb.posted)},${c(res.eb.derivedRetainedEarnings)}\n`);
    expect(res.o.totals).toEqual({ assets: c(res.bs.totalAssets), liabilities: c(res.bs.totalLiabilities), equity: c(res.bs.totalEquity) });
    expect(res.o.equity).toEqual({ posted: c(res.eb.posted), derivedRetainedEarnings: c(res.eb.derivedRetainedEarnings) });
  });
});

describe('tolerant overwrite of an invalid stored doc', () => {
  let v: string; let tok: string;
  beforeAll(async () => {
    v = await fx.version(A, { kind: 'reforecast' });
    const r = await fx.routes.put(A.owner, { version_id: v, doc: fullDoc(), expected_updated_at: null });
    expect(r.status).toBe(200);
    await pool.query(`UPDATE budget_three_way_assumptions SET doc = '{"schemaVersion":1,"legacyField":{"secret":"old figures 12345"}}' WHERE version_id = $1`, [v]);
    tok = String((await fx.state(v)).row.token);
  });
  it('GET of the broken doc is a typed 4xx, never 500', async () => {
    const g = await fx.routes.getAssumptions(A.owner, v);
    const i = await fx.routes.index(A.owner, { version_id: v });
    process.stderr.write(`T get=${g.status} ${code(g)} index=${i.status} ${code(i)}\n`);
    expect(g.status).toBeLessThan(500); expect(i.status).toBeLessThan(500);
  });
  it('null token and a wrong token are still 409; nothing written', async () => {
    const a1 = (await fx.state(v)).audits.length;
    const n = await fx.routes.put(A.owner, { version_id: v, doc: fullDoc(), expected_updated_at: null });
    expect(n.status).toBe(409);
    expect(details(n).currentUpdatedAt).toBe(tok);
    const w = await fx.routes.put(A.owner, { version_id: v, doc: fullDoc(), expected_updated_at: '2020-01-01T00:00:00.000000Z' });
    expect(w.status).toBe(409);
    expect((await fx.state(v)).audits.length).toBe(a1);
  });
  it('a viewer cannot use it; an overrides doc on a non-scenario still refused', async () => {
    expect((await fx.routes.put(A.viewer, { version_id: v, doc: fullDoc(), expected_updated_at: tok })).status).toBe(403);
    expect((await fx.routes.put(A.owner, { version_id: v, doc: { schemaVersion: 1, overrides: {} }, expected_updated_at: tok })).status).toBe(400);
  });
  it('the right token overwrites with one audit row that keeps the replaced document', async () => {
    const r = await fx.routes.put(A.owner, { version_id: v, doc: fullDoc(), expected_updated_at: tok });
    expect(r.status, dump(r)).toBe(200);
    const s = await fx.state(v);
    const last = s.audits[s.audits.length - 1]!;
    process.stderr.write(`T audit action=${last.action} meta=${JSON.stringify(last.changes.metadata)} olds=${JSON.stringify(last.changes.fields.map((f) => f.old))}\n`);
    expect(last.action).toBe('update');
    expect(last.changes.metadata.beforeInvalid).toBe('true'); // renamed from before_invalid (review round 2 item 2)
    expect(JSON.stringify(last.changes), 'the replaced document is unrecoverable from the audit trail').toContain('old figures 12345');
  });
});

describe('payable slots', () => {
  it('raw spellings of typed subtypes are refused; plain other liabilities accepted', async () => {
    const cases: Array<[string | null, boolean]> = [
      [null, true], ['other_current_liability', true], ['accrued_liability', true],
      ['payable', false], ['Accounts Payable', false], ['accounts_payable', false], ['vat_output', false], ['VAT Output', false],
      ['credit_card', false], ['Credit Card', false], ['bank', false], ['Bank', false], ['long_term_liability', false],
      ['payroll_liability', false],
    ];
    const out: string[] = [];
    let n = 0;
    for (const [sub, ok] of cases) {
      const id = await acct(A, `27${String(n++).padStart(2, '0')}`, 'liability', sub, 3);
      const d = fullDoc(); d.incomeTax.payableAccountId = id;
      const v = await fx.version(A, { kind: 'reforecast' });
      const r = await fx.routes.put(A.owner, { version_id: v, doc: d, expected_updated_at: null });
      const run = r.status === 200 ? await fx.routes.index(A.owner, { version_id: v }) : null;
      out.push(`${sub}:${r.status}${run ? `/run${run.status}` : ''}`);
      if ((r.status === 200) !== ok) out.push(`  MISMATCH expected ${ok ? 'accept' : 'refuse'}`);
    }
    process.stderr.write(`S ${out.join(' ')}\n`);
    expect(out.filter((x) => x.includes('MISMATCH'))).toEqual([]);
  });
  it('a later base edit that collides with a scenario: index warns; compare must not drop it silently', async () => {
    // A fresh company: A's opening is deliberately broken by the hostile-chart test above (postings on
    // header accounts the balance sheet's leaf rule leaves out), so every run of A is 409
    // BUDGET_OPENING_UNBALANCED by design (spec §5, §13.9) and could not show this warning.
    const B = await fx.company();
    const A2 = B;
    const x = await acct(A2, '2800', 'liability', null, 3);
    const base = await fx.version(A2, { kind: 'reforecast' });
    const sc = await fx.version(A2, { kind: 'scenario', basedOn: base });
    expect((await fx.routes.put(A2.owner, { version_id: base, doc: fullDoc(), expected_updated_at: null })).status).toBe(200);
    const s = await fx.routes.put(A2.owner, { version_id: sc, doc: { schemaVersion: 1, overrides: { incomeTax: { payableAccountId: x } } }, expected_updated_at: null });
    expect(s.status, dump(s)).toBe(200);
    const bt = String((await fx.state(base)).row.token);
    const d = fullDoc(); d.equity.dividendsPayableAccountId = x;
    expect((await fx.routes.put(A2.owner, { version_id: base, doc: d, expected_updated_at: bt })).status).toBe(200);
    const i = await fx.routes.index(A2.owner, { version_id: sc });
    expect(i.status).toBe(200);
    expect(dataOf<ThreeWayView>(i).warnings.map((w) => w.code)).toContain('payable_account_conflict');
    const cmp = await fx.routes.compare(A2.owner, `${base},${sc}`);
    process.stderr.write(`C compare=${cmp.status} body-has-conflict=${JSON.stringify(cmp.body).includes('payable_account_conflict')}\n`);
    expect(cmp.status).toBe(200);
    expect(JSON.stringify(cmp.body), 'compare answers the conflicted run with no warning').toContain('payable_account_conflict');
  });
});
