/**
 * The fixed asset register, and its reconciliation to the general ledger.
 *
 * Extracted from the inline SQL in `pages/api/accounting/assets.ts` and
 * `assets-register.ts` so an MCP tool can reach it — tools never write SQL.
 * The route keeps its behaviour; this is where it now lives.
 *
 * WHY THE RECONCILIATION IS THE POINT. A register on its own says whatever the
 * `assets` table says, and on these books that is not what the balance sheet
 * says. Brightsphere's only asset is a QA test computer, already disposed, with
 * `accumulated_depreciation = 0.00` on the register — while the GL carries
 * R7,500 of accumulated depreciation against no asset cost at all, i.e. a
 * NEGATIVE net book value. The two sources disagree in both directions at once,
 * and nothing in the API could show that.
 *
 * The GL side is selected by SUBTYPE, never by account NAME. Choosing a bucket
 * by name is what typed two `default_expense` accounts as cost of sales and
 * overstated gross profit by R562,428. It is also why this report lists the
 * accounts it counted INDIVIDUALLY rather than only their total: on
 * Brightsphere every account subtyped `fixed_assets` that carries a balance is
 * a loan or investment account, netting to a CREDIT of R5.7m in the asset
 * section, and a single total would hide that behind a plausible-looking
 * number.
 *
 * No `is_active` filter anywhere. It is a picker flag and says nothing about
 * whether an account holds money.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import {
  loadAssetSectionAccounts,
  ASSET_COST_SUBTYPE as COST_SUBTYPE,
  ASSET_ACCUMULATED_DEPRECIATION_SUBTYPE as ACC_DEP_SUBTYPE,
} from './fixedAssetReconciliationQueries';

type Row = DbRow;

// One query, two consumers. `loadAssetSectionAccounts` is the single
// implementation of "the GL asset section as at a date"; reconcile_fixed_assets
// reads the same rows, so asset_register and it cannot disagree about what the
// ledger side is. The subtype constants live with it.
export {
  ASSET_COST_SUBTYPE,
  ASSET_ACCUMULATED_DEPRECIATION_SUBTYPE,
} from './fixedAssetReconciliationQueries';

export interface AssetRegisterRow {
  id: string;
  assetNumber: string;
  name: string;
  category: string | null;
  categoryName: string | null;
  status: string;
  purchaseDate: string;
  purchasePrice: number;
  accumulatedDepreciation: number;
  netBookValue: number;
  disposalDate: string | null;
  disposalAmount: number | null;
}

export interface AssetGlAccountBalance {
  accountId: string;
  accountCode: string;
  accountName: string;
  subtype: string;
  balance: number;
  /** Reported, never filtered on — is_active decides a dropdown, not a balance. */
  isActive: boolean;
}

export interface AssetGlReconciliation {
  /** Cost-side accounts and their net balance. */
  costAccounts: AssetGlAccountBalance[];
  glCost: number;
  /** Accumulated-depreciation accounts and their net balance (normally negative). */
  accumulatedDepreciationAccounts: AssetGlAccountBalance[];
  glAccumulatedDepreciation: number;
  glNetBookValue: number;
  registerCost: number;
  registerAccumulatedDepreciation: number;
  registerNetBookValue: number;
  /** register NBV less GL NBV. Zero is the only value that needs no explanation. */
  difference: number;
  postedThrough: string | null;
}

export interface AssetRegisterPage {
  rows: AssetRegisterRow[];
  /** Assets still held at as_at — the ones the totals cover. */
  rowsTotal: number;
  /** Every asset acquired on or before as_at, disposed ones included. */
  universeTotal: number;
  /** Assets already disposed at as_at. They are not carrying amount. */
  disposed: AssetRegisterRow[];
  totals: {
    cost: number;
    accumulatedDepreciation: number;
    netBookValue: number;
  };
  hasMore: boolean;
}

/**
 * ONE definition of carrying amount, used by the per-asset row and by the SQL
 * total alike.
 *
 * They used to disagree: the row fell back to `cost - accumulatedDepreciation`
 * while the total fell back to `purchase_price` alone. `current_book_value` has
 * no default and `pages/api/accounting/assets.ts` INSERTs without it, so NULL
 * is the NORMAL state of a UI-created asset until the first depreciation run —
 * and for any such asset carrying depreciation, the total overstated by exactly
 * that depreciation. In `reconcile_fixed_assets`, where `difference` comes from
 * the total and `itemsTotal` from the rows, that surfaced as an
 * `unexplainedDifference` describing no real gap at all.
 */
function mapRow(r: Row): AssetRegisterRow {
  const cost = Number(r.purchase_price) || 0;
  const accDep = Number(r.accumulated_depreciation) || 0;
  return {
    id: String(r.id),
    assetNumber: String(r.asset_number ?? ''),
    name: String(r.name ?? ''),
    category: r.category == null ? null : String(r.category),
    categoryName: r.category_name == null ? null : String(r.category_name),
    status: String(r.status ?? ''),
    purchaseDate: fmtDate(r.purchase_date),
    purchasePrice: cost,
    accumulatedDepreciation: accDep,
    netBookValue: r.current_book_value == null ? cost - accDep : Number(r.current_book_value),
    disposalDate: r.disposal_date ? fmtDate(r.disposal_date) : null,
    disposalAmount: r.disposal_amount == null ? null : Number(r.disposal_amount),
  };
}

/**
 * The register as at a date.
 *
 * An asset disposed on or before `asOf` is NOT carrying amount and is kept out
 * of the totals — the previous route filtered only on purchase date, so
 * Brightsphere's one asset, sold for R8,000 in April, still reported R15,000 of
 * book value. It is returned separately rather than dropped, because "there is
 * one asset and it was sold" and "there are no assets" are different facts.
 */
export async function getAssetRegister(
  companyId: string,
  asOf: string,
  opts: { limit: number; offset: number },
): Promise<AssetRegisterPage> {
  const rows = (await sql`
    SELECT a.*, ac.name AS category_name
    FROM assets a
    LEFT JOIN asset_categories ac ON ac.id = a.category_id
    WHERE a.company_id = ${companyId}::UUID
      AND a.purchase_date <= ${asOf}::DATE
    ORDER BY a.category, a.asset_number, a.id
    LIMIT ${opts.limit + 1} OFFSET ${opts.offset}
  `) as Row[];

  const hasMore = rows.length > opts.limit;
  const page = (hasMore ? rows.slice(0, opts.limit) : rows).map(mapRow);

  const isDisposed = (a: AssetRegisterRow): boolean =>
    a.disposalDate !== null && a.disposalDate <= asOf;
  const held = page.filter((a) => !isDisposed(a));
  const disposed = page.filter(isDisposed);

  const [totals] = (await sql`
    SELECT
      COUNT(*)::INT AS universe_total,
      COUNT(*) FILTER (
        WHERE a.disposal_date IS NULL OR a.disposal_date > ${asOf}::DATE
      )::INT AS rows_total,
      COALESCE(SUM(a.purchase_price::NUMERIC) FILTER (
        WHERE a.disposal_date IS NULL OR a.disposal_date > ${asOf}::DATE
      ), 0) AS total_cost,
      COALESCE(SUM(COALESCE(a.accumulated_depreciation, 0)::NUMERIC) FILTER (
        WHERE a.disposal_date IS NULL OR a.disposal_date > ${asOf}::DATE
      ), 0) AS total_depreciation,
      -- The SAME fallback mapRow applies: cost LESS accumulated depreciation,
      -- not cost alone. See the note on mapRow.
      COALESCE(SUM(COALESCE(
        a.current_book_value,
        COALESCE(a.purchase_price, 0) - COALESCE(a.accumulated_depreciation, 0)
      )::NUMERIC) FILTER (
        WHERE a.disposal_date IS NULL OR a.disposal_date > ${asOf}::DATE
      ), 0) AS total_book_value
    FROM assets a
    WHERE a.company_id = ${companyId}::UUID
      AND a.purchase_date <= ${asOf}::DATE
  `) as Row[];

  return {
    rows: held,
    rowsTotal: Number(totals?.rows_total ?? 0),
    universeTotal: Number(totals?.universe_total ?? 0),
    disposed,
    totals: {
      cost: Number(totals?.total_cost ?? 0),
      accumulatedDepreciation: Number(totals?.total_depreciation ?? 0),
      netBookValue: Number(totals?.total_book_value ?? 0),
    },
    hasMore,
  };
}

/**
 * Register carrying amount against the GL carrying amount, account by account.
 * The gap is the finding; the per-account list is what makes it diagnosable.
 */
export async function getAssetGlReconciliation(
  companyId: string,
  asOf: string,
): Promise<AssetGlReconciliation> {
  const accountRows = await loadAssetSectionAccounts(companyId, asOf);

  const accounts: AssetGlAccountBalance[] = accountRows.map((r) => ({
    accountId: String(r.id),
    accountCode: String(r.account_code ?? ''),
    accountName: String(r.account_name ?? ''),
    subtype: String(r.account_subtype ?? ''),
    balance: Number(r.balance) || 0,
    isActive: r.is_active !== false,
  }));

  const postedThroughRaw = accountRows
    .map((r) => (r.posted_through ? new Date(String(r.posted_through)).toISOString() : null))
    .filter((v): v is string => v !== null)
    .sort()
    .slice(-1)[0] ?? null;

  const costAccounts = accounts.filter((a) => a.subtype === COST_SUBTYPE);
  const accDepAccounts = accounts.filter(
    (a) => a.subtype === ACC_DEP_SUBTYPE,
  );
  const glCost = costAccounts.reduce((s, a) => s + a.balance, 0);
  const glAccumulatedDepreciation = accDepAccounts.reduce((s, a) => s + a.balance, 0);

  const register = await getAssetRegister(companyId, asOf, { limit: 0, offset: 0 });
  const glNetBookValue = glCost + glAccumulatedDepreciation;

  return {
    costAccounts,
    glCost,
    accumulatedDepreciationAccounts: accDepAccounts,
    glAccumulatedDepreciation,
    glNetBookValue,
    registerCost: register.totals.cost,
    registerAccumulatedDepreciation: register.totals.accumulatedDepreciation,
    registerNetBookValue: register.totals.netBookValue,
    difference: Math.round((register.totals.netBookValue - glNetBookValue) * 100) / 100,
    postedThrough: postedThroughRaw,
  };
}
