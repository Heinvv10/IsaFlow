/**
 * Shared GL account classification.
 *
 * `gl_accounts.account_type` is NOT NULL and CHECK-constrained to
 * asset/liability/equity/revenue/expense, so it is the only authoritative
 * source for the five top-level buckets. `account_code` is NOT — production
 * charts put assets, liabilities, equity, revenue and expenses all under code
 * prefix `4`, and Sage-imported charts use alphabetic prefixes entirely.
 * Nothing in this module may look at account_code.
 *
 * `account_subtype` is free-form and carries duplicate singular/plural
 * spellings plus importer-specific tokens, so it is canonicalised here before
 * anything is derived from it. Where it is NULL or unrecognised, assets and
 * liabilities default to CURRENT — and the default is counted, so callers can
 * warn instead of presenting a guess as a fact.
 */

import { SUBTYPE_ALIASES, type CanonicalSubtype } from './accountSubtypeVocabulary';

export type { CanonicalSubtype } from './accountSubtypeVocabulary';

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

const NON_CURRENT: ReadonlySet<CanonicalSubtype> = new Set<CanonicalSubtype>([
  'fixed_asset',
  'accumulated_depreciation',
  'intangible_asset',
  'investment',
  'non_current_asset',
  'long_term_liability',
  'non_current_liability',
]);

/** Normalise then look up. Returns null when absent or ambiguous — never a guess. */
export function canonicalSubtype(raw: string | null | undefined): CanonicalSubtype | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!key) return null;
  return SUBTYPE_ALIASES[key] ?? null;
}

/**
 * Current vs non-current. Only meaningful on the balance sheet, so revenue and
 * expense always answer false. Unknown asset/liability subtypes default to
 * current — see `unclassifiedCount` for how much of the answer that is.
 */
export function isCurrentSubtype(
  accountType: AccountType,
  subtype: string | null | undefined
): boolean {
  if (accountType !== 'asset' && accountType !== 'liability') return false;
  const canon = canonicalSubtype(subtype);
  if (canon === null) return true;
  return !NON_CURRENT.has(canon);
}

/**
 * Every raw spelling the alias table knows, so a test can walk the WHOLE
 * domain rather than a copy of it.
 *
 * A guard that enumerates its own inputs stops covering the ones added after
 * it was written, and that is how a band drifts apart from the classifier
 * unnoticed — see `packTrendBanding.test.ts`, which holds the pack trend's SQL
 * bands to `revenueBand`/`expenseBand` over exactly this list.
 */
export const ALL_RAW_SUBTYPES: readonly string[] = Object.keys(SUBTYPE_ALIASES);

/**
 * Every raw `account_subtype` spelling that canonicalises to one of the given
 * tokens. SQL that must filter on subtype (rather than aggregate through
 * `aggregateFigures`) passes this as a TEXT[] so the vocabulary stays defined
 * in exactly one place.
 */
export function rawSubtypesFor(...canonical: CanonicalSubtype[]): string[] {
  const wanted = new Set<CanonicalSubtype>(canonical);
  return Object.keys(SUBTYPE_ALIASES).filter((k) => wanted.has(SUBTYPE_ALIASES[k]!));
}

/** Raw spellings of the cash-and-cash-equivalents subtypes, for SQL filters. */
export const CASH_SUBTYPES: readonly string[] = rawSubtypesFor('bank', 'cash');

/**
 * Raw spellings of every NON-CURRENT token, derived from the same `NON_CURRENT`
 * set `isCurrentSubtype` reads. SQL that partitions the balance sheet passes
 * this, so the current/non-current split cannot disagree between a query and
 * the TypeScript answering the same question. Asset and liability tokens are
 * disjoint by side, so a caller already filtering `account_type` needs only one.
 */
export const NON_CURRENT_SUBTYPES: readonly string[] = rawSubtypesFor(...NON_CURRENT);

/** Every canonical token in the vocabulary. Used by the census lint. */
export const ALL_CANONICAL_SUBTYPES: readonly CanonicalSubtype[] =
  Array.from(new Set(Object.values(SUBTYPE_ALIASES)));

/**
 * Raw spellings meaning inventory / stock. No production account currently
 * carries any of them — see `inventoryWarning` in financialFiguresService.
 */
export const INVENTORY_SUBTYPES: readonly string[] = rawSubtypesFor('inventory');

/**
 * Raw spellings meaning a BANK account specifically — narrower than
 * CASH_SUBTYPES, which also covers petty cash. Use this where the surface is
 * about bank accounts (a bank-account picker, a "Bank Balances" tile, a feed
 * pairing) and CASH_SUBTYPES where it is about cash and cash equivalents.
 */
export const BANK_SUBTYPES: readonly string[] = rawSubtypesFor('bank');

/**
 * The predicate form of `BANK_SUBTYPES`, for the paths that compare a subtype
 * in TypeScript rather than in SQL. Both answer the same question — "does this
 * account hold bank transactions?" — so they must not be able to disagree, and
 * a literal `=== 'bank'` beside a query that accepts `bank_account` is exactly
 * such a disagreement.
 */
export function isBankSubtype(subtype: string | null | undefined): boolean {
  return canonicalSubtype(subtype) === 'bank';
}

/** Raw spellings meaning trade receivables. */
export const RECEIVABLE_SUBTYPES: readonly string[] = rawSubtypesFor('receivable');

/** Raw spellings meaning trade payables. */
export const PAYABLE_SUBTYPES: readonly string[] = rawSubtypesFor('payable');

/**
 * Raw spellings of the non-current asset subtypes whose movement is an
 * investing activity. `fixed_assets` (plural) is 30 accounts in production and
 * was invisible to the singular-only filter this replaces.
 */
export const INVESTING_ASSET_SUBTYPES: readonly string[] = rawSubtypesFor(
  'fixed_asset',
  'non_current_asset',
  'intangible_asset',
  'investment'
);

/** Cash and cash equivalents: bank or cash subtypes on an asset account. */
export function isCashEquivalent(
  accountType: AccountType,
  subtype: string | null | undefined
): boolean {
  if (accountType !== 'asset') return false;
  const canon = canonicalSubtype(subtype);
  return canon === 'bank' || canon === 'cash';
}

