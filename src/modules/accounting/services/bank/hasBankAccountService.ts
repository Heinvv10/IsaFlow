/**
 * hasBankAccountService — Tenant-scoped check for GL bank accounts.
 *
 * A "bank account" in IsaFlow is a GL account row with:
 *   account_type    = 'asset'
 *   account_subtype = 'bank'
 *   is_active       = TRUE   (inactive accounts are hidden from the UI)
 *
 * Used by the KPI dashboard API to surface the NoBankAccountWarning banner
 * when cash KPIs are non-zero but no bank account has been set up, and by the
 * setup guide to decide whether the 'bank-account' task is complete.
 *
 * The `bank_accounts` table is NOT the source of truth — it is vestigial
 * metadata (0 rows in production). Never count it to answer this question.
 */

import { sql } from '@/lib/neon';

/**
 * Returns true when the company has at least one active GL account
 * with account_subtype = 'bank'.
 *
 * Multi-tenant: `companyId` is ALWAYS the first interpolated argument.
 */
export async function hasBankAccount(companyId: string): Promise<boolean> {
  const rows = await sql<{ has_bank_account: boolean }>`
    SELECT EXISTS (
      SELECT 1
      FROM   gl_accounts
      WHERE  company_id      = ${companyId}::UUID
        AND  account_subtype = 'bank'
        AND  is_active        = TRUE
    ) AS has_bank_account
  `;

  return rows[0]?.has_bank_account ?? false;
}

/**
 * Returns how many active GL accounts with account_subtype = 'bank' the company
 * owns. Same definition as `hasBankAccount`, for callers that need a count.
 *
 * Multi-tenant: `companyId` is ALWAYS the first interpolated argument.
 */
export async function countBankAccounts(companyId: string): Promise<number> {
  const rows = await sql<{ count: string }>`
    SELECT COUNT(*) AS count
    FROM   gl_accounts
    WHERE  company_id      = ${companyId}::UUID
      AND  account_subtype = 'bank'
      AND  is_active        = TRUE
  `;

  return Number(rows[0]?.count ?? 0);
}
