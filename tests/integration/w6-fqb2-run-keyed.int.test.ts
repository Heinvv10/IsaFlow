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
  const today = new Date('2026-05-29T10:00:00Z');
  const position = (flip: boolean, cash: number) => {
    let ids: string[] = [];
    return twoRunsInMonth(pool, A, async (c) => { ids = await seedBoth(c, ordered([REGULAR, BONUS], flip)); },
      async () => ({ got: await getOwnerCashPosition(A.company, cash, today), ids: ordered(ids, flip) }));
  };

  it.each(BOTH_ORDERS)('cash covers both: the latest run of the month is the bonus (seeded reversed: %s)', async (flip) => {
    const { got, ids } = await position(flip, 1_000_000);
    expect(got.payroll?.runId).toBe(ids[1]);
    // The bonus alone: net 4 300 + PAYE 700 (B's 10x run would read 50 000).
    expect(got.payroll?.totalRequired).toBe(5000);
  });

  it.each(BOTH_ORDERS)('cash covers neither: the earliest short run is the regular run (seeded reversed: %s)', async (flip) => {
    const { got, ids } = await position(flip, 100);
    expect(got.payroll?.runId).toBe(ids[0]);
    expect(got.payroll?.shortfall).toBe(19900);
  });
});

describe('month-end workbench: the payroll card', () => {
  it.each(BOTH_ORDERS)('two runs: ready only when both are approved, gross of both (seeded reversed: %s)', async (flip) => {
    const card = await twoRunsInMonth(pool, A,
      async (c) => { await seedBoth(c, ordered([REGULAR, { ...BONUS, status: 'calculated' }], flip)); },
      () => buildPayrollCard(A.company, '2026-05'));
    expect(card.status).toBe('in_progress');
    expect(card.primary).toBe(`${formatMoney(25000)} gross`);
    expect(card.secondary).toMatch(/^1 employees · 2 runs: /);
  });

  it.each(BOTH_ORDERS)('two approved runs: ready (seeded reversed: %s)', async (flip) => {
    const card = await twoRunsInMonth(pool, A, async (c) => { await seedBoth(c, ordered([REGULAR, BONUS], flip)); },
      () => buildPayrollCard(A.company, '2026-05'));
    expect(card.status).toBe('ready');
    expect(card.primary).toBe(`${formatMoney(25000)} gross`);
  });

  it('one run (a monthly-only company, today\'s schema): exactly as before', async () => {
    const card = await twoRunsInMonth(pool, A, async (c) => { await seedBoth(c, [REGULAR]); },
      () => buildPayrollCard(A.company, '2026-05'), { keepMonthKey: true });
    expect(card).toEqual({
      id: 'payroll', title: 'Payroll Run', status: 'ready',
      primary: `${formatMoney(20000)} gross`, secondary: '1 employees · approved', href: '/payroll/runs',
    });
  });
});
