/**
 * Wave 6 FQb1: the run-keyed GATES and WRITERS (census class R, owner FQb1), each with two runs in one month: a
 * regular run and an off-cycle bonus run of the same calendar month, the per-month unique dropped inside the case's
 * own rolled-back transaction (w6-fqb1.helpers.ts). Company B holds the same shape at 10x.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropTenants, seedRun, seedTenant, twoRunsInMonth, type RunSpec, type Tenant } from './w6-fqb1.helpers';
import { bookedRunJournalsByMonth } from '@/modules/accounting/services/payroll/etiBooking';
import { etiForRun } from '@/modules/accounting/services/payroll/payrollJournalEti';
import { loadEtiMonths } from '@/modules/accounting/services/payroll/etiCarryRead';
import { etiCarryLedger } from '@/modules/accounting/services/payroll/etiCarry';
import { refuseReversalAgainstPayRun } from '@/modules/accounting/services/payroll/payrollJournalReversalGuard';
import { createPayrollRun, PayrollRunDuplicateError } from '@/modules/accounting/services/payroll/payrollRunHeaders';
import { judgeYearToDate } from '@/modules/accounting/services/payroll/payrollYearToDateGate';
import { loadPayeYearToDate } from '@/modules/accounting/services/payroll/payrollYearToDate';
import { estimateAnnualRemuneration } from '@/modules/accounting/services/payroll/sdlLeviabilityService';
import { sdlMonthSplitRefusal } from '@/modules/accounting/services/payroll/payrollSdlMonthGate';
import { runLinesRefusal } from '@/modules/accounting/services/payroll/payrollRunRecalcGate';
import { sql } from '@/lib/neon';
import { createPayRunTool } from '@/lib/mcp/tools/writePayroll';
import type { McpToolContext } from '@/lib/mcp/types';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let A: Tenant;
let B: Tenant;

const REGULAR: RunSpec = { year: 2026, month: 5, runDate: '2026-05-25', gross: 20000, paye: 2000 };
const BONUS: RunSpec = { year: 2026, month: 5, runDate: '2026-05-28', offCycle: true, gross: 5000, paye: 700 };
const x10 = (r: RunSpec): RunSpec => ({ ...r, gross: (r.gross ?? 10000) * 10, paye: (r.paye ?? 1000) * 10 });

async function seedBoth(c: PoolClient, aRuns: RunSpec[]): Promise<string[]> {
  for (const r of aRuns) await seedRun(c, B, x10(r));
  const ids: string[] = [];
  for (const r of aRuns) ids.push(await seedRun(c, A, r));
  return ids;
}

/** A posted auto_payroll journal crediting 2140 by `paye2140`; unlinked unless a header names it. */
async function payrollJournal(c: PoolClient, t: Tenant, paye2140: number, description = 'Payroll run 2026-05'): Promise<string> {
  const account = (await c.query(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level)
     VALUES ($1, '2140', 'PAYE payable', 'liability', 'credit', 1)
     ON CONFLICT DO NOTHING RETURNING id`, [t.company])).rows[0]?.id
    ?? (await c.query("SELECT id FROM gl_accounts WHERE company_id = $1 AND account_code = '2140'", [t.company])).rows[0].id;
  const je = String((await c.query(
    `INSERT INTO gl_journal_entries (company_id, entry_date, created_by, status, source, description, reference)
     VALUES ($1, '2026-05-31', $2, 'posted', 'auto_payroll', $3, 'PAY-2026-05') RETURNING id`, [t.company, t.user, description])).rows[0].id);
  await c.query('INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, company_id, debit, credit) VALUES ($1, $2, $3, 0, $4)',
    [je, account, t.company, paye2140]);
  return je;
}

beforeAll(async () => {
  A = await seedTenant(pool, 'W6 FQb1 gates A');
  B = await seedTenant(pool, 'W6 FQb1 gates B');
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM gl_accounts WHERE company_id = ANY($1)', [[A.company, B.company]]);
    await dropTenants(pool, [A, B]);
  } finally { await pool.end(); }
});

describe('ETI booked by the month\'s run journals (EMP201 carry, integrity check)', () => {
  it('adds up every in-force run journal of the month', async () => {
    const got = await twoRunsInMonth(pool, A, async (c) => {
      for (const [t, k] of [[B, 10], [A, 1]] as const) {
        await seedRun(c, t, { ...BONUS, paye: 700 * k, gross: 5000 * k, journal: await payrollJournal(c, t, 700 * k) });
        await seedRun(c, t, { ...REGULAR, paye: 2000 * k, gross: 20000 * k, journal: await payrollJournal(c, t, 1800 * k) });
      }
    }, () => bookedRunJournalsByMonth(A.company, [{ year: 2026, month: 5 }]));
    // PAYE 2700 declared, 2500 credited to 2140: 200 of ETI used.
    expect(got.get('2026-05')).toEqual({ used: 200, refund: 0, net2140: 2500 });
  });

  // Review #1507 B1: April carries R4,000 of ETI into May; May's two runs have R3,000 PAYE each. The EMP201 uses R4,000.
  // The regular run's journal is posted first and booked R3,000; the bonus's journal may book only the R1,000 left.
  it('the second run journal of the month books only the ETI the first left (together = the EMP201\'s)', async () => {
    let bonus = '';
    const got = await twoRunsInMonth(pool, A, async (c) => {
      const apr = await seedRun(c, A, { year: 2026, month: 4, runDate: '2026-04-25', gross: 20000, paye: 1000 });
      await c.query('UPDATE payroll_run_headers SET total_eti = 5000 WHERE id = $1', [apr]);
      // The regular run's journal: PAYE 3000, all of it met by ETI, so nothing credited to 2140.
      await seedRun(c, A, { ...REGULAR, paye: 3000, journal: await payrollJournal(c, A, 0) });
      bonus = await seedRun(c, A, { ...BONUS, paye: 3000 });
    }, async () => {
      const ym = { year: 2026, month: 5 };
      const regularBooked = (await bookedRunJournalsByMonth(A.company, [ym])).get('2026-05')!.used;
      const bon = await etiForRun(A.company, ym, { paye: 3000, eti: 0 }, bonus);
      const ledger = etiCarryLedger({ year: 2026, month: 3 }, ym, await loadEtiMonths(A.company, { year: 2026, month: 3 }, ym));
      return { regularBooked, bonusBooks: bon.etiUsed, emp201: ledger.find((m) => m.month === 5)!.used };
    });
    expect(got).toEqual({ regularBooked: 3000, bonusBooks: 1000, emp201: 4000 });
  });
});

describe('the reversal guard finds a run journal\'s run', () => {
  it.each([false, true])('an unlinked "Payroll run 2026-05" journal belongs to the month\'s regular run, never the bonus (regular seeded first: %s)', async (regularFirst) => {
    let regular = '';
    let je = '';
    const got = await twoRunsInMonth(pool, A, async (c) => {
      const ids = await seedBoth(c, regularFirst ? [REGULAR, BONUS] : [BONUS, REGULAR]);
      regular = ids[regularFirst ? 0 : 1]!;
      je = await payrollJournal(c, A, 1800);
    }, () => refuseReversalAgainstPayRun(A.company, { id: je, source: 'auto_payroll' }));
    expect(got?.runId).toBe(regular);
  });
});

describe('creating a regular run beside an off-cycle run of the month', () => {
  it('is allowed once, and a second regular run of the month is the named duplicate', async () => {
    const created = await twoRunsInMonth(pool, A, async (c) => { await seedBoth(c, [BONUS]); }, async () => {
      const run = await createPayrollRun(A.company, { month: 5, year: 2026 }, A.user);
      const again = await createPayrollRun(A.company, { month: 5, year: 2026 }, A.user).then(() => null, (e: unknown) => e);
      return { run, again };
    });
    expect(created.run).toMatchObject({ periodMonth: 5, periodYear: 2026, runKind: 'regular', payFrequency: 'monthly' });
    expect(created.again).toBeInstanceOf(PayrollRunDuplicateError);
  });

  it('today\'s schema (month unique kept): a month holding only an off-cycle run is the named duplicate, not a raw 23505', async () => {
    const got = await twoRunsInMonth(pool, A, async (c) => { await seedRun(c, A, BONUS); }, async () => {
      const again = await createPayrollRun(A.company, { month: 5, year: 2026 }, A.user).then(() => null, (e: unknown) => e);
      // Its own savepoint: the request's transaction is still usable after the refusal (review #1507 B5).
      const after = ((await sql`SELECT 1 AS ok`) as Array<{ ok: number }>)[0]?.ok;
      return { again, after };
    }, { keepMonthKey: true });
    expect(got.again).toBeInstanceOf(PayrollRunDuplicateError);
    expect(got.after).toBe(1);
  });

  it('create_pay_run (MCP) dry run: the bonus is no clash, a regular run is', async () => {
    const ctx = { companyId: A.company, userId: A.user, scopes: ['write:payroll'], tokenJti: null, oauthAppId: null, role: 'admin' } as McpToolContext;
    const dry = () => createPayRunTool.handler({ month: 5, year: 2026, dry_run: true, idempotency_key: crypto.randomUUID() }, ctx)
      .then((r) => JSON.parse((r as { content: Array<{ text: string }> }).content[0]!.text) as { skipped: Array<{ reason: string }> });
    const bonusOnly = await twoRunsInMonth(pool, A, async (c) => { await seedBoth(c, [BONUS]); }, dry);
    expect(bonusOnly.skipped).toEqual([]);
    const both = await twoRunsInMonth(pool, A, async (c) => { await seedBoth(c, [BONUS, REGULAR]); }, dry);
    expect(both.skipped.map((s) => s.reason)).toEqual(['period_already_exists']);
  });
});

describe('the year-to-date gate and figure: pay order, moved together (wave 6 FQc, spec F2)', () => {
  // Review #1507 B2a: the gate and loadPayeYearToDate must agree on "earlier". FQb1 held both to the month; FQc moved
  // both onto payrollRunOrder: a May bonus (off-cycle after the regular run) has May's regular run in its year to date,
  // so the gate rightly calls that run earlier and covered.
  it('passes a bonus calculated after the month\'s regular run was approved, and its figure reads that run', async () => {
    let bonus = '';
    const got = await twoRunsInMonth(pool, A, async (c) => {
      await seedRun(c, A, { ...REGULAR, approvedAt: '2026-05-21T08:00:00Z', calculatedAt: '2026-05-20T08:00:00Z' });
      bonus = await seedRun(c, A, { ...BONUS, status: 'calculated', approvedAt: null, calculatedAt: '2026-05-27T08:00:00Z' });
    }, async () => ({
      blocker: (await judgeYearToDate(A.company, bonus)).blocker,
      ytd: (await loadPayeYearToDate(A.company, bonus, { year: 2026, month: 5 }, [A.employee])).get(A.employee),
    }));
    expect(got.blocker).toBeNull();
    expect(got.ytd?.periodicTaxable).toBe(REGULAR.gross);
  });
});

describe('the SDL threshold: one decision per month, whatever the calculation or pay order', () => {
  const estimate = (runId: string, current: number) => estimateAnnualRemuneration(A.company, { year: 2026, month: 5 }, current, runId);

  it.each([false, true])('both runs of a month are estimated on the month total (seeded reversed: %s)', async (flip) => {
    let regular = '';
    let bonus = '';
    const got = await twoRunsInMonth(pool, A, async (c) => {
      const runs = [{ ...REGULAR, gross: 30000, status: 'calculated', approvedAt: null }, { ...BONUS, gross: 20000, status: 'calculated', approvedAt: null }];
      const ids = await seedBoth(c, flip ? [...runs].reverse() : runs);
      [regular, bonus] = flip ? [ids[1]!, ids[0]!] : [ids[0]!, ids[1]!];
    }, async () => ({ regular: await estimate(regular, 30000), bonus: await estimate(bonus, 20000) }));
    // (30 000 + 20 000) x 12 = 600 000 for both: liable both.
    expect(got).toEqual({ regular: 600000, bonus: 600000 });
  });

  // Review #1507 B4c: a bonus paid BEFORE the regular run no longer decides the month alone.
  it('a bonus dated before the regular run: the regular run is estimated on the whole month (liable)', async () => {
    let regular = '';
    const got = await twoRunsInMonth(pool, A, async (c) => {
      await seedRun(c, A, { ...BONUS, runDate: '2026-05-15', gross: 20000, status: 'calculated', approvedAt: null });
      regular = await seedRun(c, A, { ...REGULAR, runDate: '2026-05-25', gross: 50000, status: 'calculated', approvedAt: null });
    }, () => estimate(regular, 50000));
    expect(got).toBe(840000);
  });

  // Review #1507 (arch M): a zero-cash first run (benefits-only off-cycle) adds nothing; it does not zero the month.
  it('a first run with no remuneration leaves the month\'s estimate to the run that has it', async () => {
    let bonus = '';
    const got = await twoRunsInMonth(pool, A, async (c) => {
      bonus = await seedRun(c, A, { ...BONUS, runDate: '2026-05-05', gross: 0, paye: 0, status: 'calculated', approvedAt: null });
      await seedRun(c, A, { ...REGULAR, gross: 50000, status: 'calculated', approvedAt: null });
    }, () => estimate(bonus, 0));
    expect(got).toBe(600000);
  });

  // Review #1507 B4b: the bonus was calculated while the regular run was a draft, so it decided alone (exempt). Once the
  // regular run is calculated (liable), approving the bonus is refused until it is recalculated, which then agrees.
  it('a run decided before its month\'s other run existed is refused at approval, and its recalculation agrees', async () => {
    let regular = '';
    let bonus = '';
    const got = await twoRunsInMonth(pool, A, async (c) => {
      bonus = await seedRun(c, A, { ...BONUS, gross: 20000, status: 'calculated', approvedAt: null, sdlExempt: true });
      regular = await seedRun(c, A, { ...REGULAR, gross: 50000, status: 'calculated', approvedAt: null, sdlExempt: false });
    }, async () => ({
      refusal: await runLinesRefusal(A.company, bonus),
      direct: await sdlMonthSplitRefusal(A.company, bonus),
      recalculated: await estimate(bonus, 20000),
      regular: await estimate(regular, 50000),
    }));
    expect(got.refusal?.code).toBe('sdl_month_split');
    expect(got.direct?.detail).toMatch(/is liable for SDL, but a run was costed the other way\. To approve: recalculate this run\.$/);
    expect(got.recalculated).toBe(840000);
    expect(got.regular).toBe(840000);
  });

  it('when the stale run is the approved other one, the refusal names it: reopen and recalculate; runs that agree pass', async () => {
    let bonus = '';
    let regular = '';
    const split = await twoRunsInMonth(pool, A, async (c) => {
      regular = await seedRun(c, A, { ...REGULAR, gross: 50000, sdlExempt: true });
      bonus = await seedRun(c, A, { ...BONUS, gross: 20000, status: 'calculated', approvedAt: null, sdlExempt: false });
    }, () => sdlMonthSplitRefusal(A.company, bonus));
    expect(split?.detail).toContain(`To approve: reopen and recalculate the regular run ${regular} (approved).`);
    const agree = await twoRunsInMonth(pool, A, async (c) => {
      await seedRun(c, A, { ...REGULAR, gross: 50000, sdlExempt: false });
      bonus = await seedRun(c, A, { ...BONUS, gross: 20000, status: 'calculated', approvedAt: null, sdlExempt: false });
    }, () => sdlMonthSplitRefusal(A.company, bonus));
    expect(agree).toBeNull();
  });

  // Review #1507 arch M (the mirror of B4b): the bonus was costed alone (exempt), then the regular run with it (liable).
  // Approving the REGULAR run is refused naming the BONUS (recalculating the regular run would change nothing); once
  // the bonus is recalculated (liable), the regular run's approval passes.
  it('approving the later-costed run names the other, stale run; once that is recalculated the gate passes', async () => {
    let regular = '';
    let bonus = '';
    const got = await twoRunsInMonth(pool, A, async (c) => {
      bonus = await seedRun(c, A, { ...BONUS, gross: 20000, status: 'calculated', approvedAt: null, sdlExempt: true });
      regular = await seedRun(c, A, { ...REGULAR, gross: 50000, status: 'calculated', approvedAt: null, sdlExempt: false });
    }, async () => {
      const before = await sdlMonthSplitRefusal(A.company, regular);
      await sql`UPDATE payroll_run_lines SET sdl_exempt = false WHERE run_id = ${bonus}::uuid`; // the bonus, recalculated
      return { before, after: await sdlMonthSplitRefusal(A.company, regular) };
    });
    expect(got.before?.detail).toContain(`To approve: recalculate the off_cycle run ${bonus} (calculated).`);
    expect(got.before?.detail).not.toContain('this run');
    expect(got.after).toBeNull();
  });

  // Review #1507 G2: the month changed under a run (a run of it cancelled): its stored decision is re-judged, not just
  // compared with the other runs' (here there are none left to compare with).
  it('a run whose month lost a run since it was costed is refused on its own stale decision', async () => {
    let regular = '';
    const got = await twoRunsInMonth(pool, A, async (c) => {
      regular = await seedRun(c, A, { ...REGULAR, gross: 30000, status: 'calculated', approvedAt: null, sdlExempt: false });
      await seedRun(c, A, { ...BONUS, gross: 20000, status: 'cancelled', approvedAt: null, sdlExempt: false });
    }, () => sdlMonthSplitRefusal(A.company, regular));
    // 30 000 x 12 = 360 000 now: exempt, but the run was costed liable on 50 000.
    expect(got?.detail).toMatch(/is below the R500 000 SDL threshold \(exempt\), but a run was costed the other way\. To approve: recalculate this run\.$/);
  });

  it('a paid run is final: never named, never blocking', async () => {
    let bonus = '';
    const got = await twoRunsInMonth(pool, A, async (c) => {
      await seedRun(c, A, { ...REGULAR, gross: 50000, status: 'paid', sdlExempt: true });
      bonus = await seedRun(c, A, { ...BONUS, gross: 20000, status: 'calculated', approvedAt: null, sdlExempt: false });
    }, () => sdlMonthSplitRefusal(A.company, bonus));
    expect(got).toBeNull();
  });
});
