/**
 * What a bank statement parser returns (re-exported by bank.types.ts, whose callers import it from there).
 */

export interface ParsedBankTransaction {
  transactionDate: string; // YYYY-MM-DD
  valueDate?: string;
  amount: number; // positive = deposit, negative = withdrawal
  description: string;
  reference?: string;
  balance?: number;
  /**
   * PDFs only, set by a parser that derives `amount` from the balances (ABSA): the absolute amount the
   * line printed. A derived amount that differs from it means a row between two balances was dropped.
   */
  printedAmount?: number;
}

/**
 * Where a statement's opening/closing balance came from, or why there is none (bank_import_batches.balance_source,
 * migration 998). See bankStatementBalances.ts for the rules.
 */
export type BalanceSource = 'printed' | 'running_balance' | 'pdf_read' | 'ai_read' | 'not_in_file' | 'unverified';

/** A statement's balances, worked out from the WHOLE file (before the ledger-window filter and dedupe), in cents. */
export interface StatementBalances {
  source: BalanceSource;
  /** Null unless `source` is 'printed', 'running_balance' or 'pdf_read' (for 'printed', only when the file states one). */
  openingCents: number | null;
  closingCents: number | null;
  /** The latest YYYY-MM-DD transaction date in the file; null when no line has one. */
  asAt: string | null;
}

export interface BankCsvParseResult {
  transactions: ParsedBankTransaction[];
  errors: Array<{ row: number; error: string }>;
  bankFormat: string;
  /**
   * PDFs only: 'native' when the parser written for the statement's own bank read the rows (ABSA's, or
   * the per-bank factory's); 'fallback' when the ABSA date-amount pattern was applied to another or
   * unrecognised layout, which reads some rows and silently drops the rest.
   */
  parser?: 'native' | 'fallback';
  /**
   * The balance the statement opened with, before its first row: a PDF's printed "balance brought forward"
   * (the trust test in nativeParseTrust compares the rows against it) or MT940's `:60F:`.
   */
  openingBalance?: number;
  /** The balance the file states at its end: OFX `BALAMT` (LEDGERBAL), MT940 `:62F:`. */
  closingBalance?: number;
  /**
   * Set by a parser that read something which makes its balances untrustworthy: a balance cell that is not a plain
   * number, a file holding more than one account or statement, chained statements that do not join. The text says
   * what; deriveStatementBalances then answers 'unverified'.
   */
  balancesUnverifiable?: string;
  /** Set by parseStatement from the raw parse (deriveStatementBalances); importParsedTransactions writes it. */
  statementBalances?: StatementBalances;
  /**
   * Account number extracted from the statement (PDFs only, when the parser
   * can find it in the header). Normalised — no spaces, dashes, or other
   * separators. Used by the import API to verify the uploaded statement
   * actually belongs to the bank account the user selected for import.
   *
   * Undefined for CSV imports (no header) or unknown bank formats where
   * the account number could not be located. In those cases the import API
   * allows the import to proceed but logs a warning.
   */
  accountNumber?: string;
}
