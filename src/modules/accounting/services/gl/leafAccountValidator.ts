/**
 * Leaf-account validation for routes that let a user nominate a GL account.
 *
 * Two things must hold before an account is safe to post to:
 *
 *  - it belongs to the caller's company (a plain FK on gl_journal_lines only
 *    points at gl_accounts(id), with no composite company constraint, so the
 *    database will not catch a cross-tenant id on its own); and
 *  - it is a LEAF. Posting to a parent header leaves the amount invisible to
 *    the balance-sheet calculation, which filters headers out — see migration
 *    484 for the incident that established this rule.
 *
 * Extracted from pages/api/accounting/expense-claims/[id]/post.ts, which had
 * the only copy, so the asset GL-account writers enforce exactly the same rule
 * rather than growing a second, subtly different one.
 */

import { sql } from '@/lib/neon';

interface AccountRow {
  id: string;
  account_code: string;
  account_type: string;
  is_leaf: boolean;
}

export type LeafAccountCheck = { ok: true } | { ok: false; reason: string };

export async function validateLeafAccount(
  accountId: string,
  companyId: string,
  expectedType: string | string[],
): Promise<LeafAccountCheck> {
  const rows = (await sql`
    SELECT
      ga.id,
      ga.account_code,
      ga.account_type,
      NOT EXISTS (
        SELECT 1 FROM gl_accounts ch
         WHERE ch.parent_account_id = ga.id
           AND ch.company_id = ga.company_id
      ) AS is_leaf
    FROM gl_accounts ga
    WHERE ga.id = ${accountId}::uuid
      AND ga.company_id = ${companyId}::uuid
    LIMIT 1
  `) as AccountRow[];

  const acct = rows[0];
  if (!acct) return { ok: false, reason: 'Account not found' };
  if (!acct.is_leaf) {
    return {
      ok: false,
      reason: `Account ${acct.account_code} is a parent header (has child accounts) — pick a leaf account`,
    };
  }
  const allowed = Array.isArray(expectedType) ? expectedType : [expectedType];
  if (!allowed.includes(acct.account_type)) {
    return {
      ok: false,
      reason: `Account ${acct.account_code} type=${acct.account_type}; expected ${allowed.join(' or ')}`,
    };
  }
  return { ok: true };
}
