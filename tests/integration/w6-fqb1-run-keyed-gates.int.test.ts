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
import { refuseReversalAgainstPayRun } from '@/modules/accounting/services/payroll/payrollJournalReversalGuard';
import { createPayrollRun, PayrollRunDuplicateError } from '@/modules/accounting/services/payroll/payrollRunHeaders';
import { judgeYearToDate } from '@/modules/accounting/services/payroll/payrollYearToDateGate';
import { estimateAnnualRemuneration } from '@/modules/accounting/services/payroll/sdlLeviabilityService';
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
});

describe('the reversal guard finds a run journal\'s run', () => {
  it('an unlinked "Payroll run 2026-05" journal belongs to the month\'s regular run, never the bonus', async () => {
    let regular = '';
    let je = '';
    const got = await twoRunsInMonth(pool, A, async (c) => {
      [, regular] = await seedBoth(c, [BONUS, REGULAR]);
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

describe('the year-to-date gate orders runs by pay order, not by month', () => {
  it('approving the regular run names the bonus calculated after it as a LATER run', async () => {
    let regular = '';
    const got = await twoRunsInMonth(pool, A, async (c) => {
      [regular] = await seedBoth(c, [
        { ...REGULAR, status: 'calculated', approvedAt: null, calculatedAt: '2026-05-20T08:00:00Z' },
        { ...BONUS, approvedAt: '2026-05-28T09:00:00Z', calculatedAt: '2026-05-27T08:00:00Z' },
      ]);
    }, () => judgeYearToDate(A.company, regular));
    expect(got.blocker?.detail).toMatch(/^A later month of this tax year \(2026-05\)/);
  });
});

describe('the SDL threshold estimate', () => {
  it('counts the earlier run of the run\'s own month', async () => {
    let bonus = '';
    const annual = await twoRunsInMonth(pool, A, async (c) => { [, bonus] = await seedBoth(c, [REGULAR, BONUS]); },
      () => estimateAnnualRemuneration(A.company, { year: 2026, month: 5 }, 5000, bonus));
    // (20 000 regular + 5 000 this run) over the one month of history, times twelve.
    expect(annual).toBe(300000);
  });
});
