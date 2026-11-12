/**
 * What the ledger has booked of a month's ETI (wave 5 ET; coordinator ruling H2 option a, Hein ruling R-C), against
 * real PostgreSQL: the month's ETI journals (reference ETI-YYYY-MM, source auto_payroll) and their reversals, this
 * company only; a manual journal carrying the same reference is not ETI.
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
import { bookedByEtiJournals } from '@/modules/accounting/services/payroll/etiBooking';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { seedFiscalYears } from './helpers/fiscalYearSeed';

const CO = randomUUID(), OTHER = randomUUID(), USER = randomUUID();
const acc = { paye: randomUUID(), labour: randomUUID(), refund: randomUUID(), opaye: randomUUID(), olabour: randomUUID() };
const MAY = { year: 2026, month: 5 };

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

async function journal(companyId: string, source: 'auto_payroll' | 'manual', reference: string, dr: string, cr: string, amount: number): Promise<string> {
  return inTx(companyId, async () => {
    const je = await createJournalEntry(companyId, {
      entryDate: '2026-05-20', description: 'ETI for 2026-05: directive PAYE', source, reference,
      lines: [{ glAccountId: dr, debit: amount, credit: 0 }, { glAccountId: cr, debit: 0, credit: amount }],
    }, USER);
    await postJournalEntry(companyId, je.id, USER);
    return je.id;
  });
}

beforeAll(async () => {
  assertDisposable();
  await sql`INSERT INTO users (id, email, role, is_active) VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
  await sql`INSERT INTO companies (id, name, financial_year_start, default_currency)
            VALUES (${CO}::UUID, 'ET booking A', 3, 'ZAR'), (${OTHER}::UUID, 'ET booking B', 3, 'ZAR')`;
  for (const c of [CO, OTHER]) {
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${c}::UUID, ${USER}, 'admin')`;
    await seedFiscalYears(c, '2026-03-01', '2027-02-28');
  }
  await sql`
    INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, level, is_active, account_subtype, is_system_account)
    VALUES (${acc.paye}::UUID, ${CO}::UUID, '2140', 'PAYE Payable', 'liability', 'credit', 3, true, 'payroll_liability', true),
           (${acc.labour}::UUID, ${CO}::UUID, '5200', 'Labour Costs', 'expense', 'debit', 3, true, 'operating_expense', false),
           (${acc.refund}::UUID, ${CO}::UUID, '1150', 'ETI refund receivable (SARS)', 'asset', 'debit', 3, true, 'eti_refund_receivable', true),
           (${acc.opaye}::UUID, ${OTHER}::UUID, '2140', 'PAYE Payable', 'liability', 'credit', 3, true, 'payroll_liability', true),
           (${acc.olabour}::UUID, ${OTHER}::UUID, '5200', 'Labour Costs', 'expense', 'debit', 3, true, 'operating_expense', false)`;
  await journal(CO, 'auto_payroll', 'ETI-2026-05', acc.paye, acc.labour, 300);
  await journal(CO, 'auto_payroll', 'ETI-2026-05', acc.refund, acc.labour, 100);
  await journal(CO, 'manual', 'ETI-2026-05', acc.paye, acc.labour, 9_999);           // not an ETI journal
  await journal(CO, 'auto_payroll', 'ETI-2026-06', acc.paye, acc.labour, 7_777);     // another month
  await journal(OTHER, 'auto_payroll', 'ETI-2026-05', acc.opaye, acc.olabour, 5_555); // another company
}, 120000);

afterAll(async () => {
  try {
    await sql`DELETE FROM gl_journal_lines WHERE company_id = ANY(${[CO, OTHER]}::UUID[])`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ANY(${[CO, OTHER]}::UUID[])`;
    await sql`DELETE FROM gl_account_balances WHERE gl_account_id = ANY(${Object.values(acc)}::UUID[])`;
    await sql`DELETE FROM gl_accounts WHERE company_id = ANY(${[CO, OTHER]}::UUID[])`;
  } finally {
    await getPoolForTests().end();
  }
});

describe('bookedByEtiJournals', () => {
  it('sums the month\'s ETI journals of this company only: ETI used on 2140, the refund on the receivable', async () => {
    expect(await inTx(CO, () => bookedByEtiJournals(CO, MAY))).toEqual({ used: 300, refund: 100 });
  });

  it('round 5 ruling: an ETI journal cannot be reversed by hand, so what it booked stands', async () => {
    const id = await journal(CO, 'auto_payroll', 'ETI-2026-05', acc.paye, acc.labour, 50);
    expect(await inTx(CO, () => bookedByEtiJournals(CO, MAY))).toEqual({ used: 350, refund: 100 });
    await expect(inTx(CO, () => reverseJournalEntry(CO, id, USER))).rejects.toThrow('ETI journals are rebooked automatically');
    expect(await inTx(CO, () => bookedByEtiJournals(CO, MAY))).toEqual({ used: 350, refund: 100 });
  });
});
