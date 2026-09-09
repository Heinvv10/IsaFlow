/** Public result contracts for controlled financial year close. */
export interface YearEndJournalLine {
  accountId: string;
  accountCode: string;
  accountName: string;
  debit: number;
  exactDebit?: string;
  credit: number;
  exactCredit?: string;
}

export interface YearEndJournalPreview {
  /** The year's last day — where the closing journal lands. */
  entryDate: string;
  entryNumber: string;
  description: string;
  lines: YearEndJournalLine[];
  totalDebit: number;
  totalCredit: number;
  exactTotal?: string;
}

export interface CloseYearResult {
  closingEntry: Record<string, unknown>;
  netIncome: number;
  netIncomeExact?: string;
  message: string;
}

export interface CloseYearDryRunResult {
  dryRun: true;
  netIncome: number;
  netIncomeExact?: string;
  preview: YearEndJournalPreview;
}

export type CloseYearError =
  | { error: 'open_periods'; count: number; openPeriods: Array<{ id: string; periodName: string; periodNumber: number }> }
  | { error: 'year_not_found' }
  | { error: 'no_retained_earnings' }
  | { error: 'ambiguous_retained_earnings'; accountCodes: string[] }
  | { error: 'no_fiscal_period'; entryDate: string }
  | {
      error: 'period_range_mismatch';
      expected: { startDate: string; endDate: string };
      actual: { startDate: string; endDate: string };
      startMonth: number;
    };

export interface CloseYearOptions {
  /** Run every guard and return the journal, writing nothing. */
  dryRun?: boolean;
  approvalId?: string;
}

export { closeFiscalYear } from './controlledYearEnd';
