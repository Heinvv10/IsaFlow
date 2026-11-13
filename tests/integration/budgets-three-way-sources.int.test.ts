/**
 * Budgets P6 PR C, the external sources of a run on real PostgreSQL through the routes:
 *   - an existing loan through `previewSchedule` (included: its full-life schedule repays inside the version;
 *     excluded: carried flat), persisting nothing (loan_schedule_runs / _rows unchanged) and taking no lock on
 *     the loan (a run completes while another transaction holds the loan FOR UPDATE);
 *   - a VAT-registered company: getVat201Report's output / input tax feed the vatable shares;
 *   - a payroll company: generateEMP201 (PAYE net of ETI + UIF + SDL) feeds the statutory share.
 *
 * Hand-computed, the trailing year Mar 2025 - Feb 2026 (365 days), each month:
 *   VAT co: invoice Dr AR 21 500 / Cr sales 20 000 / Cr VAT output 1 500; receipt 20 000;
 *           bill Dr COGS 8 000 / Dr VAT input 1 200 / Cr AP 9 200; payment 9 000; rent 2 000 (no VAT).
 *     output 18 000 ÷ (240 000 × 15 %) = 0.5; input 14 400 ÷ ((96 000 + 24 000) × 15 %) = 0.8;
 *     AR 18 000 ÷ Σ(20 000 + 1 500) × 365 = 25.465… → 25.47 d; AP 2 400 ÷ Σ(10 000 + 1 200) × 365 = 6.517… → 6.52 d.
 *   Payroll co, Dec 2025 - Feb 2026: salaries 100 000 a month; paid runs PAYE 20 000, UIF 2 000, SDL 1 000,
 *     ETI 5 000 in January: (60 000 − 5 000 + 6 000 + 3 000) ÷ 300 000 = 0.21333… → 0.2133.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { previewSchedule } from '@/modules/accounting/services/loans/loanScheduleService';
import { defaultAssumptions } from '@/modules/accounting/services/budgets/threeWay/assumptionsDefaults';
import type { DeriveView, ThreeWayView } from '@/modules/accounting/services/budgets/threeWay/threeWayViews';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { monthsFrom } from './helpers/budgetGridFixture';
import { budgetThreeWayFixture, dataOf, type RouteOut, type ThreeWayCo } from './helpers/budgetThreeWayFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetThreeWayFixture(pool);
const FY = monthsFrom('2026-03');
const HISTORY = monthsFrom('2025-03');
const dump = (r: RouteOut) => JSON.stringify(r.body).slice(0, 400);
const fullDoc = () => defaultAssumptions({ priorYearEnd: '2026-02', entityType: 'pty_ltd', vat: { registered: false, cadence: 'bi-monthly', alignment: 'odd', basis: 'invoice' } });

type Line = { acct: string; debit?: number; credit?: number; vat?: string };
/** A balanced posted journal with VAT codes on its lines. */
async function post(c: ThreeWayCo, date: string, source: string, lines: Line[]): Promise<void> {
  const sum = lines.reduce((s, l) => s + (l.debit ?? 0) - (l.credit ?? 0), 0);
  if (Math.abs(sum) > 0.001) throw new Error(`unbalanced fixture journal ${date}: ${sum}`);
  const id = crypto.randomUUID();
  await pool.query(`INSERT INTO gl_journal_entries (id, company_id, entry_date, created_by, description, status, source)
    VALUES ($1, $2, $3, $4, 'three-way sources fixture', 'posted', $5)`, [id, c.id, date, c.user, source]);
  for (const l of lines) {
    await pool.query(`INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, company_id, vat_type)
      VALUES ($1, $2, $3, $4, $5, $6)`, [id, l.acct, l.debit ?? 0, l.credit ?? 0, c.id, l.vat ?? null]);
  }
}
const account = async (c: ThreeWayCo, code: string, name: string, type: string, subtype: string | null) => String((await pool.query(
  `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, level, is_active)
   VALUES ($1, $2, $3, $4, $5, $6, 3, true) RETURNING id`, [c.id, code, name, type, subtype, type === 'asset' || type === 'expense' ? 'debit' : 'credit'])).rows[0].id);

let L: ThreeWayCo, V: ThreeWayCo, W: ThreeWayCo;
let loanId: string;

beforeAll(async () => {
  L = await fx.company();
  const loanAcct = await account(L, '2500', 'Vehicle loan', 'liability', 'long_term_liability');
  await fx.journal(L, '2025-12-01', [{ acct: loanAcct, credit: 120000 }]);
  loanId = String((await pool.query(
    `INSERT INTO loans (company_id, gl_account_id, principal, start_date, term_months, rate_mode, fixed_rate, reference)
     VALUES ($1, $2, 120000, '2025-12-01', 60, 'FIXED', 10, 'TW-SRC') RETURNING id`, [L.id, loanAcct])).rows[0].id);

  V = await fx.company();
  await pool.query(`UPDATE companies SET vat_period = 'monthly', vat_system_type = 'invoice' WHERE id = $1`, [V.id]);
  const vatOut = await account(V, '2200', 'VAT output', 'liability', 'vat_output');
  const vatIn = await account(V, '1200', 'VAT input', 'asset', 'vat_input');
  for (const m of HISTORY) {
    await post(V, `${m}-05`, 'auto_invoice', [{ acct: V.ar, debit: 21500 }, { acct: V.acct.sales, credit: 20000 }, { acct: vatOut, credit: 1500, vat: 'standard' }]);
    await post(V, `${m}-20`, 'manual', [{ acct: V.acct.bank, debit: 20000 }, { acct: V.ar, credit: 20000 }]);
    await post(V, `${m}-08`, 'auto_supplier_invoice', [{ acct: V.acct.cos, debit: 8000 }, { acct: vatIn, debit: 1200, vat: 'standard' }, { acct: V.ap, credit: 9200 }]);
    await post(V, `${m}-25`, 'manual', [{ acct: V.ap, debit: 9000 }, { acct: V.acct.bank, credit: 9000 }]);
    await post(V, `${m}-15`, 'manual', [{ acct: V.acct.rent, debit: 2000 }, { acct: V.acct.bank, credit: 2000 }]);
  }

  W = await fx.company();
  const salaries = await account(W, '6500', 'Salaries', 'expense', 'salaries');
  for (const [y, mo, eti] of [[2025, 12, 0], [2026, 1, 5000], [2026, 2, 0]] as const) {
    await fx.journal(W, `${y}-${String(mo).padStart(2, '0')}-25`, [{ acct: salaries, debit: 100000 }]);
    await pool.query(
      `INSERT INTO payroll_run_headers (company_id, period_month, period_year, status, run_date, total_gross, total_taxable, total_paye, total_uif, total_sdl, total_eti, total_net, employee_count)
       VALUES ($1, $2, $3, 'paid', $4, 100000, 100000, 20000, 2000, 1000, $5, 78000, 4)`,
      [W.id, mo, y, `${y}-${String(mo).padStart(2, '0')}-25`, eti]);
  }
}, 120000);

afterAll(async () => {
  try {
    await pool.query('DELETE FROM loans WHERE company_id = $1', [L.id]);
    await pool.query('DELETE FROM payroll_run_headers WHERE company_id = $1', [W.id]);
    await fx.cleanup();
  } finally { await pool.end(); }
});

describe('an existing loan through previewSchedule', () => {
  const persisted = async () => (await pool.query(
    `SELECT (SELECT count(*) FROM loan_schedule_runs WHERE loan_id = $1)::int AS runs,
            (SELECT count(*) FROM loan_schedule_rows r JOIN loan_schedule_runs u ON u.id = r.run_id WHERE u.loan_id = $1)::int AS rows`, [loanId])).rows[0];
  const run = async (include: boolean | null) => {
    const v = await fx.version(L, { kind: 'reforecast' });
    const doc = fullDoc();
    if (include !== null) doc.loans.existing = [{ loanId, include }];
    expect((await fx.routes.put(L.owner, { version_id: v, doc, expected_updated_at: null })).status).toBe(200);
    const r = await fx.routes.index(L.owner, { version_id: v });
    expect(r.status, dump(r)).toBe(200);
    return dataOf<ThreeWayView>(r);
  };

  it('included: the full-life schedule repays exactly its in-version principal; nothing is persisted', async () => {
    const before = await persisted();
    const w = await run(true);
    expect(await persisted()).toEqual(before);
    expect(before).toEqual({ runs: 0, rows: 0 });
    const rows = await fx.direct(L, () => previewSchedule(L.id, loanId));
    expect(rows).toHaveLength(60);
    const principal = (m: string) => rows.filter((x) => x.date.slice(0, 7) === m).reduce((s, x) => s + Math.round((x.principal + x.lump) * 100), 0);
    let prev = w.opening.buckets.loans;
    expect(prev).toBe(-12_000_000);
    for (const [i, m] of FY.entries()) {
      expect([m, w.balanceSheet[i]!.closing.loans - prev]).toEqual([m, principal(m)]);
      prev = w.balanceSheet[i]!.closing.loans;
    }
    expect(w.cashFlow.direct.reduce((s, m) => s + m.direct.financing, 0)).toBe(-FY.reduce((s, m) => s + principal(m), 0));
  });

  it('excluded, or not listed: the loan is carried flat and nothing is persisted', async () => {
    for (const include of [false, null]) {
      const w = await run(include);
      expect(w.balanceSheet.every((m) => m.closing.loans === -12_000_000)).toBe(true);
      expect(w.warnings.some((x) => x.code === 'loan_schedule_missing')).toBe(false);
    }
    expect(await persisted()).toEqual({ runs: 0, rows: 0 });
  });

  it('takes no lock on the loan: a run completes while another transaction holds it FOR UPDATE', async () => {
    const v = await fx.version(L, { kind: 'reforecast' });
    const doc = fullDoc();
    doc.loans.existing = [{ loanId, include: true }];
    expect((await fx.routes.put(L.owner, { version_id: v, doc, expected_updated_at: null })).status).toBe(200);
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM loans WHERE id = $1 FOR UPDATE', [loanId]);
      const r = await Promise.race([
        fx.routes.index(L.owner, { version_id: v }),
        new Promise<'blocked'>((resolve) => { setTimeout(() => resolve('blocked'), 15000); }),
      ]);
      expect(r === 'blocked' ? 'blocked' : r.status).toBe(200);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  }, 30000);
});

describe('a VAT-registered company: getVat201Report feeds the vatable shares', () => {
  it('derives 0.5 / 0.8 from the trailing output and input VAT, and the VAT-inclusive days on them', async () => {
    const v = await fx.version(V, { kind: 'reforecast' });
    const r = await fx.routes.derive(V.owner, { version_id: v });
    expect(r.status, dump(r)).toBe(200);
    const d = dataOf<DeriveView>(r);
    expect(d.evidence.vat).toEqual({ outputTax: 1_800_000, inputTax: 1_440_000 });
    expect(d.assumptions.vat.registered.value).toBe(true);
    expect(d.assumptions.vat.cadence.value).toBe('monthly');
    expect(d.assumptions.vat.vatableSalesShare).toMatchObject({ value: 0.5, source: 'derived' });
    expect(d.assumptions.vat.vatablePurchasesShare.value).toBe(0.8);
    expect(d.assumptions.workingCapital.debtorDays.value).toBe(25.47);
    expect(d.assumptions.workingCapital.creditorDays.value).toBe(6.52);
    const run = await fx.routes.index(V.owner, { version_id: v });
    expect(run.status, dump(run)).toBe(200);
    expect(dataOf<ThreeWayView>(run).checks.balanced).toBe(true);
  });
});

describe('a payroll company: generateEMP201 feeds the statutory share', () => {
  it('(PAYE net of ETI + UIF + SDL) ÷ payroll expense over the last three months = 0.2133', async () => {
    const v = await fx.version(W, { kind: 'reforecast' });
    const r = await fx.routes.derive(W.owner, { version_id: v });
    expect(r.status, dump(r)).toBe(200);
    const d = dataOf<DeriveView>(r);
    expect(d.evidence.statutory).toBe(6_400_000);
    expect(d.evidence.trailing.statutoryPayroll).toBe(30_000_000);
    expect(d.assumptions.payroll.statutoryShare).toMatchObject({ value: 0.2133, source: 'derived' });
  });
});
