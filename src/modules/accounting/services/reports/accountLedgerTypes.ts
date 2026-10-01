export interface AccountLedgerRow {
  journalEntryId: string;
  entryDate: string;
  entryNumber: string;
  description: string;
  reference: string;
  source: string;
  debit: number;
  credit: number;
  runningBalance: number;
  /** A year-end close row (gl/fiscalYearCloseRows): derived, not posted — no journal behind it. */
  derived?: boolean;
}

export interface AccountLedgerMeta {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  normalBalance: string;
}

export interface AccountLedgerResult {
  rows: AccountLedgerRow[];
  /** Rows across all pages: journal lines plus any derived year-end close rows. */
  total: number;
  /** How many of `total` are derived year-end close rows (the rest are posted journal lines). */
  derivedRows: number;
  openingBalance: number;
  /**
   * Movement for the period: posted lines only, over the FULL date range — server-computed,
   * not a client-side slice reduce. Equals the income statement's line for the same range.
   */
  periodNet: number;
  /**
   * Normal-side total of the derived year-end close rows (0 when the range crosses no
   * fiscal-year start, and always 0 for balance-sheet accounts).
   */
  closedToRetainedEarnings: number;
  /** Opening + periodNet + closedToRetainedEarnings — the balance as at toDate, i.e. the TB's. */
  periodClosingBalance: number;
  meta: AccountLedgerMeta;
}

export interface GetAccountLedgerParams {
  companyId: string;
  /** UUID of the GL account. Either accountId or accountCode is required. */
  accountId?: string;
  /** Account code (e.g. "1110"). Either accountId or accountCode is required. */
  accountCode?: string;
  costCentreId?: string;
  businessUnitId?: string;
  fromDate: string;
  toDate: string;
  /** Default: true — only include posted entries */
  postedOnly?: boolean;
  /** Default: 200 */
  limit?: number;
  /** Default: 0 */
  offset?: number;
}
