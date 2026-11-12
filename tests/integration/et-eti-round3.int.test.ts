/**
 * Wave 5 ET review round 3, against real PostgreSQL:
 *  - R-A blocks only on a later RUN journal in force; a run-less month is rebooked instead (etiRebook.rebookEtiAfterEvent).
 *  - Posting order (earlierUnapprovedRefusal): an earlier calculated, unapproved month refuses; the month's own run never counts.
 *  - Lock 1 first in the reversal guard: a directive reversal that waits on an approval holding lock 1 is judged after it,
 *    and refused when that approval put a later run journal in force. No deadlock.
 *  - adv3 M2: a directive-only October booked before a late September run ends equal to the EMP201; a run-less August
 *    books its refund; the integrity check is green on both.
 * Disposable fixture DB only.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { sql, getPoolForTests } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { earlierUnapprovedRefusal, laterEtiJournalRefusal } from '@/modules/accounting/services/payroll/etiPeriodGuard';
import { postMonthEtiJournal } from '@/modules/accounting/services/payroll/directiveEtiJournal';
import { bookEtiForMonthLocked, rebookEtiAfterEvent } from '@/modules/accounting/services/payroll/etiRebook';
import { lockCompanyPayrollApprovals } from '@/modules/accounting/services/payroll/payrollRunLock';
import { payePayableDiffersFromEmp201 } from '@/modules/accounting/services/gl/integrityChecks/payrollChecks';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { seedFiscalYears } from './helpers/fiscalYearSeed';

const RUNLESS = randomUUID(), ORDER = randomUUID(), RACE = randomUUID(), M2 = randomUUID(), AUG = randomUUID(), USER = randomUUID();
const RUNJUNE = randomUUID(), HAND = randomUUID();
const ALL = [RUNLESS, ORDER, RACE, M2, AUG, RUNJUNE, HAND];
const acc: Record<string, { paye: string; labour: string; refund: string }> = Object.fromEntries(
  ALL.map((c) => [c, { paye: randomUUID(), labour: randomUUID(), refund: randomUUID() }]));
const ids: Record<string, string> = {};

async function inTx<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
  const client: PoolClient = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, companyId, userId: USER, claims: {} } as never, fn);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

/** A posted auto_payroll journal: DR 5200 / CR 2140 (a directive's PAYE, or a run journal's net). */
async function journal(companyId: string, date: string, description: string, amount: number, reference?: string): Promise<string> {
  return inTx(companyId, async () => {
    const je = await createJournalEntry(companyId, {
      entryDate: date, description, source: 'auto_payroll', ...(reference ? { reference } : {}),
      lines: [{ glAccountId: acc[companyId]!.labour, debit: amount, credit: 0 }, { glAccountId: acc[companyId]!.paye, debit: 0, credit: amount }],
    }, USER);
    await postJournalEntry(companyId, je.id, USER);
    return je.id;
  });
}

async function header(companyId: string, y: number, m: number, status: string, paye: number, eti: number, journalId: string | null = null) {
  await sql`INSERT INTO payroll_run_headers (company_id, period_year, period_month, status, total_paye, total_eti, journal_entry_id, calculation_version)
            VALUES (${companyId}::UUID, ${y}, ${m}, ${status}, ${paye}, ${eti}, ${journalId}::UUID, 8)`;
}

async function directive(companyId: string, date: string, paye: number): Promise<string> {
  const dj = await journal(companyId, date, 'SARS directive D1 — Emp', paye);
  const d = (await sql`INSERT INTO tax_directives (company_id, employee_name, directive_type, amount, effective_date, status, directive_number)
                       VALUES (${companyId}::UUID, 'Emp', 'severance', ${paye * 3}, ${date}::date, 'approved', ${'D-' + date}) RETURNING id`) as Array<{ id: string }>;
  await sql`INSERT INTO tax_directive_payments (company_id, tax_directive_id, payment_date, gross_amount, paye_amount, net_amount, journal_entry_id)
            VALUES (${companyId}::UUID, ${d[0]!.id}::UUID, ${date}::date, ${paye * 3}, ${paye}, ${paye * 2}, ${dj}::UUID)`;
  return dj;
}

beforeAll(async () => {
  assertDisposable();
  await sql`INSERT INTO users (id, email, role, is_active) VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
  for (const c of ALL) {
    await sql`INSERT INTO companies (id, name, financial_year_start, default_currency) VALUES (${c}::UUID, ${'ET r3 ' + c.slice(0, 8)}, 3, 'ZAR')`;
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${c}::UUID, ${USER}, 'admin')`;
    await seedFiscalYears(c, '2026-03-01', '2028-02-28');
    await sql`
      INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, level, is_active, account_subtype, is_system_account)
      VALUES (${acc[c]!.paye}::UUID, ${c}::UUID, '2140', 'PAYE Payable', 'liability', 'credit', 3, true, 'payroll_liability', true),
             (${acc[c]!.labour}::UUID, ${c}::UUID, '5200', 'Labour Costs', 'expense', 'debit', 3, true, 'operating_expense', false),
             (${acc[c]!.refund}::UUID, ${c}::UUID, '1150', 'ETI refund receivable (SARS)', 'asset', 'debit', 3, true, 'eti_refund_receivable', true)`;
  }
  // RUNLESS: May with ETI; June has only an ETI journal (no run).
  await header(RUNLESS, 2026, 5, 'approved', 300, 500);
  await journal(RUNLESS, '2026-06-30', 'ETI for 2026-06: directive PAYE', 100, 'ETI-2026-06');
  // RUNJUNE: May with ETI; June's run approved with its journal in force.
  await header(RUNJUNE, 2026, 5, 'approved', 300, 500);
  await header(RUNJUNE, 2026, 6, 'approved', 300, 0, await journal(RUNJUNE, '2026-06-30', 'Payroll run 2026-06', 300));
  // HAND: September's run (PAYE nil, ETI 1 000) in force; an October directive; October's ETI journal books the R1 000 carried.
  await header(HAND, 2026, 9, 'approved', 0, 1_000, await journal(HAND, '2026-09-30', 'Payroll run 2026-09', 0.01));
  await directive(HAND, '2026-10-15', 1_500);
  ids.handEti = (await inTx(HAND, async () => { await lockCompanyPayrollApprovals(null, HAND); return postMonthEtiJournal(HAND, { year: 2026, month: 10 }, '2026-10-15', USER); }))!;
  // An ETI journal in a month whose run journal is in force (September).
  ids.handRunMonthEti = await journal(HAND, '2026-09-30', 'ETI for 2026-09: directive PAYE', 0.01, 'ETI-2026-09');
  // ORDER: March calculated (ETI), April approved, May calculated.
  await header(ORDER, 2026, 3, 'calculated', 300, 500);
  await header(ORDER, 2026, 4, 'approved', 300, 0);
  await header(ORDER, 2026, 5, 'calculated', 300, 0);
  // RACE: April with ETI; a May directive; June calculated with a posted, not yet linked, journal.
  await header(RACE, 2026, 4, 'approved', 200, 2_000);
  ids.raceDirective = await directive(RACE, '2026-05-20', 1_500);
  await header(RACE, 2026, 6, 'calculated', 300, 0);
  ids.raceJune = await journal(RACE, '2026-06-30', 'Payroll run 2026-06', 300);
  // M2: a directive-only October, its ETI booked before September's run exists (nothing carried then).
  await directive(M2, '2026-10-15', 1_500);
  await inTx(M2, async () => { await lockCompanyPayrollApprovals(null, M2); return postMonthEtiJournal(M2, { year: 2026, month: 10 }, '2026-10-15', USER); });
  // AUG: July's run (PAYE nil, ETI 900) is in force; August has no run.
  await header(AUG, 2026, 7, 'approved', 0, 900, await journal(AUG, '2026-07-31', 'Payroll run 2026-07', 0.01));
}, 240000);

afterAll(async () => {
  try {
    await sql`DELETE FROM tax_directive_payments WHERE company_id = ANY(${ALL}::UUID[])`;
    await sql`DELETE FROM tax_directives WHERE company_id = ANY(${ALL}::UUID[])`;
    await sql`DELETE FROM payroll_run_headers WHERE company_id = ANY(${ALL}::UUID[])`;
    await sql`DELETE FROM gl_journal_lines WHERE company_id = ANY(${ALL}::UUID[])`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ANY(${ALL}::UUID[])`;
    await sql`DELETE FROM gl_account_balances WHERE gl_account_id = ANY(${ALL.flatMap((c) => Object.values(acc[c]!))}::UUID[])`;
    await sql`DELETE FROM gl_accounts WHERE company_id = ANY(${ALL}::UUID[])`;
  } finally {
    await getPoolForTests().end();
  }
});

describe('tdd3 H1 as restated (coordinator, round 3): only a later RUN journal in force blocks', () => {
  it("June's in-force run journal refuses May, naming June", async () => {
    expect(await inTx(RUNJUNE, () => laterEtiJournalRefusal(RUNJUNE, { year: 2026, month: 5 }))).toMatch(/June 2026 payroll journal is in the ledger/);
  });
  it('June with only an ETI-2026-06 journal does not refuse May, and June is rebooked to the EMP201 when May changes', async () => {
    expect(await inTx(RUNLESS, () => laterEtiJournalRefusal(RUNLESS, { year: 2026, month: 5 }))).toBeNull();
    const june = async () => (await inTx(RUNLESS, () => payePayableDiffersFromEmp201({ companyId: RUNLESS, asAt: '2026-06-30', limit: 20 })))
      .sample.filter((x) => x.label === '2026-06');
    expect((await june()).length).toBeGreaterThan(0); // June's ETI journal no longer matches what the EMP201 declares
    await inTx(RUNLESS, async () => { await lockCompanyPayrollApprovals(null, RUNLESS); return rebookEtiAfterEvent(RUNLESS, { year: 2026, month: 5 }, USER); });
    expect(await june()).toEqual([]);
  });
});

describe('posting order (earlierUnapprovedRefusal)', () => {
  it('May is refused while March is calculated and unapproved', async () => {
    expect(await inTx(ORDER, () => earlierUnapprovedRefusal(ORDER, { year: 2026, month: 5 }))).toMatch(/March 2026 pay run is calculated but not approved/);
  });
  it('March itself (the start of the period) is never refused, and its own calculated run does not count', async () => {
    expect(await inTx(ORDER, () => earlierUnapprovedRefusal(ORDER, { year: 2026, month: 3 }))).toBeNull();
  });
});

describe('lock 1 first in the reversal guard', () => {
  it('a directive reversal waiting on an approval that puts June in force is refused, with no deadlock', async () => {
    let locked!: () => void;
    const holding = new Promise<void>((r) => { locked = r; });
    const approval = inTx(RACE, async () => {
      await lockCompanyPayrollApprovals(null, RACE);
      locked();
      await new Promise((r) => setTimeout(r, 500));
      await sql`UPDATE payroll_run_headers SET status = 'approved', journal_entry_id = ${ids.raceJune}::UUID
                 WHERE company_id = ${RACE}::UUID AND period_month = 6`;
    });
    await holding;
    const reversal = inTx(RACE, () => reverseJournalEntry(RACE, ids.raceDirective!, USER));
    const [a, r] = await Promise.allSettled([approval, reversal]);
    expect(a.status).toBe('fulfilled');
    expect(r.status).toBe('rejected');
    expect(String((r as PromiseRejectedResult).reason)).toMatch(/June 2026 payroll journal is in the ledger/);
    expect(String((r as PromiseRejectedResult).reason)).not.toMatch(/deadlock/i);
  });
});

describe('adv3 M2/M3: run-less months are rebooked and the integrity check is green', () => {
  it('a late September run carrying R1 000 into a directive-only October: October ends equal to the EMP201', async () => {
    await header(M2, 2026, 9, 'approved', 0, 1_000, await journal(M2, '2026-09-30', 'Payroll run 2026-09', 0.01));
    await inTx(M2, async () => { await lockCompanyPayrollApprovals(null, M2); return rebookEtiAfterEvent(M2, { year: 2026, month: 9 }, USER); });
    const r = await inTx(M2, () => payePayableDiffersFromEmp201({ companyId: M2, asAt: '2026-10-31', limit: 20 }));
    expect(r.sample.filter((s) => s.label === '2026-10')).toEqual([]);
  });
  it('a run-less August books its refund (R900, no PAYE to use it), and August is green', async () => {
    await inTx(AUG, async () => { await lockCompanyPayrollApprovals(null, AUG); return rebookEtiAfterEvent(AUG, { year: 2026, month: 7 }, USER); });
    const refund = (await sql`
      SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::float8 AS n FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
       WHERE je.company_id = ${AUG}::UUID AND je.reference = 'ETI-2026-08' AND jl.gl_account_id = ${acc[AUG]!.refund}::UUID`) as Array<{ n: number }>;
    expect(refund[0]!.n).toBe(900);
    const r = await inTx(AUG, () => payePayableDiffersFromEmp201({ companyId: AUG, asAt: '2026-08-31', limit: 20 }));
    expect(r.sample.filter((s) => s.label === '2026-08')).toEqual([]);
  });
});

describe('round 5 ruling: an ETI journal is never reversed by hand; the integrity remedy names only actions that work', () => {
  const msg = "ETI journals are rebooked automatically; to write off an ETI amount SARS won't pay, post a manual journal";
  it('a hand reversal of ETI-2026-10 (a run-less month) is refused, and so is ETI-2026-09 (a month whose run journal is in force)', async () => {
    await expect(inTx(HAND, () => reverseJournalEntry(HAND, ids.handEti!, USER))).rejects.toThrow(msg);
    await expect(inTx(HAND, () => reverseJournalEntry(HAND, ids.handRunMonthEti!, USER))).rejects.toThrow(msg);
    const live = (await sql`SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id = ${HAND}::UUID AND reversal_of_id IS NOT NULL`) as Array<{ n: number }>;
    expect(live[0]!.n).toBe(0);
  });
  it('October red after September changes: the finding names "Book ETI for this month", and pressing it turns October green', async () => {
    const oct = async () => inTx(HAND, () => payePayableDiffersFromEmp201({ companyId: HAND, asAt: '2026-10-31', limit: 20 }));
    expect((await oct()).sample.filter((x) => x.label === '2026-10')).toEqual([]);
    // September re-approved with ETI R400 instead of R1 000 (the header carries what the EMP201 declares).
    await sql`UPDATE payroll_run_headers SET total_eti = 400 WHERE company_id = ${HAND}::UUID AND period_month = 9`;
    const red = await oct();
    expect(red.sample.filter((x) => x.label === '2026-10')).toHaveLength(1);
    expect(red.finding).toContain('"Book ETI for this month"');
    expect(red.finding).not.toMatch(/reversed by hand|re-apply/);
    expect((await inTx(HAND, () => bookEtiForMonthLocked(HAND, { year: 2026, month: 10 }, USER))).status).toBe('booked');
    expect((await oct()).sample.filter((x) => x.label === '2026-10')).toEqual([]);
  });
});
