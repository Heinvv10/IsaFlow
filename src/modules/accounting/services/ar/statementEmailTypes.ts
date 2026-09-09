/**
 * Statement Email Types
 * Split out of statementEmailService.ts to keep that file under the 300-line
 * cap. The service re-exports these, so no caller import path changes.
 */

export interface StatementTransaction {
  date: string;
  type: 'invoice' | 'payment' | 'credit_note';
  reference: string;
  debit: number;
  credit: number;
  balance: number;
}

/** A candidate row the statement could not include, and why. */
export interface StatementExclusion {
  id: string;
  /** Machine-stable snake_case code — callers branch on it. */
  reason: string;
  detail?: string;
  amount?: number;
  documentNumber?: string;
}

export interface StatementPayload {
  customer: { id: string; name: string; email: string | null };
  /**
   * The date of the EARLIEST transaction on the statement, not a rolling
   * window. None of the three queries has a lower bound, so a statement runs
   * from inception; the previous value was `Date.now() − 365 days` computed
   * through toISOString(), which both claimed a window the query did not use
   * and rolled back a day on this UTC+2 host.
   */
  fromDate: string;
  toDate: string;
  transactions: StatementTransaction[];
  /** Candidate rows deliberately left out of the running balance. Never omitted. */
  excluded: StatementExclusion[];
  /** Candidate rows before any classification filter: transactions + excluded. */
  universeTotal: number;
  summary: {
    totalInvoiced: number;
    totalPaid: number;
    totalCredits: number;
    balance: number;
  };
}
