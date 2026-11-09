/**
 * Shared types and thresholds of the VAT201 box derivation (vatBoxBasis.ts). A pure move out of that file
 * to keep it under the 300-line limit; vatBoxBasis re-exports every name, so no importer changes.
 */

/** Default when a tax leg carries no `vat_type`, matching the existing box-1/box-15 fallback. */
export const DEFAULT_VAT_TYPE = 'standard';

/** Rands of variance tolerated before the 15% check is called failed. */
export const RATE_CHECK_TOLERANCE = 1;

/** A book with thousands of unbalanced journals must not blow the response. */
export const MAX_LISTED_ENTRIES_WITHOUT_BASE = 50;

export type VatDirection = 'output' | 'input';
export type VatLineRole = 'tax' | 'base' | 'settlement' | 'unmapped' | 'cancelled';

export interface VatLineInput {
  journalEntryId: string;
  entryNumber: string;
  entryDate: string;
  lineId: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  accountSubtype: string | null;
  vatType: string | null;
  debit: number;
  credit: number;
  /**
   * True when this journal was raised by a document that has since been
   * cancelled or voided.
   *
   * Brightsphere has a cancelled customer invoice whose journal is still
   * posted, carrying R3,750 of output VAT. The tax is not due, so it does not
   * belong in box 1; the journal IS posted, so the GL has it regardless. The
   * report takes it out of the box and names it in excludedRows — the reader
   * gets the filable figure AND the credit note that still has to be posted,
   * and the difference between the return and the VAT control account is
   * explained rather than merely present.
   */
  cancelledSource: boolean;
}

export interface VatLineClass {
  role: VatLineRole;
  /** Present on a tax leg. */
  direction?: VatDirection;
  /** Signed so that a normal posting is positive: credit-positive for output, debit-positive for input. */
  amount: number;
  vatType?: string;
}

export interface VatBoxRow {
  direction: VatDirection;
  vatType: string;
  base: number;
  tax: number;
  impliedTax: number;
  variance: number;
}

/**
 * VAT the report could not place in any box, grouped by ACCOUNT rather than by
 * line.
 *
 * Per-line was the first cut and it does not survive a real book: Velocity
 * Fibre has 356 unmapped lines on one account and they came to 103KB of
 * near-identical rows, which is the same response-size defect this rewrite
 * exists to fix — reintroduced in the completeness block. One row per account
 * is also the right granularity for a reader: "R4,917,814.24 on SYS-9 across
 * 356 lines" is ONE finding, and it is the account that has to be fixed, not
 * each posting. `lineCount` keeps the underlying number in front of the reader.
 */
export interface VatExcludedLine {
  /** The account id — the thing that has to be fixed. */
  id: string;
  reason: string;
  detail: string;
  /** Total unplaced VAT on this account for the period. */
  amount: number;
  /** Account code, so the row can be chased without a second lookup. */
  documentNumber: string;
  /** Posted lines behind `amount`. */
  lineCount: number;
}

export interface VatBasisResult {
  boxes: VatBoxRow[];
  outputBase: number;
  outputTax: number;
  outputImpliedTax: number;
  outputVariance: number;
  inputBase: number;
  inputTax: number;
  inputImpliedTax: number;
  inputVariance: number;
  /** True when BOTH standard-rated boxes are within RATE_CHECK_TOLERANCE and no journal lacked a base. */
  ties: boolean;
  /** Journals carrying tax with no base leg at all — a base of zero would be a lie. Capped at MAX_LISTED_ENTRIES_WITHOUT_BASE. */
  entriesWithoutBase: string[];
  /** How many such journals there are in total, whether or not they are listed. */
  entriesWithoutBaseTotal: number;
  /** Accounts whose VAT this report could not place. Never silently dropped. */
  excluded: VatExcludedLine[];
  /** Posted lines behind `excluded`, summed across accounts. */
  excludedLineCount: number;
  /** Rands behind `excluded`, summed across accounts. */
  excludedAmount: number;
  /** Tax legs the boxes are built from, for the completeness identity. */
  taxLegCount: number;
}

/**
 * Receives the base each (journal, direction, VAT type) contributes to its box, unrounded, as
 * the box adds it. The VAT201 drill-down reads its per-row base from here rather than re-deriving it.
 */
export type VatBaseSink = (share: { journalEntryId: string; direction: VatDirection; vatType: string; base: number }) => void;
