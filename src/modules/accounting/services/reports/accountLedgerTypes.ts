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
  total: number;
  openingBalance: number;
  /** Sum of (debits − credits) over the FULL date range — server-computed, not a client-side slice reduce. */
  periodNet: number;
  /** Opening balance + periodNet — the true period closing balance regardless of pagination. */
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
  fromDate: string;
  toDate: string;
  /** Default: true — only include posted entries */
  postedOnly?: boolean;
  /** Default: 200 */
  limit?: number;
  /** Default: 0 */
  offset?: number;
}

