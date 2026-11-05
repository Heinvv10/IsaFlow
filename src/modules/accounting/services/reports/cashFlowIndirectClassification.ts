/**
 * Which line of the indirect cash flow statement a non-cash account's movement belongs to.
 *
 * By double entry, cash moves by the credit-less-debit of every NON-cash journal line, so a statement ties to the
 * ledger's cash only if EVERY non-cash account lands in exactly one line. The screen used to list four kinds (P&L,
 * receivables, payables, fixed assets and equity) and drop the rest; VAT control, inventory, prepayments, payroll and
 * other current liabilities, accumulated depreciation, loans and retained earnings fell through. This is the one
 * classification, a pure function over (account_type, account_subtype) through `canonicalSubtype`, so the whole
 * vocabulary (and null, and a subtype nobody has met) is held by a test that walks it.
 *
 * Lines the vocabulary cannot place are OPERATING (`other_operating`), as the direct method does
 * (`cashFlowClassification.classifyCashGroup`): the cash moved, and dropping it would break the tie-out.
 */

import {
  canonicalSubtype,
  type AccountType,
} from '@/modules/accounting/services/gl/accountSubtypes';

/** In presentation order within each section: the screen's long-standing lines first. */
export const INDIRECT_BUCKETS = [
  'net_income', 'receivable', 'payable', 'depreciation', 'inventory', 'vat', 'other_operating', 'non_cash',
  'investing',
  'equity', 'debt', 'retained_earnings',
] as const;

export type IndirectBucket = (typeof INDIRECT_BUCKETS)[number];
export type IndirectSection = 'operating' | 'investing' | 'financing';

const SECTION: Record<IndirectBucket, IndirectSection> = {
  net_income: 'operating',
  depreciation: 'operating',
  receivable: 'operating',
  inventory: 'operating',
  payable: 'operating',
  vat: 'operating',
  other_operating: 'operating',
  non_cash: 'operating',
  investing: 'investing',
  debt: 'financing',
  equity: 'financing',
  retained_earnings: 'financing',
};

export function bucketSection(bucket: IndirectBucket): IndirectSection {
  return SECTION[bucket];
}

/** The line a NON-cash account's movement lands in. The caller never passes the cash accounts themselves. */
export function classifyIndirectLine(accountType: AccountType, subtype: string | null | undefined): IndirectBucket {
  if (accountType === 'revenue' || accountType === 'expense') return 'net_income';
  const canon = canonicalSubtype(subtype);
  if (accountType === 'equity') return canon === 'retained_earnings' ? 'retained_earnings' : 'equity';

  if (accountType === 'asset') {
    switch (canon) {
      case 'receivable': return 'receivable';
      case 'inventory': return 'inventory';
      case 'vat_input':
      case 'vat_input_late_claim': return 'vat';
      // The non-cash charge's other leg: added back to net income.
      case 'accumulated_depreciation': return 'depreciation';
      case 'fixed_asset':
      case 'intangible_asset':
      case 'investment':
      case 'non_current_asset': return 'investing';
      default: return 'other_operating';
    }
  }

  switch (canon) {
    case 'payable': return 'payable';
    case 'vat_output': return 'vat';
    case 'long_term_liability':
    case 'non_current_liability':
    case 'credit_card': return 'debt';
    default: return 'other_operating';
  }
}

/**
 * The line a NON-cash journal line lands in, given whether its journal has a cash leg. A journal with no cash leg moved
 * no cash, so it must not show as an investing or financing cash flow: an asset bought on a loan would otherwise read
 * as an investing outflow and an equal financing inflow, and one bought on account as an investing outflow funded by
 * operating payables. Those legs land in `non_cash` (operating), where they offset the journal's other legs: the whole
 * journal sums to zero, so the tie-out to cash holds, and net income and working capital keep their own lines.
 */
export function indirectLineFor(
  accountType: AccountType, subtype: string | null | undefined, journalHasCashLeg: boolean,
): IndirectBucket {
  const bucket = classifyIndirectLine(accountType, subtype);
  return !journalHasCashLeg && SECTION[bucket] !== 'operating' ? 'non_cash' : bucket;
}
