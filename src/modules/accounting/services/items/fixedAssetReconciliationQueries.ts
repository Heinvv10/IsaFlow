/**
 * The three queries behind `reconcileFixedAssets`, split out only to keep both
 * files inside the 300-line cap. The reasoning that governs them lives in
 * `fixedAssetReconciliationService.ts`; two rules matter here and are the ones
 * this codebase has been bitten by before:
 *
 *  - NO `is_active` predicate. It is a picker flag, and four production
 *    accounts hold R137,317.39 while inactive.
 *  - NO account-name matching. Choosing a bucket by name is what typed two
 *    `default_expense` accounts as cost of sales and overstated gross profit by
 *    R562,428. Selection is by SUBTYPE only.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
/** GL subtypes that make up the carrying amount of property, plant and equipment. */
export const ASSET_COST_SUBTYPE = 'fixed_assets';
export const ASSET_ACCUMULATED_DEPRECIATION_SUBTYPE = 'accumulated_depreciation';

/** Journals shown per account at `detail: full` — the route to the documents. */
const DOCUMENTS_PER_ACCOUNT = 50;

export interface AssetReconcilingDocument {
  accountId: string;
  accountCode: string;
  journalEntryId: string;
  entryNumber: string | null;
  entryDate: string;
  source: string | null;
  description: string | null;
  amount: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The GL accounts making up the asset section, with balance and line count. */
export async function loadAssetSectionAccounts(
  companyId: string,
  asOf: string,
): Promise<DbRow[]> {
  // The posted/date predicate sits in the LEFT JOIN's ON clause DELIBERATELY —
  // an account with no posted lines must survive with a zero balance rather
  // than vanish, because "has never moved" and "is not in this report" are
  // different facts. The NULLs it lets through are absorbed by COALESCE and
  // COUNT(jl.id), never summed blind; the tenant fence is the WHERE clause on
  // `ga.company_id`, which an outer join cannot weaken.
  //
  // `ga.is_active` is SELECTED and never filtered on. It was dropped when this
  // query was shared with `getAssetGlReconciliation`, whose mapping reads
  // `isActive: r.is_active !== false` — and `undefined !== false` is TRUE, so
  // every account, production's deactivated 1600 included, reported as active.
  // A missing column that degrades to a plausible value instead of throwing is
  // why the guard for it has to be a behavioural test and not a source-text
  // one: the source-text assertion got GREENER as the behaviour got worse.
  return (await sql`
    SELECT ga.id, ga.account_code, ga.account_name, ga.account_subtype,
           ga.is_active,
           COALESCE(SUM(jl.debit - jl.credit), 0) AS balance,
           COUNT(jl.id)::INT                      AS posted_lines,
           MAX(jl.created_at)                     AS posted_through
    FROM gl_accounts ga
    LEFT JOIN gl_journal_lines jl
           ON jl.gl_account_id = ga.id
          AND jl.company_id = ${companyId}::UUID
          AND jl.journal_entry_id IN (
            SELECT je.id FROM gl_journal_entries je
            WHERE je.company_id = ${companyId}::UUID
              AND je.status = 'posted'
              AND je.entry_date <= ${asOf}::DATE
          )
    WHERE ga.company_id = ${companyId}::UUID
      AND ga.account_subtype IN (
        ${ASSET_COST_SUBTYPE}, ${ASSET_ACCUMULATED_DEPRECIATION_SUBTYPE}
      )
    GROUP BY ga.id, ga.account_code, ga.account_name, ga.account_subtype, ga.is_active
    ORDER BY ga.account_code
  `) as DbRow[];
}

/** The journals behind those accounts — every aggregate offers a route down. */
export async function loadAssetSectionDocuments(
  companyId: string,
  asOf: string,
): Promise<AssetReconcilingDocument[]> {
  const rows = (await sql`
    SELECT * FROM (
      SELECT ga.id AS account_id, ga.account_code,
             je.id AS journal_entry_id, je.entry_number, je.entry_date,
             je.source, je.description,
             SUM(jl.debit - jl.credit) AS amount,
             ROW_NUMBER() OVER (
               PARTITION BY ga.id ORDER BY je.entry_date DESC, je.id DESC
             ) AS rn
      FROM gl_accounts ga
      JOIN gl_journal_lines jl
        ON jl.gl_account_id = ga.id AND jl.company_id = ${companyId}::UUID
      JOIN gl_journal_entries je
        ON je.id = jl.journal_entry_id
       AND je.company_id = ${companyId}::UUID
       AND je.status = 'posted'
       AND je.entry_date <= ${asOf}::DATE
      WHERE ga.company_id = ${companyId}::UUID
        AND ga.account_subtype IN (
          ${ASSET_COST_SUBTYPE}, ${ASSET_ACCUMULATED_DEPRECIATION_SUBTYPE}
        )
      GROUP BY ga.id, ga.account_code, je.id, je.entry_number, je.entry_date,
               je.source, je.description
    ) d
    WHERE d.rn <= ${DOCUMENTS_PER_ACCOUNT}
    ORDER BY d.account_code, d.entry_date DESC
  `) as DbRow[];

  return rows.map((r) => ({
    accountId: String(r.account_id),
    accountCode: String(r.account_code ?? ''),
    journalEntryId: String(r.journal_entry_id),
    entryNumber: r.entry_number == null ? null : String(r.entry_number),
    entryDate: fmtDate(r.entry_date),
    source: r.source == null ? null : String(r.source),
    description: r.description == null ? null : String(r.description),
    amount: round2(Number(r.amount) || 0),
  }));
}

/**
 * Whether ANY asset in this company, or any category one of its assets uses,
 * names a GL account.
 *
 * On every production company the answer is no — all three link columns are
 * NULL on all six assets and all thirty-five categories — so no part of the
 * ledger can be attributed to a specific asset by data that exists. Saying so
 * is the finding; inferring a link from an account name would not be.
 *
 * `asset_categories` carries NO `company_id` column, so it is reached only
 * THROUGH this company's assets rather than scanned outright: a global table
 * queried unscoped would let another tenant's configuration decide what this
 * report claims.
 */
export async function hasRegisterLinkage(companyId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT EXISTS (
      SELECT 1
      FROM assets a
      LEFT JOIN asset_categories c ON c.id = a.category_id
      WHERE a.company_id = ${companyId}::UUID
        AND (a.gl_asset_account_id IS NOT NULL
          OR a.gl_depreciation_account_id IS NOT NULL
          OR a.gl_expense_account_id IS NOT NULL
          OR c.gl_asset_account_id IS NOT NULL
          OR c.gl_depreciation_account_id IS NOT NULL
          OR c.gl_expense_account_id IS NOT NULL)
    ) AS linked
  `) as DbRow[];
  return rows[0]?.linked === true;
}

/**
 * Asset-typed accounts carrying NO subtype at all.
 *
 * `loadAssetSectionAccounts` selects by subtype, so an account typed `asset`
 * with `account_subtype IS NULL` is in neither total and, until this query
 * existed, in nothing the reply returned either — `unexplainedDifference`
 * stayed 0.00 because the items are produced from the same query the totals
 * come from. That is a completeness claim that cannot fail, inside the report
 * built to catch exactly that.
 *
 * It is not hypothetical. Velocity Fibre carries eight PPE accounts in this
 * state, including `49784317 Cost - Computer Equipment - BA4000` and
 * `49784318 Accumulated Depreciation - Computer Equipment - BA4500`. They hold
 * R0 today, so the CURRENT figure is right — and the first journal posted to
 * any of them moves money out of `glNetBookValue` with nothing saying so.
 *
 * They are reported as DISCLOSURES, never `excludedRows`, and the distinction is
 * load-bearing rather than cosmetic. An exclusion is a row that belonged to this
 * report's universe and was withheld from the totals; the universe here is
 * DEFINED by subtype, so a subtype-less account was never a member. It is also
 * signal against noise: Velocity carries 58 of these holding a net
 * R32,747,547.38, most of it debtors and petty cash, and calling that "fixed
 * assets this report could not classify" is a false statement about kind that
 * would bury the PPE accounts genuinely among them. A test asserts
 * `no_account_subtype` never reaches `excludedRows`.
 *
 * Nothing is inferred from the account NAME — and no narrowing is available that
 * is not one, which is why the honest answer to "we cannot tell which of these
 * is PPE" is to return them all and say so.
 */
export async function loadUnsubtypedAssetAccounts(
  companyId: string,
  asOf: string,
): Promise<DbRow[]> {
  return (await sql`
    SELECT ga.id, ga.account_code, ga.account_name, ga.is_active,
           COALESCE(SUM(jl.debit - jl.credit), 0) AS balance
    FROM gl_accounts ga
    LEFT JOIN gl_journal_lines jl
           ON jl.gl_account_id = ga.id
          AND jl.company_id = ${companyId}::UUID
          AND jl.journal_entry_id IN (
            SELECT je.id FROM gl_journal_entries je
            WHERE je.company_id = ${companyId}::UUID
              AND je.status = 'posted'
              AND je.entry_date <= ${asOf}::DATE
          )
    WHERE ga.company_id = ${companyId}::UUID
      AND ga.account_type = 'asset'
      AND (ga.account_subtype IS NULL OR btrim(ga.account_subtype) = '')
    GROUP BY ga.id, ga.account_code, ga.account_name, ga.is_active
    ORDER BY ga.account_code
  `) as DbRow[];
}
