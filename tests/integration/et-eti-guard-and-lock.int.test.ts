/**
 * Wave 5 ET review round 2, against real PostgreSQL:
 *  - R-A's month range (Hein ruling, redesigned): only in an ETI period, only under a LATER month's journal IN FORCE.
 *    May is refused while June is in force; June is not refused by May; periods end in August and February.
 *  - The company payroll lock serialises ETI booking: two concurrent ETI bookings for one month book it once, and a run
 *    journal posted under the lock is seen by the ETI booking that waited for it.
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
import { laterEtiJournalRefusal } from '@/modules/accounting/services/payroll/etiPeriodGuard';
import { postMonthEtiJournal } from '@/modules/accounting/services/payroll/directiveEtiJournal';
import { bookedByEtiJournals } from '@/modules/accounting/services/payroll/etiBooking';
import { lockCompanyPayrollApprovals } from '@/modules/accounting/services/payroll/payrollRunLock';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { seedFiscalYears } from './helpers/fiscalYearSeed';

const GUARD = randomUUID(), PLAIN = randomUUID(), RACE = randomUUID(), USER = randomUUID();
const ALL = [GUARD, PLAIN, RACE];
let directiveJournal = '';
const acc: Record<string, { paye: string; labour: string }> = Object.fromEntries(ALL.map((c) => [c, { paye: randomUUID(), labour: randomUUID() }]));

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

/** A posted auto_payroll journal: DR 5200 / CR 2140. */
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
  await sql`INSERT INTO payroll_run_headers (company_id, period_year, period_month, status, total_paye, total_eti, journal_entry_id)
            VALUES (${companyId}::UUID, ${y}, ${m}, ${status}, ${paye}, ${eti}, ${journalId}::UUID)`;
}

beforeAll(async () => {
  assertDisposable();
  await sql`INSERT INTO users (id, email, role, is_active) VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
  for (const c of ALL) {
    await sql`INSERT INTO companies (id, name, financial_year_start, default_currency) VALUES (${c}::UUID, ${'ET guard ' + c.slice(0, 8)}, 3, 'ZAR')`;
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${c}::UUID, ${USER}, 'admin')`;
    await seedFiscalYears(c, '2026-03-01', '2028-02-28');
    await sql`
      INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, level, is_active, account_subtype, is_system_account)
      VALUES (${acc[c]!.paye}::UUID, ${c}::UUID, '2140', 'PAYE Payable', 'liability', 'credit', 3, true, 'payroll_liability', true),
             (${acc[c]!.labour}::UUID, ${c}::UUID, '5200', 'Labour Costs', 'expense', 'debit', 3, true, 'operating_expense', false)`;
  }
  // GUARD: ETI in Mar-Aug; May and June posted; September (next period) posted; Jan-Feb 2027 with February posted.
  await header(GUARD, 2026, 5, 'approved', 300, 500, await journal(GUARD, '2026-05-31', 'Payroll run 2026-05', 300));
  await header(GUARD, 2026, 6, 'approved', 300, 500, await journal(GUARD, '2026-06-30', 'Payroll run 2026-06', 300));
  await header(GUARD, 2026, 9, 'approved', 300, 500, await journal(GUARD, '2026-09-30', 'Payroll run 2026-09', 300));
  await header(GUARD, 2027, 1, 'approved', 300, 500);
  await header(GUARD, 2027, 2, 'approved', 300, 500, await journal(GUARD, '2027-02-28', 'Payroll run 2027-02', 300));
  // PLAIN: no ETI anywhere; June posted.
  await header(PLAIN, 2026, 5, 'approved', 300, 0, await journal(PLAIN, '2026-05-31', 'Payroll run 2026-05', 300));
  await header(PLAIN, 2026, 6, 'approved', 300, 0, await journal(PLAIN, '2026-06-30', 'Payroll run 2026-06', 300));
  // RACE: April carried R1 800 into May; May has a directive with PAYE R1 500 and no run.
  await header(RACE, 2026, 4, 'approved', 200, 2_000);
  const dj = await journal(RACE, '2026-05-20', 'SARS directive D1 — Emp', 1_500);
  directiveJournal = dj;
  const d = (await sql`INSERT INTO tax_directives (company_id, employee_name, directive_type, amount, effective_date, status, directive_number)
                       VALUES (${RACE}::UUID, 'Emp', 'severance', 4500, '2026-05-01', 'approved', 'D1') RETURNING id`) as Array<{ id: string }>;
  await sql`INSERT INTO tax_directive_payments (company_id, tax_directive_id, payment_date, gross_amount, paye_amount, net_amount, journal_entry_id)
            VALUES (${RACE}::UUID, ${d[0]!.id}::UUID, '2026-05-20', 4500, 1500, 3000, ${dj}::UUID)`;
}, 180000);

afterAll(async () => {
  try {
    await sql`DELETE FROM tax_directive_payments WHERE company_id = ANY(${ALL}::UUID[])`;
    await sql`DELETE FROM tax_directives WHERE company_id = ANY(${ALL}::UUID[])`;
    await sql`DELETE FROM payroll_run_headers WHERE company_id = ANY(${ALL}::UUID[])`;
    await sql`DELETE FROM gl_journal_lines WHERE company_id = ANY(${ALL}::UUID[])`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ANY(${ALL}::UUID[])`;
    await sql`DELETE FROM gl_account_balances WHERE gl_account_id = ANY(${ALL.flatMap((c) => [acc[c]!.paye, acc[c]!.labour])}::UUID[])`;
    await sql`DELETE FROM gl_accounts WHERE company_id = ANY(${ALL}::UUID[])`;
  } finally {
    await getPoolForTests().end();
  }
});

const refusal = (c: string, y: number, m: number) => inTx(c, () => laterEtiJournalRefusal(c, { year: y, month: m }));

describe('R-A month range', () => {
  it('May is refused while June is in force, naming June', async () => {
    expect(await refusal(GUARD, 2026, 5)).toMatch(/June 2026 payroll journal is in the ledger/);
  });
  it('June is not refused by May (only LATER months count)', async () => {
    expect(await refusal(GUARD, 2026, 6)).toBeNull();
  });
  it('August is not refused by September, the next period', async () => {
    expect(await refusal(GUARD, 2026, 8)).toBeNull();
  });
  it('January is refused by February; February is not refused by March', async () => {
    expect(await refusal(GUARD, 2027, 1)).toMatch(/February 2027/);
    expect(await refusal(GUARD, 2027, 2)).toBeNull();
  });
  it('a tenant without ETI is never blocked', async () => {
    expect(await refusal(PLAIN, 2026, 5)).toBeNull();
  });
  it('once June\'s journal is reversed out of the ledger, May is free', async () => {
    const june = (await sql`SELECT journal_entry_id FROM payroll_run_headers WHERE company_id = ${GUARD}::UUID AND period_month = 6`) as Array<{ journal_entry_id: string }>;
    await sql`UPDATE payroll_run_headers SET status = 'calculated' WHERE company_id = ${GUARD}::UUID AND period_month = 6`; // reopened
    await inTx(GUARD, () => reverseJournalEntry(GUARD, june[0]!.journal_entry_id, USER));
    expect(await refusal(GUARD, 2026, 5)).toBeNull();
  });
});

describe('the company payroll lock serialises ETI booking', () => {
  it('two concurrent ETI bookings for May book R1 500 once, not twice', async () => {
    const book = () => inTx(RACE, async () => {
      await lockCompanyPayrollApprovals(null, RACE);
      return postMonthEtiJournal(RACE, { year: 2026, month: 5 }, '2026-05-20', USER);
    });
    const ids = await Promise.all([book(), book()]);
    expect(ids.filter((x) => x !== null)).toHaveLength(1);
    expect(await inTx(RACE, () => bookedByEtiJournals(RACE, { year: 2026, month: 5 }))).toEqual({ used: 1_500, refund: 0 });
  });
});

describe('review M3: reversing a directive payment\'s journal books the month\'s negative ETI difference', () => {
  it('May no longer uses the R1 500: an ETI journal for May takes it back, so May books nothing net', async () => {
    await inTx(RACE, () => reverseJournalEntry(RACE, directiveJournal, USER));
    expect(await inTx(RACE, () => bookedByEtiJournals(RACE, { year: 2026, month: 5 }))).toEqual({ used: 0, refund: 0 });
  });
});
