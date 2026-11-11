/**
 * Wave 5 ET review round 4, against real PostgreSQL (disposable fixture DB only):
 *  - M1 (adv Repro A): no August run, July approved on 28 July (August not ended: nothing to book then); a September
 *    trigger books August's refund, and so does the explicit "Book ETI for this month" action.
 *  - M1 (adv Repro B): a directive-only November; October changed on 12 November (November not ended: not rebooked, so
 *    November is red); after November ends the next trigger, or the action, brings it to the EMP201.
 *  - M2: a run-less month whose fiscal period is closed is booked on the first open date, no ClosedFiscalPeriodError,
 *    and the integrity check (which reads the ETI-YYYY-MM reference) is green for it.
 *  - tdd M1: May is refused when only August, the period's last month, has an in-force run journal.
 *  - tdd L1: April calculated and unapproved refuses May; April's own run never refuses April.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { sql, getPoolForTests } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostService';
import { earlierUnapprovedRefusal, laterEtiJournalRefusal } from '@/modules/accounting/services/payroll/etiPeriodGuard';
import { postMonthEtiJournal } from '@/modules/accounting/services/payroll/directiveEtiJournal';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { bookEtiForMonthLocked, rebookEtiAfterEvent } from '@/modules/accounting/services/payroll/etiRebook';
import { lockCompanyPayrollApprovals } from '@/modules/accounting/services/payroll/payrollRunLock';
import { payePayableDiffersFromEmp201 } from '@/modules/accounting/services/gl/integrityChecks/payrollChecks';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { seedFiscalYears, setPeriodsEndingBy } from './helpers/fiscalYearSeed';

const REPRO_A = randomUUID(), ACTION_A = randomUUID(), REPRO_B = randomUUID(), CLOSED = randomUUID(), ONLY_AUG = randomUUID(), APRIL = randomUUID();
const USER = randomUUID();
const NO_OPEN = randomUUID(), AGENT = randomUUID();
const ALL = [REPRO_A, ACTION_A, REPRO_B, CLOSED, ONLY_AUG, APRIL, NO_OPEN, AGENT];
const ids: Record<string, string> = {};
const acc: Record<string, { paye: string; labour: string; refund: string }> = Object.fromEntries(
  ALL.map((c) => [c, { paye: randomUUID(), labour: randomUUID(), refund: randomUUID() }]));

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
async function journal(companyId: string, date: string, description: string, amount: number): Promise<string> {
  return inTx(companyId, async () => {
    const je = await createJournalEntry(companyId, {
      entryDate: date, description, source: 'auto_payroll',
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

const locked = <T>(c: string, fn: () => Promise<T>) => inTx(c, async () => { await lockCompanyPayrollApprovals(null, c); return fn(); });
const redMonths = async (c: string, asAt: string, label: string) =>
  (await inTx(c, () => payePayableDiffersFromEmp201({ companyId: c, asAt, limit: 20 }))).sample.filter((s) => s.label === label);
async function etiJournals(c: string, reference: string) {
  return (await sql`
    SELECT to_char(je.entry_date, 'YYYY-MM-DD') AS d,
           COALESCE(SUM(CASE WHEN jl.gl_account_id = ${acc[c]!.refund}::UUID THEN jl.debit - jl.credit ELSE 0 END), 0)::float8 AS refund
      FROM gl_journal_entries je JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
     WHERE je.company_id = ${c}::UUID AND je.reference = ${reference} AND je.status = 'posted'
     GROUP BY je.id, je.entry_date ORDER BY je.entry_date`) as Array<{ d: string; refund: number }>;
}

beforeAll(async () => {
  assertDisposable();
  await sql`INSERT INTO users (id, email, role, is_active) VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
  for (const c of ALL) {
    await sql`INSERT INTO companies (id, name, financial_year_start, default_currency) VALUES (${c}::UUID, ${'ET r4 ' + c.slice(0, 8)}, 3, 'ZAR')`;
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${c}::UUID, ${USER}, 'admin')`;
    await seedFiscalYears(c, '2026-03-01', '2028-02-28');
    await sql`
      INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, level, is_active, account_subtype, is_system_account)
      VALUES (${acc[c]!.paye}::UUID, ${c}::UUID, '2140', 'PAYE Payable', 'liability', 'credit', 3, true, 'payroll_liability', true),
             (${acc[c]!.labour}::UUID, ${c}::UUID, '5200', 'Labour Costs', 'expense', 'debit', 3, true, 'operating_expense', false),
             (${acc[c]!.refund}::UUID, ${c}::UUID, '1150', 'ETI refund receivable (SARS)', 'asset', 'debit', 3, true, 'eti_refund_receivable', true)`;
  }
  // Repro A (and its action twin): July's run in force (PAYE nil, ETI 900); no August run.
  for (const c of [REPRO_A, ACTION_A, CLOSED, NO_OPEN]) await header(c, 2026, 7, 'approved', 0, 900, await journal(c, '2026-07-28', 'Payroll run 2026-07', 0.01));
  // CLOSED: everything to the end of August is closed after July's journal posted; September is open.
  await setPeriodsEndingBy(CLOSED, '2026-08-31', 'closed');
  // NO_OPEN: every seeded period closed, so nothing is open on or after August's end.
  await setPeriodsEndingBy(NO_OPEN, '2028-02-28', 'closed');
  // Repro B: October's run (PAYE nil, ETI 1 000) in force; a November directive (PAYE 1 500) whose ETI journal used R1 000.
  await header(REPRO_B, 2026, 10, 'approved', 0, 1_000, await journal(REPRO_B, '2026-10-31', 'Payroll run 2026-10', 0.01));
  await directive(REPRO_B, '2026-11-10', 1_500);
  await locked(REPRO_B, () => postMonthEtiJournal(REPRO_B, { year: 2026, month: 11 }, '2026-11-10', USER));
  // AGENT: April's run (PAYE nil, ETI 1 000) in force; a May directive (PAYE 1 500) whose ETI journal used R1 000.
  await header(AGENT, 2026, 4, 'approved', 0, 1_000, await journal(AGENT, '2026-04-30', 'Payroll run 2026-04', 0.01));
  ids.agentDirective = await directive(AGENT, '2026-05-20', 1_500);
  await locked(AGENT, () => postMonthEtiJournal(AGENT, { year: 2026, month: 5 }, '2026-05-20', USER));
  // ONLY_AUG: May with ETI; only August has a run journal in force.
  await header(ONLY_AUG, 2026, 5, 'approved', 300, 500);
  await header(ONLY_AUG, 2026, 8, 'approved', 300, 0, await journal(ONLY_AUG, '2026-08-31', 'Payroll run 2026-08', 300));
  // APRIL: April calculated (with ETI), May calculated.
  await header(APRIL, 2026, 4, 'calculated', 300, 500);
  await header(APRIL, 2026, 5, 'calculated', 300, 0);
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

describe('M1 adv Repro A: a run-less August\'s refund', () => {
  it('July approved on 28 July books nothing for August (not ended); a September trigger books the R900 refund; August is green', async () => {
    expect(await locked(REPRO_A, () => rebookEtiAfterEvent(REPRO_A, { year: 2026, month: 7 }, USER, '2026-07-28'))).toEqual([]);
    expect(await etiJournals(REPRO_A, 'ETI-2026-08')).toEqual([]);
    await locked(REPRO_A, () => rebookEtiAfterEvent(REPRO_A, { year: 2026, month: 9 }, USER, '2026-09-30'));
    expect(await etiJournals(REPRO_A, 'ETI-2026-08')).toEqual([{ d: '2026-08-31', refund: 900 }]);
    expect(await redMonths(REPRO_A, '2026-08-31', '2026-08')).toEqual([]);
  });
  it('the explicit action books it too, and a second press posts nothing (idempotent)', async () => {
    expect((await inTx(ACTION_A, () => bookEtiForMonthLocked(ACTION_A, { year: 2026, month: 8 }, USER))).status).toBe('booked');
    expect((await inTx(ACTION_A, () => bookEtiForMonthLocked(ACTION_A, { year: 2026, month: 8 }, USER))).status).toBe('nothing_to_book');
    expect(await etiJournals(ACTION_A, 'ETI-2026-08')).toEqual([{ d: '2026-08-31', refund: 900 }]);
    expect(await redMonths(ACTION_A, '2026-08-31', '2026-08')).toEqual([]);
  });
});

describe('M1 adv Repro B: a directive-only November after October changes on 12 November', () => {
  it('not rebooked before November ends (red), then the next trigger after month end brings it to the EMP201 (green)', async () => {
    // October reopened and re-approved on 12 November with ETI R400 instead of R1 000 (the header carries what the EMP201 declares).
    await sql`UPDATE payroll_run_headers SET total_eti = 400 WHERE company_id = ${REPRO_B}::UUID AND period_month = 10`;
    await locked(REPRO_B, () => rebookEtiAfterEvent(REPRO_B, { year: 2026, month: 10 }, USER, '2026-11-12'));
    expect((await redMonths(REPRO_B, '2026-11-30', '2026-11')).length).toBeGreaterThan(0);
    await locked(REPRO_B, () => rebookEtiAfterEvent(REPRO_B, { year: 2026, month: 12 }, USER, '2026-12-01'));
    expect(await redMonths(REPRO_B, '2026-11-30', '2026-11')).toEqual([]);
  });
});

describe('M2: a closed period', () => {
  it('August closed: its rebook is dated the first open date (1 September), no ClosedFiscalPeriodError; ETI-2026-08 keeps August green', async () => {
    await locked(CLOSED, () => rebookEtiAfterEvent(CLOSED, { year: 2026, month: 9 }, USER, '2026-09-30'));
    expect(await etiJournals(CLOSED, 'ETI-2026-08')).toEqual([{ d: '2026-09-01', refund: 900 }]);
    expect(await redMonths(CLOSED, '2026-08-31', '2026-08')).toEqual([]);
  });
});

describe('the period guards', () => {
  it('tdd M1: May is refused when only August, the last month of the period, has its run journal in force', async () => {
    expect(await inTx(ONLY_AUG, () => laterEtiJournalRefusal(ONLY_AUG, { year: 2026, month: 5 }))).toMatch(/August 2026 payroll journal is in the ledger/);
  });
  it('tdd L1: April calculated and unapproved refuses May; April\'s own run never refuses April', async () => {
    expect(await inTx(APRIL, () => earlierUnapprovedRefusal(APRIL, { year: 2026, month: 5 }))).toMatch(/April 2026 pay run is calculated but not approved/);
    expect(await inTx(APRIL, () => earlierUnapprovedRefusal(APRIL, { year: 2026, month: 4 }))).toBeNull();
  });
});

describe('tdd L1: the action\'s other outcomes', () => {
  it('no open fiscal period after the month end: skipped (no_open_period), nothing posted, never a ClosedFiscalPeriodError', async () => {
    const r = await inTx(NO_OPEN, () => bookEtiForMonthLocked(NO_OPEN, { year: 2026, month: 8 }, USER));
    expect(r).toMatchObject({ status: 'no_open_period', journalEntryId: null });
    expect(await etiJournals(NO_OPEN, 'ETI-2026-08')).toEqual([]);
  });
  it('a month whose run journal is in force: run_journal_in_force, nothing posted (the run books its own ETI)', async () => {
    const r = await inTx(ACTION_A, () => bookEtiForMonthLocked(ACTION_A, { year: 2026, month: 7 }, USER));
    expect(r).toMatchObject({ status: 'run_journal_in_force', journalEntryId: null });
    expect(await etiJournals(ACTION_A, 'ETI-2026-07')).toEqual([]);
  });
});

describe('rev L1: a connector\'s directive reversal stamps the ETI it rebooks as the agent\'s', () => {
  it('reversing the May directive with a posting agent: the negative ETI-2026-05 journal carries that agent', async () => {
    await inTx(AGENT, () => reverseJournalEntry(AGENT, ids.agentDirective!, USER, { postingAgent: 'mcp:reverse_journal_entry:v1' }));
    const rows = (await sql`
      SELECT posting_agent FROM gl_journal_entries
       WHERE company_id = ${AGENT}::UUID AND reference = 'ETI-2026-05' ORDER BY created_at`) as Array<{ posting_agent: string }>;
    expect(rows).toHaveLength(2); // the directive's own, then the reversal's difference
    expect(rows[1]!.posting_agent).toBe('mcp:reverse_journal_entry:v1');
  });
});
