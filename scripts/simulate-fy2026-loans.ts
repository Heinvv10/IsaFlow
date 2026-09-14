/**
 * simulate-fy2026-loans.ts — the loans half of the FY2026 simulation:
 * the monthly period close (LT → current-portion reclass) and the scheduled
 * loan payments.
 *
 * Split out of simulate-fy2026-workflows.ts so each file stays under the
 * 300-line cap. The behaviour is unchanged.
 */

import pg from 'pg';
import { als } from '@/lib/als';

import { closeLoanPeriod, isPeriodLocked } from '../src/modules/accounting/services/loans/loanPeriodCloseService';
import { recordLoanPayment } from '../src/modules/accounting/services/loans/loanPaymentService';
import type { Err } from './simulate-fy2026-context';
import { ADMIN_ID, COMPANY_ID, DATABASE_URL, errText, pad, sql, yyyymm } from './simulate-fy2026-context';

// Round-4 M1. `closeLoanPeriod` writes to the general ledger and serialises the
// company's closes on a TRANSACTION advisory lock, so it must run inside one
// request transaction the way the API route does — on a bare pooled connection
// the lock releases immediately and a mid-way failure leaves half the month's
// reclass journals posted. Same shape as scripts/ap-backfill-supplier-payments.ts.
const alsPool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
});

export const closeLoansPool = (): Promise<void> => alsPool.end();

async function inRequestTransaction<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const client = await alsPool.connect();
  try {
    await client.query('BEGIN');
    const result = await als.run({ client, userId, claims: {} }, fn);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function runLoansClose(month: number, year: number, errors: Err[]): Promise<number> {
  const period = yyyymm(year, month);
  try {
    if (await isPeriodLocked(COMPANY_ID, period)) {
      console.log(`  [loans-close] ${period} already locked — skip`);
      return 0;
    }
    const result = await inRequestTransaction(
      ADMIN_ID,
      () => closeLoanPeriod(COMPANY_ID, period, ADMIN_ID),
    );
    console.log(`  [loans-close] ${period}: processed ${result.loansProcessed}, posted ${result.reclassEntries.length}${result.skippedLoans ? `, skipped ${result.skippedLoans.length}` : ''}`);
    return result.reclassEntries.length;
  } catch (err) {
    errors.push({ month, module: 'loans-close', message: errText(err) });
    console.error(`  [loans-close] ERROR ${period}: ${errText(err)}`);
    return 0;
  }
}

export async function runLoanPayments(month: number, year: number, errors: Err[]): Promise<number> {
  let done = 0;
  try {
    const loans = await sql.query<{id:string;reference:string}>(
      `SELECT id,reference FROM loans WHERE company_id=$1 AND status='active'`,
      [COMPANY_ID],
    );
    for (const loan of loans) {
      const rows = await sql.query<{period:number;date:Date}>(
        `SELECT lsr.period, lsr.date FROM loan_schedule_rows lsr
         JOIN loan_schedule_runs lsrun ON lsrun.id = lsr.run_id
         WHERE lsrun.loan_id = $1 AND lsrun.company_id = $2
           AND TO_CHAR(lsr.date, 'YYYYMM') = $3
         ORDER BY lsrun.computed_at DESC NULLS LAST LIMIT 1`,
        [loan.id, COMPANY_ID, yyyymm(year, month)],
      );
      if (!rows[0]) continue;
      const row = rows[0];
      const paymentDate = row.date instanceof Date
        ? `${row.date.getFullYear()}-${pad(row.date.getMonth() + 1)}-${pad(row.date.getDate())}`
        : String(row.date).slice(0, 10);
      try {
        const result = await recordLoanPayment(COMPANY_ID, loan.id, {
          paymentDate,
          periodNumber: row.period,
        }, ADMIN_ID);
        console.log(`  [loan-pay] ${loan.reference} period=${row.period}: principal R${result.principal.toFixed(2)} + interest R${result.interest.toFixed(2)} = R${result.totalPaid.toFixed(2)} → outstanding R${result.newOutstanding.toFixed(2)}`);
        done++;
      } catch (err) {
        const msg = errText(err);
        if (/already recorded|already exists/i.test(msg)) continue; // idempotent skip
        errors.push({ month, module: 'loan-pay', message: `${loan.reference}: ${msg}` });
        console.error(`  [loan-pay] ERROR ${loan.reference}: ${msg}`);
      }
    }
  } catch (err) {
    errors.push({ month, module: 'loan-pay', message: errText(err) });
  }
  return done;
}
