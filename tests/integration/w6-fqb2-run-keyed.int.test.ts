/**
 * Wave 6 FQb2: the run-keyed READERS outside the payroll services (census class R, owner FQb2), each with two runs in
 * one month: a regular run and an off-cycle bonus run of the same calendar month (the shape FQx allows), the per-month
 * unique dropped inside the case's own rolled-back transaction (w6-fqb1.helpers.ts). Company B holds the same shape at
 * 10x (and the opposite calculation versions), so a reader that leaked across tenants moves A's figure. A reader that
 * still leaned on one run per month takes whichever row comes first, so every case runs with the runs seeded in both
 * orders: a month-keyed reader fails at least one of them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropTenants, seedRun, seedTenant, twoRunsInMonth, type RunSpec, type Tenant } from './w6-fqb1.helpers';
import { payePayableDiffersFromEmp201 } from '@/modules/accounting/services/gl/integrityChecks/payrollChecks';
import { getOwnerCashPosition } from '@/modules/bureau/services/ownerCashPositionService';
import { buildPayrollCard } from '@/modules/accounting/services/workbench/monthEndLedgerCards';
import { lastPayRun } from '@/modules/accounting/services/ask/askTax';
import { shapeAttention } from '@/modules/accounting/services/dashboard/attentionShape';
import { formatMoney } from '@/lib/money/formatMoney';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let A: Tenant;
let B: Tenant;

/** May 2026: the regular run paid on the 25th, the off-cycle bonus on the 28th. */
const REGULAR: RunSpec = { year: 2026, month: 5, runDate: '2026-05-25', gross: 20000, paye: 2000 };
const BONUS: RunSpec = { year: 2026, month: 5, runDate: '2026-05-28', offCycle: true, gross: 5000, paye: 700 };
const x10 = (r: RunSpec): RunSpec => ({ ...r, gross: (r.gross ?? 10000) * 10, paye: (r.paye ?? 1000) * 10 });
const BOTH_ORDERS = [false, true];
const ordered = <T>(runs: T[], flip: boolean): T[] => (flip ? [...runs].reverse() : runs);

/** B's runs (10x), then A's in the order given. Returns A's ids in seed order. */
async function seedBoth(c: PoolClient, aRuns: RunSpec[], each?: (id: string, t: Tenant, i: number) => Promise<void>): Promise<string[]> {
  for (const [i, r] of aRuns.entries()) { const id = await seedRun(c, B, x10(r)); if (each) await each(id, B, i); }
  const ids: string[] = [];
  for (const [i, r] of aRuns.entries()) { const id = await seedRun(c, A, r); ids.push(id); if (each) await each(id, A, i); }
  return ids;
}

/** A posted auto_payroll journal with no lines: in force, booking nothing, so the month's PAYE is a difference. */
async function emptyJournal(c: PoolClient, t: Tenant): Promise<string> {
  return String((await c.query(
    `INSERT INTO gl_journal_entries (company_id, entry_date, created_by, status, source, description, reference)
     VALUES ($1, '2026-05-31', $2, 'posted', 'auto_payroll', 'Payroll run 2026-05', 'PAY-2026-05') RETURNING id`,
    [t.company, t.user])).rows[0].id);
}

beforeAll(async () => {
  A = await seedTenant(pool, 'W6 FQb2 A');
  B = await seedTenant(pool, 'W6 FQb2 B');
});

afterAll(async () => {
  try { await dropTenants(pool, [A, B]); } finally { await pool.end(); }
});

describe('integrity check: PAYE payable differs from the EMP201 (calculation version of the month)', () => {
  const run = (aVersions: number[], bVersions: number[], flip: boolean) => twoRunsInMonth(pool, A, async (c) => {
    await seedBoth(c, ordered([REGULAR, BONUS], flip), async (id, t, i) => {
      const v = (t === A ? ordered(aVersions, flip) : ordered(bVersions, flip))[i];
      await c.query('UPDATE payroll_run_headers SET journal_entry_id = $2, calculation_version = $3 WHERE id = $1', [id, await emptyJournal(c, t), v]);
    });
  }, () => payePayableDiffersFromEmp201({ companyId: A.company, asAt: '2026-06-30', limit: 20 }));

  it.each(BOTH_ORDERS)('a month with ANY run calculated before ETI carry-forward is listed, not counted (seeded reversed: %s)', async (flip) => {
    // A: the regular run at version 8, the bonus at 7. B (10x) is all version 8 and must not count for A.
    const got = await run([8, 7], [8, 8], flip);
    expect(got.sample.map((s) => s.id)).not.toContain('2026-05');
    expect(got.finding).toContain('(calculation version < 8): 2026-05.');
  });

  it.each(BOTH_ORDERS)('a month whose runs are all at version 8 or later is counted at the whole month\'s PAYE (seeded reversed: %s)', async (flip) => {
    // B's runs are pre-ET: a check that read B's headers would not count A's month.
    const got = await run([8, 9], [7, 7], flip);
    const may = got.sample.find((s) => s.id === '2026-05');
    expect(may?.amount).toBe(-2700);
    expect(got.finding).not.toContain('Not counted');
  });
});

describe('owner cash position: the next pay run', () => {
  // 20 May: both May runs (paid on the 25th and the 28th) are still due.
  const today = new Date('2026-05-20T10:00:00Z');
  const position = (flip: boolean, cash: number, when: Date = today) => {
    let ids: string[] = [];
    return twoRunsInMonth(pool, A, async (c) => { ids = await seedBoth(c, ordered([REGULAR, BONUS], flip)); },
      async () => ({ got: await getOwnerCashPosition(A.company, cash, when), ids: ordered(ids, flip) }));
  };

  it.each(BOTH_ORDERS)('cash covers both: the latest run of the month is the bonus, against both (seeded reversed: %s)', async (flip) => {
    const { got, ids } = await position(flip, 1_000_000);
    expect(got.payroll?.runId).toBe(ids[1]);
    // Regular 20 000 + bonus 5 000 (net + PAYE); B's 10x runs would read 250 000.
    expect(got.payroll).toMatchObject({ totalRequired: 25000, canPay: true, shortfall: 0, runsCounted: 2 });
  });

  // Review #1549 L1: cash 22 000 pays either run alone, never both. Judged run by run against the whole balance it
  // read "can pay"; the remainder after the regular run (2 000) cannot cover the bonus, so the month is short 3 000.
  it.each(BOTH_ORDERS)('cash covers either run alone but not both: the bonus is short 3 000 and the dashboard says so (seeded reversed: %s)', async (flip) => {
    const { got, ids } = await position(flip, 22_000);
    expect(got.payroll).toMatchObject({ runId: ids[1], canPay: false, shortfall: 3000, totalRequired: 25000, runsCounted: 2 });
    const items = shapeAttention({
      asAt: '2026-05-20', today, counts: { billsOverdue: 0, billsDueNext7Days: 0 } as never,
      overdueInvoices: { count: 0, amount: 0 }, unreconciledBankTxns: 0, openPriorPeriods: 0, payRuns: [], work: [], cash: got,
    });
    expect(items.find((i) => i.key === 'payroll-shortfall')).toMatchObject({
      amount: 3000, detail: expect.stringContaining('for this and 1 earlier pay run still due (net pay'),
    });
  });

  // Review #1549 N-H1: nothing marks a run paid, so last month's approved run is still open after its salaries left
  // the bank. Its pay date has passed: it is judged on its own, never added to this month's requirement.
  it('a monthly-only company (one run a month): April paid on the 25th + May 20 000, cash 30 000 on 29 May: May is payable', async () => {
    let ids: string[] = [];
    const got = await twoRunsInMonth(pool, A, async (c) => {
      ids = await seedBoth(c, [{ ...REGULAR, month: 4, runDate: '2026-04-25' }, { ...REGULAR, runDate: '2026-05-31' }]);
    }, () => getOwnerCashPosition(A.company, 30_000, new Date('2026-05-29T10:00:00Z')));
    expect(got.payroll).toMatchObject({ runId: ids[1], canPay: true, shortfall: 0, totalRequired: 20000, runsCounted: 1 });
  });

  it.each(BOTH_ORDERS)('27 May: the regular run (paid on the 25th) is judged alone; only the bonus is still due (seeded reversed: %s)', async (flip) => {
    const { got, ids } = await position(flip, 22_000, new Date('2026-05-27T10:00:00Z'));
    expect(got.payroll).toMatchObject({ runId: ids[1], canPay: true, totalRequired: 5000, runsCounted: 1 });
  });

  it.each(BOTH_ORDERS)('cash covers neither: the earliest short run is the regular run (seeded reversed: %s)', async (flip) => {
    const { got, ids } = await position(flip, 100);
    expect(got.payroll).toMatchObject({ runId: ids[0], shortfall: 19900, totalRequired: 20000, runsCounted: 1 });
  });
});

/** A second employee of `t`, and the run's line moved to them (a leaver paid by a termination run). */
async function payOther(c: PoolClient, t: Tenant, runId: string): Promise<void> {
  const e2 = String((await c.query(
    `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, end_date, date_of_birth, tax_number)
     VALUES ($1, 'FQB2-2', 'Leaver', 'Two', '2020-01-01', '2026-05-28', '1980-01-01', '0123456780') RETURNING id`, [t.company])).rows[0].id);
  await c.query('UPDATE payroll_run_lines SET employee_id = $2 WHERE run_id = $1', [runId, e2]);
  await c.query("UPDATE payroll_run_headers SET off_cycle_reason = 'termination' WHERE id = $1", [runId]);
}

describe('month-end workbench: the payroll card', () => {
  it.each(BOTH_ORDERS)('two runs: in progress while one is not final, which it names; gross of both (seeded reversed: %s)', async (flip) => {
    const card = await twoRunsInMonth(pool, A,
      async (c) => { await seedBoth(c, ordered([REGULAR, { ...BONUS, status: 'calculated' }], flip)); },
      () => buildPayrollCard(A.company, '2026-05'));
    expect(card).toMatchObject({
      status: 'in_progress', primary: `${formatMoney(25000)} gross`,
      secondary: '1 employees · 1 of 2 runs not final: bonus run (calculated)',
    });
  });

  it.each(BOTH_ORDERS)('two final runs (one paid): ready (seeded reversed: %s)', async (flip) => {
    const card = await twoRunsInMonth(pool, A,
      async (c) => { await seedBoth(c, ordered([REGULAR, { ...BONUS, status: 'paid', approvedAt: '2026-05-28' }], flip)); },
      () => buildPayrollCard(A.company, '2026-05'));
    expect(card).toMatchObject({ status: 'ready', primary: `${formatMoney(25000)} gross`, secondary: '1 employees · 2 runs, all final' });
  });

  // Review #1549 L3: readiness is R-035 finality, not the status string.
  it('an approved run with neither approval stamp is not final: in progress, named', async () => {
    const card = await twoRunsInMonth(pool, A,
      async (c) => { await seedBoth(c, [REGULAR, { ...BONUS, approvedAt: null }]); },
      () => buildPayrollCard(A.company, '2026-05'));
    expect(card).toMatchObject({ status: 'in_progress', secondary: '1 employees · 1 of 2 runs not final: bonus run (approved)' });
  });

  // Review #1549 L2: the people paid across the month's runs, not the larger run's head count.
  it('a termination run paying another employee: 2 employees', async () => {
    const card = await twoRunsInMonth(pool, A, async (c) => {
      const [, term] = await seedBoth(c, [REGULAR, BONUS]);
      await payOther(c, A, term!);
    }, () => buildPayrollCard(A.company, '2026-05'));
    expect(card).toMatchObject({ status: 'ready', secondary: '2 employees · 2 runs, all final' });
  });

  // Review #1549 N-L1: a cancelled run is no run: neither not-final, nor gross, nor people.
  it('a cancelled bonus run is left out: the regular run reads as one run', async () => {
    const card = await twoRunsInMonth(pool, A, async (c) => {
      const [, bonus] = await seedBoth(c, [REGULAR, { ...BONUS, status: 'cancelled', approvedAt: null }]);
      await payOther(c, A, bonus!);
    }, () => buildPayrollCard(A.company, '2026-05'));
    expect(card).toMatchObject({ status: 'ready', primary: `${formatMoney(20000)} gross`, secondary: '1 employees · approved' });
  });

  it('one run (a monthly-only company): an approved, stamped run reads as before', async () => {
    const card = await twoRunsInMonth(pool, A, async (c) => { await seedBoth(c, [REGULAR]); },
      () => buildPayrollCard(A.company, '2026-05'));
    expect(card).toEqual({
      id: 'payroll', title: 'Payroll Run', status: 'ready',
      primary: `${formatMoney(20000)} gross`, secondary: '1 employees · approved', href: '/payroll/runs',
    });
  });
});

describe('Ask IsaFlow: the pay run for a month', () => {
  const ask = (flip: boolean, bonus: RunSpec) => twoRunsInMonth(pool, A,
    async (c) => { await seedBoth(c, ordered([REGULAR, bonus], flip)); },
    () => lastPayRun({ id: 'last_pay_run' as never, period: { kind: 'month', year: 2026, month: 5 } }, A.company, '2026-06-10'));

  // Review #1549 L4: the regular run answers, and the month's other final run is named with the combined gross.
  it.each(BOTH_ORDERS)('names the month\'s other final run and the combined gross (seeded reversed: %s)', async (flip) => {
    const got = await ask(flip, BONUS);
    expect(got.figure).toBe(20000);
    expect(got.text).toContain('The month has 1 other final run (R 25 000.00 gross combined).');
  });

  it('a run that is not final is not named', async () => {
    const got = await ask(false, { ...BONUS, status: 'calculated' });
    expect(got.text).not.toContain('other final run');
  });
});
