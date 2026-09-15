/**
 * The VAT201 box arithmetic: derive the taxable BASE from the same journals as
 * the TAX, so that SARS's own 15% check on boxes 1 and 15 ties by construction.
 *
 * THE DEFECT THIS REPLACES. `vatReturnService` reads the tax from journal lines
 * on the VAT control accounts and then reads the values those taxes are meant
 * to be 15% of from an entirely different population — the `subtotal` column of
 * `customer_invoices` and `supplier_invoices`. Two populations cannot be relied
 * on to agree, and on Velocity Fibre for 2026-07-01..2026-08-31 they do not:
 * standardRatedPurchases R15,401,348.82 against input tax R1,544,575.33, which
 * implies a base of R10,297,169. Box 15 fails SARS's check by R5.1m and the
 * return cannot be filed. The same defect was logged on Brightsphere in July
 * and is worth ~R50,000 there.
 *
 * THE RULE. A VAT-bearing journal has three kinds of leg:
 *
 *   tax        — the VAT control account. This is the amount SARS is owed or
 *                is being claimed from it.
 *   settlement — bank, cash, and the receivable/payable control accounts. A
 *                gross money movement or obligation, never a supply.
 *   base       — everything else: revenue, expenses, fixed assets, inventory.
 *                THIS is the value of the supply, and it is what boxes 1 and 15
 *                report.
 *
 * On the Velocity period above the base legs come to R10,326,551.86 of expense,
 * 15% of which is R1,548,982.78 against R1,544,575.33 of tax — a variance of
 * R4,407 rather than R5.1m. That residue is a genuine finding (a journal whose
 * legs are not all standard-rated) and is REPORTED, not smoothed away.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not derive the base as
 * `tax / 0.15`. That would make the 15% check tie on every company in the
 * country and prove precisely nothing — the check exists to detect a ledger
 * where the supply and the tax disagree, and a base computed from the tax
 * cannot ever disagree with it.
 */
import { canonicalSubtype, type CanonicalSubtype } from '../gl/accountSubtypes';
import { isVatOnBalanceSheetException } from './vatBalanceSheetExceptions';

/** The South African standard rate. Boxes 1 and 15 are checked against it. */
export const SA_VAT_RATE = 0.15;

/**
 * Subtypes that ARE the VAT tax leg. Exactly two.
 *
 * `vatReturnService` also accepted `tax`, and that is a defect rather than a
 * looser net. `tax` is the GENERIC tax subtype: Brightsphere account 34550639
 * "Pay As You Earn" is an expense account carrying it, and reading it as VAT
 * pulled R23,219.01 of PAYE into box 15 for 2026-07/08. Picking VAT accounts by
 * a loose bucket is the same class of mistake as picking cost of sales by
 * account name, which overstated gross profit by R562,428.
 *
 * A genuine VAT account mistyped as `tax` is not lost by this: if it carries a
 * VAT code it is reported as `unmapped` and appears in excludedRows with its
 * amount, which is the honest answer — the account has to be retyped, and the
 * report is the thing that says so.
 */
export const VAT_TAX_SUBTYPES = ['vat_input', 'vat_output'] as const;

/** The generic tax subtype. Not VAT; see VAT_TAX_SUBTYPES. */
const GENERIC_TAX_SUBTYPE = 'tax';

/**
 * The settlement leg: gross money or a gross obligation. Counting it as base
 * would report the VAT-inclusive total as the value of the supply.
 *
 * These are CANONICAL tokens, matched through `canonicalSubtype`, not raw
 * `account_subtype` values. A debtors control spelled `debtors` and a bank leg
 * spelled `bank_account` are both real production spellings; against the raw
 * literal they missed this branch and fell through to `base`, where their
 * GROSS, VAT-INCLUSIVE amount was counted as the value of the supply and
 * over-stated boxes 1 and 15 by the whole settlement leg.
 */
export const VAT_SETTLEMENT_SUBTYPES: readonly CanonicalSubtype[] = [
  'bank', 'cash', 'receivable', 'payable',
  // A card or a sundry creditor settles an invoice exactly as a bank account
  // does. Both are offerable subtypes in the Add Account dialog and the MCP
  // write path, and against the four-token list the gross leg fell through to
  // `base`, reporting a NEGATIVE box-15 base of -(the VAT).
  'credit_card', 'other_current_liability',
];

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

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Which of the three roles a line plays in its VAT-bearing journal.
 *
 * The `unmapped` role is the one that earns its keep. Velocity Fibre posts
 * input tax to SYS-9 "VAT Payable" — a liability with a NULL subtype — on
 * `auto_supplier_invoice` journals: 356 posted lines, R4,917,814.24. The
 * subtype filter drops every one of them from the VAT201 today with no signal,
 * and counting them as base instead would be worse, inflating box 15 by the tax
 * itself. They are neither, so they are reported. The predicate is
 * `isVatOnBalanceSheetException`, reused rather than restated so the exceptions
 * report and the return cannot drift apart on what counts as a legitimate
 * VAT-bearing balance-sheet account.
 */
export function classifyVatJournalLine(line: VatLineInput): VatLineClass {
  const subtype = line.accountSubtype;
  // Canonical for the role decisions; the RAW value is still what
  // `isVatOnBalanceSheetException` reads, because its legitimate list carries
  // spellings (`fixed_assets`, `tax`) that are not canonical tokens.
  const canon = canonicalSubtype(subtype);
  const net = (a: number, b: number) => r2(a - b);

  if (line.cancelledSource) {
    const isTax = canon !== null && (VAT_TAX_SUBTYPES as readonly string[]).includes(canon);
    return { role: isTax ? 'cancelled' : 'settlement', amount: Math.abs(net(line.debit, line.credit)) };
  }

  if (canon !== null && (VAT_TAX_SUBTYPES as readonly string[]).includes(canon)) {
    const direction: VatDirection = canon === 'vat_output' ? 'output' : 'input';
    return {
      role: 'tax',
      direction,
      amount: direction === 'output' ? net(line.credit, line.debit) : net(line.debit, line.credit),
      vatType: line.vatType ?? DEFAULT_VAT_TYPE,
    };
  }

  // A generic `tax` account carrying a VAT code is a VAT account with the wrong
  // subtype. Report it; do not guess a direction for it.
  if (subtype === GENERIC_TAX_SUBTYPE && line.vatType !== null && line.vatType !== 'no_vat') {
    return { role: 'unmapped', amount: Math.abs(net(line.debit, line.credit)) };
  }

  if (canon !== null && (VAT_SETTLEMENT_SUBTYPES as readonly string[]).includes(canon)) {
    return { role: 'settlement', amount: net(line.debit, line.credit) };
  }

  if (
    isVatOnBalanceSheetException({
      accountType: line.accountType,
      accountSubtype: subtype,
      vatType: line.vatType,
    })
  ) {
    return { role: 'unmapped', amount: Math.abs(net(line.debit, line.credit)) };
  }

  return { role: 'base', amount: net(line.debit, line.credit) };
}

interface EntryAccumulator {
  baseCredit: number;
  baseDebit: number;
  baseLines: number;
  tax: Map<VatDirection, Map<string, number>>;
}

/**
 * Fold every posted line of every VAT-bearing journal in the period into the
 * VAT201 boxes.
 *
 * Base is apportioned across the VAT types WITHIN a journal pro-rata by tax,
 * because a single supplier invoice can carry a standard-rated line and a
 * capital-goods line against one expense total and nothing in the ledger says
 * which rand of base belongs to which. Pro-rata by tax is the only split that
 * preserves the 15% relationship on each box; where it is wrong, the variance
 * on that box says so.
 */
export function deriveVatBoxes(lines: readonly VatLineInput[]): VatBasisResult {
  const entries = new Map<string, EntryAccumulator>();
  const excluded = new Map<string, VatExcludedLine>();
  let taxLegCount = 0;

  for (const line of lines) {
    const acc = entries.get(line.journalEntryId) ?? {
      baseCredit: 0,
      baseDebit: 0,
      baseLines: 0,
      tax: new Map<VatDirection, Map<string, number>>(),
    };
    entries.set(line.journalEntryId, acc);

    const c = classifyVatJournalLine(line);
    if (c.role === 'tax' && c.direction) {
      taxLegCount++;
      const byType = acc.tax.get(c.direction) ?? new Map<string, number>();
      acc.tax.set(c.direction, byType);
      const vt = c.vatType ?? DEFAULT_VAT_TYPE;
      byType.set(vt, r2((byType.get(vt) ?? 0) + c.amount));
    } else if (c.role === 'base') {
      acc.baseCredit = r2(acc.baseCredit + line.credit - line.debit);
      acc.baseDebit = r2(acc.baseDebit + line.debit - line.credit);
      acc.baseLines++;
    } else if (c.role === 'cancelled') {
      const key = `je:${line.journalEntryId}`;
      const existing = excluded.get(key);
      if (existing) {
        existing.amount = r2(existing.amount + c.amount);
        existing.lineCount++;
      } else {
        excluded.set(key, {
          id: line.journalEntryId,
          reason: 'cancelled_document',
          detail: `${line.entryNumber} was raised by a document that has since been cancelled, but the journal is still posted — its VAT is out of the boxes and still in the GL until a reversal or credit note is posted`,
          amount: c.amount,
          documentNumber: line.entryNumber,
          lineCount: 1,
        });
      }
    } else if (c.role === 'unmapped') {
      const existing = excluded.get(line.accountId);
      if (existing) {
        existing.amount = r2(existing.amount + c.amount);
        existing.lineCount++;
      } else {
        excluded.set(line.accountId, {
          id: line.accountId,
          reason: 'unmapped_vat_treatment',
          detail: `${line.accountCode} ${line.accountName} carries VAT code "${line.vatType}" but has no VAT posting treatment — it is neither a VAT control account nor a base account, so its VAT is in no box`,
          amount: c.amount,
          documentNumber: line.accountCode,
          lineCount: 1,
        });
      }
    }
  }

  const boxTotals = new Map<string, VatBoxRow>();
  const entriesWithoutBase: string[] = [];

  for (const [entryId, acc] of entries) {
    for (const direction of ['output', 'input'] as VatDirection[]) {
      const byType = acc.tax.get(direction);
      if (!byType || byType.size === 0) continue;
      const totalTax = [...byType.values()].reduce((s, v) => s + v, 0);
      const base = direction === 'output' ? acc.baseCredit : acc.baseDebit;
      if (acc.baseLines === 0) entriesWithoutBase.push(entryId);

      for (const [vatType, tax] of byType) {
        // Pro-rata by tax. A single-type journal takes the whole base; a
        // zero-tax type (zero-rated, exempt) takes none, which is correct —
        // its base reaches box 2 or 3 from its own tax leg, not from this one.
        const share = totalTax === 0 ? (byType.size === 1 ? 1 : 0) : tax / totalTax;
        const key = `${direction}:${vatType}`;
        const row = boxTotals.get(key) ?? {
          direction, vatType, base: 0, tax: 0, impliedTax: 0, variance: 0,
        };
        row.base = r2(row.base + base * share);
        row.tax = r2(row.tax + tax);
        boxTotals.set(key, row);
      }
    }
  }

  const boxes = [...boxTotals.values()].map((row) => {
    const impliedTax = r2(row.base * SA_VAT_RATE);
    return { ...row, impliedTax, variance: r2(row.tax - impliedTax) };
  });
  boxes.sort((a, b) => (a.direction === b.direction ? a.vatType.localeCompare(b.vatType) : a.direction < b.direction ? -1 : 1));

  const sum = (d: VatDirection, f: (r: VatBoxRow) => number) =>
    r2(boxes.filter((b) => b.direction === d).reduce((s, b) => s + f(b), 0));

  const outputBase = sum('output', (b) => b.base);
  const inputBase = sum('input', (b) => b.base);
  const outputTax = sum('output', (b) => b.tax);
  const inputTax = sum('input', (b) => b.tax);
  const outputImpliedTax = r2(outputBase * SA_VAT_RATE);
  const inputImpliedTax = r2(inputBase * SA_VAT_RATE);
  const outputVariance = r2(outputTax - outputImpliedTax);
  const inputVariance = r2(inputTax - inputImpliedTax);

  const excludedRows = [...excluded.values()].sort((a, b) => b.amount - a.amount);

  return {
    boxes,
    outputBase, outputTax, outputImpliedTax, outputVariance,
    inputBase, inputTax, inputImpliedTax, inputVariance,
    ties:
      entriesWithoutBase.length === 0 &&
      Math.abs(outputVariance) <= RATE_CHECK_TOLERANCE &&
      Math.abs(inputVariance) <= RATE_CHECK_TOLERANCE,
    entriesWithoutBase: entriesWithoutBase.slice(0, MAX_LISTED_ENTRIES_WITHOUT_BASE),
    entriesWithoutBaseTotal: entriesWithoutBase.length,
    excluded: excludedRows,
    excludedLineCount: excludedRows.reduce((s, r) => s + r.lineCount, 0),
    excludedAmount: r2(excludedRows.reduce((s, r) => s + r.amount, 0)),
    taxLegCount,
  };
}
