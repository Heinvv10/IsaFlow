/**
 * Budgets P6 PR C (spec §5 "account chosen in assumptions", 10b, §13.10), real PostgreSQL through the routes:
 * `incomeTax.payableAccountId` / `equity.dividendsPayableAccountId` move that leaf liability's opening balance
 * into incomeTaxPayable / dividendsPayable, so the prior-year top-up fires from a real balance; a named account
 * that is not a leaf liability of the company is a typed 400 (on save and on every run); derive proposes the
 * one active liability whose name matches, and none when two do.
 *
 * Hand-computed (FY2027 = Mar 2026 - Feb 2027, a February year end, so the top-up is 7 months after the
 * prior year end Feb 2026 = Sep 2026; nothing budgeted, so tax expense 0 and IRP6 #1/#2 are 0):
 *   opening (28 Feb 2026): bank 42 000 Dr; SARS Provisional Tax 30 000 Cr; Dividends payable 12 000 Cr.
 *   incomeTaxPayable −30 000 Mar-Aug, 0 from Sep; cash 42 000 Mar-Aug, 12 000 Sep-Feb; dividendsPayable flat −12 000.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { defaultAssumptions } from '@/modules/accounting/services/budgets/threeWay/assumptionsDefaults';
import type { DeriveView, ThreeWayView } from '@/modules/accounting/services/budgets/threeWay/threeWayViews';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetThreeWayFixture, code, dataOf, details, type RouteOut, type ThreeWayCo } from './helpers/budgetThreeWayFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = budgetThreeWayFixture(pool);
const dump = (r: RouteOut) => JSON.stringify(r.body).slice(0, 400);
const fullDoc = () => defaultAssumptions({ priorYearEnd: '2026-02', entityType: 'pty_ltd', vat: { registered: false, cadence: 'bi-monthly', alignment: 'odd', basis: 'invoice' } });

let P: ThreeWayCo, Q: ThreeWayCo;
let tax: string, div: string, header: string, otherCoLiability: string;

const liability = async (c: ThreeWayCo, code: string, name: string, opts: { level?: number; parent?: string } = {}) => String((await pool.query(
  `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, is_active, parent_account_id)
   VALUES ($1, $2, $3, 'liability', 'credit', $4, true, $5) RETURNING id`, [c.id, code, name, opts.level ?? 3, opts.parent ?? null])).rows[0].id);

beforeAll(async () => {
  P = await fx.company();
  Q = await fx.company();
  tax = await liability(P, '2300', 'SARS Provisional Tax');
  div = await liability(P, '2400', 'Dividends payable');
  header = await liability(P, '2900', 'Other liabilities', { level: 1 });
  await liability(P, '2910', 'Sundry', { parent: header });
  await fx.journal(P, '2026-02-15', [{ acct: tax, credit: 30000 }]);
  await fx.journal(P, '2026-02-16', [{ acct: div, credit: 12000 }]);
  otherCoLiability = await liability(Q, '2300', 'Income tax payable');
  // Q has TWO accounts named like income tax: derive must not pick one.
  await liability(Q, '2301', 'Income tax 2026 assessment');
}, 60000);

afterAll(async () => {
  try { await fx.cleanup(); } finally { await pool.end(); }
});

describe('derive proposes the payable accounts', () => {
  it('the one active liability named like income tax (and like dividends), basis in the evidence', async () => {
    const v = await fx.version(P, { kind: 'reforecast' });
    const r = await fx.routes.derive(P.owner, { version_id: v });
    expect(r.status, dump(r)).toBe(200);
    const d = dataOf<DeriveView>(r);
    expect(d.assumptions.incomeTax.payableAccountId).toBe(tax);
    expect(d.assumptions.equity.dividendsPayableAccountId).toBe(div);
    expect(d.evidence.payableAccounts.incomeTaxPayable.basis).toBe('the only active liability account named like income tax: 2300 SARS Provisional Tax');
  });

  it('two candidates: none proposed, the evidence lists them', async () => {
    const v = await fx.version(Q, { kind: 'reforecast' });
    const d = dataOf<DeriveView>(await fx.routes.derive(Q.owner, { version_id: v }));
    expect(d.assumptions.incomeTax.payableAccountId).toBeUndefined();
    expect(d.evidence.payableAccounts.incomeTaxPayable.basis).toBe('2 active liability accounts named like income tax (2300, 2301); choose one');
  });
});

describe('10b: the prior-year top-up fires from the real opening balance', () => {
  it('derived (no stored document): the balances move into their buckets and the top-up is paid in Sep 2026', async () => {
    const v = await fx.version(P, { kind: 'reforecast' });
    const r = await fx.routes.index(P.owner, { version_id: v });
    expect(r.status, dump(r)).toBe(200);
    const w = dataOf<ThreeWayView>(r);
    expect(w.opening.buckets).toMatchObject({ cash: 4_200_000, incomeTaxPayable: -3_000_000, dividendsPayable: -1_200_000, otherCurrentLiabilities: 0 });
    expect(w.opening.unmapped).toEqual([]);
    expect(w.taxEvents).toContainEqual({ month: '2026-09', kind: 'top_up', amount: 3_000_000 });
    expect(w.balanceSheet.map((m) => m.closing.incomeTaxPayable)).toEqual([...Array(6).fill(-3_000_000), ...Array(6).fill(0)]);
    expect(w.balanceSheet.map((m) => m.closing.cash)).toEqual([...Array(6).fill(4_200_000), ...Array(6).fill(1_200_000)]);
    expect(w.balanceSheet.every((m) => m.closing.dividendsPayable === -1_200_000)).toBe(true);
    expect(w.cashFlow.direct[6]!.direct.other_operating).toBe(-3_000_000);
    expect(w.checks.balanced).toBe(true);
  });

  it('a stored document naming no account: the balance stays in other liabilities and no top-up is paid', async () => {
    const v = await fx.version(P, { kind: 'reforecast' });
    expect((await fx.routes.put(P.owner, { version_id: v, doc: fullDoc(), expected_updated_at: null })).status).toBe(200);
    const w = dataOf<ThreeWayView>(await fx.routes.index(P.owner, { version_id: v }));
    expect(w.opening.buckets).toMatchObject({ incomeTaxPayable: 0, otherCurrentLiabilities: -4_200_000 });
    expect(w.taxEvents.filter((e) => e.kind === 'top_up')).toEqual([]);
    expect(w.balanceSheet[11]!.closing.cash).toBe(4_200_000);
  });
});

describe('a named account must be a leaf liability of the company (typed 400)', () => {
  const named = (incomeTax?: string, dividends?: string) => {
    const d = fullDoc();
    if (incomeTax) d.incomeTax.payableAccountId = incomeTax;
    if (dividends) d.equity.dividendsPayableAccountId = dividends;
    return d;
  };

  it.each([
    ['an asset', () => named(P.acct.bank), 'incomeTax.payableAccountId'],
    ['a header liability', () => named(header), 'incomeTax.payableAccountId'],
    ["another company's liability", () => named(otherCoLiability), 'incomeTax.payableAccountId'],
    ['an unknown id', () => named(undefined, crypto.randomUUID()), 'equity.dividendsPayableAccountId'],
    ['the same account twice', () => named(tax, tax), 'equity.dividendsPayableAccountId'],
  ])('%s: 400 BUDGET_ASSUMPTIONS_INVALID on save, nothing written', async (_what, doc, path) => {
    const v = await fx.version(P, { kind: 'reforecast' });
    const r = await fx.routes.put(P.owner, { version_id: v, doc: doc(), expected_updated_at: null });
    expect(r.status, dump(r)).toBe(400);
    expect(details(r)).toMatchObject({ code: 'BUDGET_ASSUMPTIONS_INVALID', issues: [expect.objectContaining({ path })] });
    expect((await fx.state(v)).row).toBeNull();
  });

  it('in a scenario override the path names the override', async () => {
    const base = await fx.version(P, { kind: 'reforecast' });
    const s = await fx.version(P, { kind: 'scenario', basedOn: base });
    const r = await fx.routes.put(P.owner, { version_id: s, doc: { schemaVersion: 1, overrides: { incomeTax: { payableAccountId: P.acct.bank } } }, expected_updated_at: null });
    expect(r.status, dump(r)).toBe(400);
    expect(details(r)).toMatchObject({ issues: [expect.objectContaining({ path: 'overrides.incomeTax.payableAccountId' })] });
  });

  it('re-checked on every run: an account that became a header after the save is 400 on read', async () => {
    const v = await fx.version(P, { kind: 'reforecast' });
    expect((await fx.routes.put(P.owner, { version_id: v, doc: named(tax), expected_updated_at: null })).status).toBe(200);
    // The opening's leaf rule (getBalanceSheet's): level >= 3, or no child. Below level 3 with a child = a header.
    const child = await liability(P, '2310', 'Provisional tax 2027', { parent: tax });
    await pool.query('UPDATE gl_accounts SET level = 2 WHERE id = $1', [tax]);
    try {
      const r = await fx.routes.index(P.owner, { version_id: v });
      expect(r.status, dump(r)).toBe(400);
      expect(details(r)).toMatchObject({ code: 'BUDGET_ASSUMPTIONS_INVALID', issues: [expect.objectContaining({ path: 'incomeTax.payableAccountId' })] });
    } finally {
      await pool.query('DELETE FROM gl_accounts WHERE id = $1', [child]);
      await pool.query('UPDATE gl_accounts SET level = 3 WHERE id = $1', [tax]);
    }
  });
});
