/**
 * Read/write the opening-balance METADATA on a bank GL account.
 *
 * `gl_accounts.bank_opening_balance` and `bank_opening_balance_date` are
 * display fields: `getBankAccountsStatus` computes an account's `balance` as
 * `SUM(bt.amount)` and never adds them. They exist so the banking screens can
 * show the figure the ledger was started from.
 *
 * That makes them dangerous on their own. Writing this WITHOUT posting a
 * journal shows the right number on the screen a person checks while the trial
 * balance, the balance sheet and every reconciliation stay wrong. So the write
 * here is only ever the second half of `set_opening_balance`, called after the
 * journal has posted — never as a way to "set" a balance.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export interface OpeningBalanceMeta {
  amount: number | null;
  /** YYYY-MM-DD, or null when never set. */
  asAt: string | null;
}

async function read(companyId: string, accountId: string): Promise<OpeningBalanceMeta> {
  const rows = (await sql`
    SELECT bank_opening_balance, bank_opening_balance_date
      FROM gl_accounts
     WHERE id = ${accountId}::UUID AND company_id = ${companyId}::UUID
     LIMIT 1
  `) as DbRow[];

  const row = rows[0];
  if (!row) return { amount: null, asAt: null };

  const raw = row.bank_opening_balance;
  const date = row.bank_opening_balance_date;
  return {
    amount: raw === null || raw === undefined ? null : Number(raw),
    // pg returns a Date for a DATE column; both shapes have to survive.
    asAt: date === null || date === undefined
      ? null
      : date instanceof Date
        ? date.toISOString().slice(0, 10)
        : String(date).slice(0, 10),
  };
}

async function write(
  companyId: string,
  accountId: string,
  amount: number,
  asAt: string,
): Promise<void> {
  await sql`
    UPDATE gl_accounts
       SET bank_opening_balance = ${amount},
           bank_opening_balance_date = ${asAt}::DATE
     WHERE id = ${accountId}::UUID AND company_id = ${companyId}::UUID
  `;
}

/**
 * Exported as a pair rather than two loose functions so a caller cannot import
 * `write` without the `read` that guards against stacking a second opening
 * balance on top of the first.
 */
export const setBankOpeningBalanceMeta = { read, write };
