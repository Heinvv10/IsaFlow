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

/** Subtypes that represent fixed-asset COST (not accumulated depreciation). */
const FIXED_ASSET_SUBTYPES = ['fixed_asset', 'fixed_assets'];

/**
 * Everything an account must satisfy to be the credit leg of a disposal
 * journal — i.e. to be storable in assets.gl_asset_account_id.
 *
 * This exists so the WRITER gates exactly what resolveAssetAccountId will later
 * accept. They disagreed once: the writer checked only leaf + type='asset' +
 * company while the resolver additionally required is_active, so a PATCH could
 * return 200 storing an inactive account and the subsequent disposal would 400
 * telling the operator to set the very account they had just set. And with only
 * `type='asset'`, an asset could be pointed at Bank or Accounts Receivable —
 * both leaves, both assets — so a disposal would credit Bank for the full cost
 * with no cash movement. It balances, so nothing surfaces.
 */
export async function validateAssetCostAccount(
  accountId: string,
  companyId: string,
): Promise<LeafAccountCheck> {
  const base = await validateLeafAccount(accountId, companyId, 'asset');
  if (!base.ok) return base;

  const rows = (await sql`
    SELECT account_code, account_subtype, is_active
    FROM gl_accounts
    WHERE id = ${accountId}::uuid AND company_id = ${companyId}::uuid
    LIMIT 1
  `) as Array<{ account_code: string; account_subtype: string | null; is_active: boolean | null }>;

  const acct = rows[0];
  if (!acct) return { ok: false, reason: 'Account not found' };

  if (!acct.is_active) {
    return {
      ok: false,
      reason: `Account ${acct.account_code} is inactive — reactivate it before using it as an asset account`,
    };
  }
  if (!acct.account_subtype || !FIXED_ASSET_SUBTYPES.includes(acct.account_subtype)) {
    return {
      ok: false,
      reason: `Account ${acct.account_code} has subtype '${acct.account_subtype ?? 'none'}'; a disposal credits fixed-asset cost, so it must be one of ${FIXED_ASSET_SUBTYPES.join(' / ')}`,
    };
  }
  return { ok: true };
}
