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

import { toMoney } from '@/lib/money/decimalSum';
import {
  canonicalSubtype,
  isDisposalGainLossSubtype,
  type AccountType,
} from '@/modules/accounting/services/gl/accountSubtypes';

/**
 * The system account every tenant is seeded with for the current portion of long-term debt (migration 471). Its
 * subtype, `current_liability`, is shared with ordinary current liabilities, so the subtype alone cannot say it is debt;
 * the code does, on a system account only (an imported chart's own 2215 is not flagged as one).
 */
export const SEEDED_CURRENT_PORTION_CODE = '2215';

/** In presentation order within each section: the screen's long-standing lines first. */
export const INDIRECT_BUCKETS = [
  'net_income', 'receivable', 'payable', 'depreciation', 'disposal_adjustment', 'inventory', 'vat', 'other_operating', 'non_cash',
  'investing',
  'equity', 'debt', 'retained_earnings',
] as const;

export type IndirectBucket = (typeof INDIRECT_BUCKETS)[number];
export type IndirectSection = 'operating' | 'investing' | 'financing';

const SECTION: Record<IndirectBucket, IndirectSection> = {
  net_income: 'operating',
  depreciation: 'operating',
  disposal_adjustment: 'operating',
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

/**
 * The line a NON-cash account's movement lands in. The caller never passes the cash accounts themselves.
 * `isLoanCurrentPortion` says the account is the current portion of debt (the query knows; a subtype cannot say), which
 * makes a liability with no line of its own a loan. A trade payable or VAT control keeps its line whatever a loan names.
 */
export function classifyIndirectLine(
  accountType: AccountType, subtype: string | null | undefined, isLoanCurrentPortion = false,
): IndirectBucket {
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
    case 'credit_card':
    // A liability spelled bank / cash is a credit card, as in the direct method.
    case 'bank':
    case 'cash': return 'debt';
    default: return isLoanCurrentPortion ? 'debt' : 'other_operating';
  }
}

export interface JournalLeg {
  accountType: AccountType;
  subtype: string | null | undefined;
  isLoanCurrentPortion?: boolean;
  creditLessDebit: number;
}

/**
 * A journal is a disposal when it is the asset-disposal journal (its source, which a reversal copies) or carries a
 * disposal gain/loss leg. Only there do the accumulated depreciation released and the gain or loss belong with the
 * proceeds in investing; everywhere else accumulated depreciation nets into the operating add-back (a charge and its
 * reversal, a reclass between two such accounts, cancel instead of inventing an operating inflow and an investing outflow).
 */
export function isDisposalJournal(source: string | null | undefined, legs: readonly JournalLeg[]): boolean {
  return source === DISPOSAL_JOURNAL_SOURCE || legs.some((l) => isDisposalGainLossSubtype(l.subtype));
}
export const DISPOSAL_JOURNAL_SOURCE = 'auto_asset_disposal';

export interface PlacedAmount { bucket: IndirectBucket; amount: number }

/**
 * Where one journal's non-cash legs land, given the journal's net movement on its cash accounts (debit less credit).
 * Only the cash that actually moved is an investing or financing flow; the rest of those legs lands in `non_cash`
 * (operating). A R10 000 asset bought with R2 000 cash and an R8 000 loan is investing -2 000, and non_cash nets the
 * remaining -8 000 against the loan's +8 000. An asset bought wholly on a loan (no cash leg, netCash 0) moves nothing.
 * Operating legs always keep their own lines, and:
 * - when they run the same way as the cash they account for that much of it (a purchase's input VAT paid in cash);
 * - when they run against it they funded the journal without cash (the part of an asset bought on account).
 * Of what remains, only legs running the same way as the cash can have taken it; if those legs exceed it (rare: a
 * single journal with cash, an asset and a loan repayment, part on account) each takes a pro-rata share.
 * Every leg's whole amount is placed, so a journal's placed amounts always sum to its legs and the tie-out holds.
 */
export function placeJournal(legs: readonly JournalLeg[], netCash: number, disposal = false): PlacedAmount[] {
  const placed: PlacedAmount[] = [];
  const nonOperating = new Map<IndirectBucket, number>();
  let operating = 0;
  for (const leg of legs) {
    let bucket = classifyIndirectLine(leg.accountType, leg.subtype, leg.isLoanCurrentPortion);
    if (disposal && bucket === 'depreciation') bucket = 'investing'; // the release of accumulated depreciation leaves with the asset
    if (disposal && isDisposalGainLossSubtype(leg.subtype)) {
      // The gain or loss stays in Net Income (the income statement's figure), is taken back out in operating, and its
      // amount joins the proceeds in investing: cost, accumulated depreciation and gain together are the cash received.
      placed.push({ bucket: 'net_income', amount: leg.creditLessDebit });
      placed.push({ bucket: 'disposal_adjustment', amount: -leg.creditLessDebit });
      nonOperating.set('investing', (nonOperating.get('investing') ?? 0) + leg.creditLessDebit);
      continue;
    }
    if (SECTION[bucket] === 'operating') {
      placed.push({ bucket, amount: leg.creditLessDebit });
      operating += leg.creditLessDebit;
    } else {
      nonOperating.set(bucket, (nonOperating.get(bucket) ?? 0) + leg.creditLessDebit);
    }
  }

  const way = Math.sign(netCash);
  const sameWay = (amount: number) => way !== 0 && Math.sign(amount) === way;
  const operatingDraw = sameWay(toMoney(operating)) ? toMoney(operating) : 0;
  const available = Math.abs(operatingDraw) >= Math.abs(netCash) ? 0 : netCash - operatingDraw;
  const nonOperatingAmounts = [...nonOperating].map(([bucket, amount]) => [bucket, toMoney(amount)] as const);
  const candidates = nonOperatingAmounts.reduce((sum, [, amount]) => (sameWay(amount) ? sum + amount : sum), 0);
  const share = candidates === 0 ? 0 : Math.min(1, available / candidates);

  for (const [bucket, amount] of nonOperatingAmounts) {
    const cash = sameWay(amount) ? toMoney(amount * share) : 0;
    if (cash !== 0) placed.push({ bucket, amount: cash });
    if (cash !== amount) placed.push({ bucket: 'non_cash', amount: amount - cash });
  }
  return placed;
}
