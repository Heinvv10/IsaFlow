/**
 * Budgets P6 PR C review round 1 (items 1-2), real PostgreSQL through the routes:
 *   1. a named payable account must be one whose balance would otherwise sit in other (current or
 *      non-current) liabilities and is no loan's account: AP, VAT control, payroll liabilities, a loan's
 *      account and a credit card are 400 with the path; the derive's candidates are filtered the same way;
 *   2. a scenario save validates the payable accounts of the RESOLVED chain (a conflict with its base is
 *      400, nothing written); a conflict that appears at RUN time (a later base edit) is not a 400: income
 *      tax keeps the account, the dividends slot is ignored, warning `payable_account_conflict`; compare runs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { defaultAssumptions } from '@/modules/accounting/services/budgets/threeWay/assumptionsDefaults';
import type { AssumptionsView, CompareView, DeriveView, ThreeWayView } from '@/modules/accounting/services/budgets/threeWay/threeWayViews';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetThreeWayFixture, dataOf, details, type RouteOut, type ThreeWayCo } from './helpers/budgetThreeWayFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = budgetThreeWayFixture(pool);
const dump = (r: RouteOut) => JSON.stringify(r.body).slice(0, 400);
const fullDoc = () => defaultAssumptions({ priorYearEnd: '2026-02', entityType: 'pty_ltd', vat: { registered: false, cadence: 'bi-monthly', alignment: 'odd', basis: 'invoice' } });
const tokenOf = (r: RouteOut) => String((r.body.data as { updatedAt: string }).updatedAt);

let S: ThreeWayCo;
let tax: string, other: string, vat: string, paye: string, loanAcct: string, card: string;

const liability = async (c: ThreeWayCo, code: string, name: string, subtype: string | null) => String((await pool.query(
  `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, level, is_active)
   VALUES ($1, $2, $3, 'liability', $4, 'credit', 3, true) RETURNING id`, [c.id, code, name, subtype])).rows[0].id);

beforeAll(async () => {
  S = await fx.company();
  tax = await liability(S, '2300', 'SARS Provisional Tax', null);
  other = await liability(S, '2350', 'Accrued sundries', 'current_liability');
  vat = await liability(S, '2200', 'VAT output', 'vat_output');
  // Named like a SARS tax, but it is PAYE (a payroll liability): never a candidate.
  paye = await liability(S, '2100', 'SARS PAYE tax', 'payroll_liability');
  loanAcct = await liability(S, '2500', 'Bank loan', null);
  card = await liability(S, '2600', 'Company card', 'credit_card');
  await pool.query(`INSERT INTO loans (company_id, gl_account_id, principal, start_date, term_months, rate_mode, fixed_rate)
    VALUES ($1, $2, 50000, '2025-12-01', 24, 'FIXED', 9)`, [S.id, loanAcct]);
  await fx.journal(S, '2026-02-15', [{ acct: tax, credit: 30000 }]);
  await fx.journal(S, '2026-02-16', [{ acct: other, credit: 8000 }]);
}, 60000);

afterAll(async () => {
  try {
    await pool.query('DELETE FROM loans WHERE company_id = $1', [S.id]);
    await fx.cleanup();
  } finally { await pool.end(); }
});

describe('1: only an account that would sit in other liabilities, and is no loan account, can be named', () => {
  it.each([
    ['AP control', () => S.ap, 'incomeTax.payableAccountId'],
    ['VAT control', () => vat, 'equity.dividendsPayableAccountId'],
    ['a payroll liability', () => paye, 'incomeTax.payableAccountId'],
    ["a loan's account", () => loanAcct, 'incomeTax.payableAccountId'],
    ['a credit card', () => card, 'equity.dividendsPayableAccountId'],
  ])('%s: 400 with the path, nothing written', async (_what, id, path) => {
    const doc = fullDoc();
    if (path.startsWith('incomeTax')) doc.incomeTax.payableAccountId = id();
    else doc.equity.dividendsPayableAccountId = id();
    const v = await fx.version(S, { kind: 'reforecast' });
    const r = await fx.routes.put(S.owner, { version_id: v, doc, expected_updated_at: null });
    expect(r.status, dump(r)).toBe(400);
    expect(details(r)).toMatchObject({ code: 'BUDGET_ASSUMPTIONS_INVALID', issues: [expect.objectContaining({ path })] });
    expect((await fx.state(v)).row).toBeNull();
  });

  it('an account with no subtype or a plain current-liability subtype is accepted', async () => {
    const doc = fullDoc();
    doc.incomeTax.payableAccountId = tax;
    doc.equity.dividendsPayableAccountId = other;
    const v = await fx.version(S, { kind: 'reforecast' });
    expect((await fx.routes.put(S.owner, { version_id: v, doc, expected_updated_at: null })).status).toBe(200);
  });

  it('the derive’s candidates are filtered the same way: the PAYE account named like SARS tax is not one', async () => {
    const v = await fx.version(S, { kind: 'reforecast' });
    const d = dataOf<DeriveView>(await fx.routes.derive(S.owner, { version_id: v }));
    expect(d.assumptions.incomeTax.payableAccountId).toBe(tax);
    expect(d.evidence.payableAccounts.incomeTaxPayable.basis).toBe('the only active liability account named like income tax: 2300 SARS Provisional Tax');
  });
});

describe('2: payable accounts of the resolved scenario chain', () => {
  it('a scenario save whose resolved chain names one account twice is 400; nothing written', async () => {
    const base = await fx.version(S, { kind: 'reforecast' });
    const s = await fx.version(S, { kind: 'scenario', basedOn: base });
    const b = fullDoc();
    b.equity.dividendsPayableAccountId = other;
    expect((await fx.routes.put(S.owner, { version_id: base, doc: b, expected_updated_at: null })).status).toBe(200);
    const r = await fx.routes.put(S.owner, { version_id: s, doc: { schemaVersion: 1, overrides: { incomeTax: { payableAccountId: other } } }, expected_updated_at: null });
    expect(r.status, dump(r)).toBe(400);
    expect(details(r)).toMatchObject({
      code: 'BUDGET_ASSUMPTIONS_INVALID',
      issues: [{ path: 'equity.dividendsPayableAccountId', message: "Account already used by the base version's dividends payable" }],
    });
    const st = await fx.state(s);
    expect(st.row).toBeNull();
    expect(st.audits).toHaveLength(0);
  });

  it('a conflict a later base edit causes: the run keeps income tax, ignores dividends, warns; compare runs', async () => {
    const base = await fx.version(S, { kind: 'reforecast' });
    const s = await fx.version(S, { kind: 'scenario', basedOn: base });
    const first = await fx.routes.put(S.owner, { version_id: base, doc: fullDoc(), expected_updated_at: null });
    expect(first.status).toBe(200);
    expect((await fx.routes.put(S.owner, { version_id: s, doc: { schemaVersion: 1, overrides: { incomeTax: { payableAccountId: other } } }, expected_updated_at: null })).status).toBe(200);
    const b = fullDoc();
    b.equity.dividendsPayableAccountId = other;
    expect((await fx.routes.put(S.owner, { version_id: base, doc: b, expected_updated_at: tokenOf(first) })).status).toBe(200);

    const r = await fx.routes.index(S.owner, { version_id: s });
    expect(r.status, dump(r)).toBe(200);
    const w = dataOf<ThreeWayView>(r);
    expect(w.opening.buckets).toMatchObject({ incomeTaxPayable: -800_000, dividendsPayable: 0 });
    const conflict = { code: 'payable_account_conflict', accountId: other, kept: 'incomeTaxPayable', ignored: 'dividendsPayable' };
    expect(w.warnings).toContainEqual(conflict);
    const baseRun = dataOf<ThreeWayView>(await fx.routes.index(S.owner, { version_id: base }));
    expect(baseRun.opening.buckets).toMatchObject({ dividendsPayable: -800_000, incomeTaxPayable: 0 });
    const c = await fx.routes.compare(S.owner, `${base},${s}`);
    expect(c.status, dump(c)).toBe(200);
    const [cb, cs] = dataOf<CompareView>(c).versions;
    expect(cs!.warnings).toContainEqual(conflict);
    expect(cb!.warnings.map((x) => x.code)).not.toContain('payable_account_conflict');
    // The assumptions view says so too.
    const g = await fx.routes.getAssumptions(S.owner, s);
    expect(g.status, dump(g)).toBe(200);
    expect(dataOf<AssumptionsView>(g).warnings).toEqual([conflict]);
    expect(dataOf<AssumptionsView>(await fx.routes.getAssumptions(S.owner, base)).warnings).toEqual([]);
  });

  it("compare carries each version's run warnings (a provisional opening)", async () => {
    const a = await fx.version(S, { fy: 2028, kind: 'reforecast' });
    const b = await fx.version(S, { fy: 2028, kind: 'reforecast' });
    const c = await fx.routes.compare(S.owner, `${a},${b}`);
    expect(c.status, dump(c)).toBe(200);
    for (const v of dataOf<CompareView>(c).versions) expect(v.warnings.map((x) => x.code)).toContain('opening_provisional');
  });
});
