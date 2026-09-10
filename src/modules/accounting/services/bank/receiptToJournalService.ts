/**
 * Receipt-to-Journal Service
 * Converts receipt/expense photo extractions into GL journal entries.
 * Pure business logic — no database dependencies.
 */

import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';
import type { VatType } from '@/modules/accounting/types/gl.types';
import { applyVatDenial, VAT_CODE_STANDARD } from '@/modules/accounting/services/gl/inputVatDenial';
import { isUnreconciled } from '@/modules/accounting/services/core/ocrAmountReconciliation';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReceiptAccountMapping {
  id: string;
  code: string;
  name: string;
}

export interface ReceiptAutoPostConfig {
  maxAmount: number;
  minConfidence: number;
}

export interface JournalLine {
  accountId: string;
  debit: number;
  credit: number;
  description: string;
  /**
   * `'standard'` where input tax is claimed, `'no_vat'` where s17(2)(a) took
   * the claim away — never absent on the expense legs, so a denial is a
   * recorded classification rather than the absence of one. Undefined only on
   * the cash leg, which classifies no supply. Tagging matters beyond reporting:
   * `vatType` is what puts a posting route inside the scope of
   * `scripts/ci/check-vat-guard-coverage.ts`, and a path this gate cannot see
   * is a path the next unattended VAT claim can be added to silently.
   */
  vatType?: VatType;
}

export interface JournalEntryInput {
  entryDate: string;
  description: string;
  source: string;
  lines: JournalLine[];
  /**
   * True when s17(2)(a) took the claim away. Returned rather than left in the
   * log, because `inputVatDenial` documents the unattended contract as
   * "coerces to 'none' AND THE CALLER REPORTS IT" — an operator who is never
   * told cannot correct a misclassified merchant.
   */
  inputVatDenied: boolean;
}

export interface AccountSuggestion {
  id: string;
  code: string;
  name: string;
}

export interface ReceiptValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

type ReceiptType = 'fuel' | 'meals' | 'travel' | 'office_supplies' | 'general';

// ---------------------------------------------------------------------------
// Merchant → GL Account mapping (SA merchants)
// ---------------------------------------------------------------------------

const MERCHANT_PATTERNS: Array<{ pattern: RegExp; accountCode: string; type: ReceiptType }> = [
  // Fuel
  { pattern: /engen|shell|caltex|sasol|bp |total |fuel|petrol|diesel/i, accountCode: '5400', type: 'fuel' },
  // Meals & entertainment
  { pattern: /spur|nandos|steers|mcdonald|kfc|wimpy|ocean basket|mugg.*bean|uber\s*eat|mr\s*d|restaurant|cafe|coffee/i, accountCode: '5600', type: 'meals' },
  // Travel
  { pattern: /uber(?!\s*eat)|bolt|taxify|airport|flight|hotel|lodge|airbnb|protea\s*hotel/i, accountCode: '5600', type: 'travel' },
  // Office supplies
  { pattern: /office\s*national|pen\s*and\s*paper|waltons|takealot|incredible|stationery/i, accountCode: '5100', type: 'office_supplies' },
  // Telecoms → admin
  { pattern: /mtn|vodacom|telkom|cell\s*c|rain|afrihost/i, accountCode: '5600', type: 'general' },
  // Groceries / consumables
  { pattern: /woolworths|checkers|pick\s*n\s*pay|shoprite|spar|makro|game/i, accountCode: '5100', type: 'general' },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function validateReceiptExtraction(extracted: ExtractedDocument): ReceiptValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (extracted.totalAmount === null || extracted.totalAmount === undefined) {
    errors.push('totalAmount is required');
  }
  if (!extracted.date) {
    errors.push('date is required');
  } else {
    const d = new Date(extracted.date);
    if (d > new Date()) errors.push('Receipt date is in the future');
  }
  if (extracted.vatAmount === null || extracted.vatAmount === undefined) {
    warnings.push('VAT amount not extracted — will be calculated from total');
  }
  if (!extracted.vendorName) {
    warnings.push('Merchant name not extracted');
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function mapMerchantToExpenseAccount(
  merchantName: string,
  accounts: ReceiptAccountMapping[],
): AccountSuggestion | null {
  const name = merchantName.toLowerCase();

  for (const mapping of MERCHANT_PATTERNS) {
    if (mapping.pattern.test(name)) {
      const account = accounts.find(a => a.code === mapping.accountCode);
      if (account) return { id: account.id, code: account.code, name: account.name };
    }
  }

  return null;
}

export function buildExpenseJournalFromReceipt(
  extracted: ExtractedDocument,
  accountIds: { expenseAccountId: string; vatInputAccountId: string; bankAccountId: string },
  options: { accountVatDenied?: boolean } = {},
): JournalEntryInput {
  const total = extracted.totalAmount ?? 0;
  const vatRate = extracted.vatRate ?? 15;

  let vatAmount: number;
  let subtotal: number;

  if (extracted.vatAmount !== null && extracted.vatAmount !== undefined && extracted.subtotal !== null && extracted.subtotal !== undefined) {
    vatAmount = extracted.vatAmount;
    subtotal = extracted.subtotal;
  } else {
    // Calculate VAT-inclusive → exclusive
    subtotal = Math.round((total / (1 + vatRate / 100)) * 100) / 100;
    vatAmount = Math.round((total - subtotal) * 100) / 100;
  }

  const merchantDesc = extracted.vendorName || 'Unknown merchant';

  // s17(2)(a) denies input tax on entertainment, and nothing downstream knew:
  // the VAT-input leg was emitted unconditionally, so every restaurant receipt
  // this service routed to 5600 also claimed its 15% back. Key the denial off
  // the RECEIPT TYPE, not the account code — `travel` and telecoms map to 5600
  // too and their input tax is claimable. Unattended: both callers auto-post
  // under a confidence gate with nobody watching, which is the one shape
  // `applyVatDenial` is allowed to coerce rather than warn about.
  // Two independent inputs, either of which denies the claim.
  //
  // `accountVatDenied` is the authoritative one: the `gl_accounts.vat_input_denied`
  // marker that migration 521 sets, resolved by the caller against the account
  // this receipt is actually being coded to. The merchant heuristic below is
  // the second, and it is a heuristic — MERCHANT_PATTERNS knows Spur and Nandos
  // and not Tashas, Marble or a corporate caterer. Relying on it alone left the
  // flag the module calls "the marker" unread, and left post-expense — where a
  // user or a capture rule picks the account, not the merchant map — claiming
  // on a flagged Entertainment account.
  //
  // Keyed off the receipt TYPE and not the account code: `travel` and telecoms
  // map to 5600 too and their input tax is claimable.
  const { denied } = applyVatDenial(
    Boolean(options.accountVatDenied) || parseReceiptType(extracted) === 'meals',
    VAT_CODE_STANDARD,
    { vendorName: extracted.vendorName, source: 'receipt_to_journal' },
  );
  // A denial is a CLASSIFICATION, so it is recorded as one. Leaving `vatType`
  // undefined made "denied under s17(2)(a)" indistinguishable from "nobody
  // classified this line", with the only trace of the decision a description
  // string — an exception report cannot read prose.
  //
  // The value is `'no_vat'`, not the `'none'` that `applyVatDenial` returns.
  // Those are two vocabularies: `'none'` is the BANK vat_code, and `VatType` —
  // what `gl_journal_lines.vat_type` stores and VAT201 reads — spells the same
  // fact `'no_vat'`. `bankAllocationService` maps the code to the type the same
  // way rather than writing the code through. Writing `'none'` into the column
  // would put a token in the ledger that no reader recognises.
  const deniedVatType: VatType = 'no_vat';
  // The gross stays on the expense leg as subtotal + vatAmount, never `total`:
  // the three figures are extracted independently and the callers' pre-check
  // rejects an entry where they disagree. Collapsing to `total` would hide it.
  const expenseDebit = denied ? Math.round((subtotal + vatAmount) * 100) / 100 : subtotal;

  return {
    entryDate: extracted.date || new Date().toISOString().split('T')[0]!,
    description: `Receipt: ${merchantDesc}${extracted.referenceNumber ? ` (${extracted.referenceNumber})` : ''}`,
    source: 'auto_invoice',
    inputVatDenied: denied,
    lines: [
      {
        accountId: accountIds.expenseAccountId,
        debit: expenseDebit,
        credit: 0,
        description: denied ? `${merchantDesc} (input VAT denied — s17(2)(a))` : merchantDesc,
        vatType: denied ? deniedVatType : ('standard' as VatType),
      },
      // Zero on a denial. Both callers drop zero-value legs before posting, so
      // the entry reaches the ledger with no VAT-input line at all.
      {
        accountId: accountIds.vatInputAccountId,
        debit: denied ? 0 : vatAmount,
        credit: 0,
        description: 'VAT Input',
        vatType: denied ? deniedVatType : ('standard' as VatType),
      },
      { accountId: accountIds.bankAccountId, debit: 0, credit: total, description: `Payment: ${merchantDesc}` },
    ],
  };
}

/**
 * May this receipt post with nobody looking at it?
 *
 * `warnings` is not decoration. The reader rebases a printed subtotal its own
 * total and tax contradict whenever the derived split looks standard-rated —
 * right for a levy printed below the subtotal, and the same band admits a total
 * mis-read by a percent or two. The printed subtotal was the only checksum on
 * those three independently-extracted figures, so a document that used to stop
 * at the callers' balance pre-check now balances at the wrong total. The rebase
 * stays for the attended path, where `ExtractedDocument.warnings` is rendered;
 * this gate is the unattended one, and it refuses what the reader could not
 * settle. Neither `totalAmount` nor `confidence` carries that fact — confidence
 * is computed from which FIELDS were found, not from whether they agree.
 */
export function shouldAutoPostReceipt(
  totalAmount: number,
  confidence: number,
  config: ReceiptAutoPostConfig,
  warnings?: readonly string[] | null,
): boolean {
  if (isUnreconciled(warnings)) return false;
  return totalAmount < config.maxAmount && confidence >= config.minConfidence;
}

export function parseReceiptType(extracted: ExtractedDocument): ReceiptType {
  if (!extracted.vendorName) return 'general';
  const name = extracted.vendorName.toLowerCase();

  for (const mapping of MERCHANT_PATTERNS) {
    if (mapping.pattern.test(name)) return mapping.type;
  }

  return 'general';
}
