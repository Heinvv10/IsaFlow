// Public shapes for the loans module. Extracted from loanService.ts to keep
// that file under the 300-line limit; loanService re-exports every name, so
// existing importers are unaffected.

export type LoanVatType = 'standard' | 'zero' | 'exempt';

export interface Loan {
  id: string;
  companyId: string;
  curveId: string | null;
  counterpartyId: string | null;
  glAccountId: string | null;
  reference: string | null;
  product: string | null;
  description: string | null;
  principal: number;
  startDate: string;
  termMonths: number;
  rateMode: 'FIXED' | 'PRIME_PLUS' | 'PRIME_MINUS';
  margin: number;
  fixedRate: number | null;
  residual: number;
  dayCount: 'ACTUAL_365' | 'ACTUAL_360' | '30_360';
  repriceMode: 'RESOLVE_ON_RATE_CHANGE' | 'RESOLVE_EVERY_PERIOD' | 'FIXED_INSTALLMENT';
  skipMode: 'EXTEND_TERM' | 'MAINTAIN_TERM';
  lumpMode: 'REDUCE_INSTALLMENT' | 'MAINTAIN_INSTALLMENT';
  recurringSkipMonths: number[];
  status: 'active' | 'closed' | 'written_off';
  ncaCompliant: boolean;
  currency: string;
  /** Upfront origination fee (ZAR, excl VAT). Default 0. */
  originationFee: number;
  /** VAT treatment of the origination fee. Interest itself is always exempt. */
  originationFeeVatType: LoanVatType;
  createdAt: string;
  updatedAt: string;
}

export interface LoanCreateInput {
  curveId?: string;
  counterpartyId?: string;
  glAccountId?: string;
  reference?: string;
  product?: string;
  description?: string;
  principal: number;
  startDate: string;
  termMonths: number;
  rateMode: 'FIXED' | 'PRIME_PLUS' | 'PRIME_MINUS';
  margin?: number;
  fixedRate?: number;
  residual?: number;
  dayCount?: 'ACTUAL_365' | 'ACTUAL_360' | '30_360';
  repriceMode?: 'RESOLVE_ON_RATE_CHANGE' | 'RESOLVE_EVERY_PERIOD' | 'FIXED_INSTALLMENT';
  skipMode?: 'EXTEND_TERM' | 'MAINTAIN_TERM';
  lumpMode?: 'REDUCE_INSTALLMENT' | 'MAINTAIN_INSTALLMENT';
  recurringSkipMonths?: number[];
  currency?: string;
  originationFee?: number;
  originationFeeVatType?: LoanVatType;
}

export interface LoanUpdateInput {
  status?: 'active' | 'closed' | 'written_off';
  glAccountId?: string;
  reference?: string;
  description?: string;
  // Financial terms — editable when no GL postings exist on the loan.
  principal?: number;
  startDate?: string;
  termMonths?: number;
  rateMode?: 'FIXED' | 'PRIME_PLUS' | 'PRIME_MINUS';
  margin?: number;
  fixedRate?: number;
  residual?: number;
  dayCount?: 'ACTUAL_365' | 'ACTUAL_360' | '30_360';
  repriceMode?: 'RESOLVE_ON_RATE_CHANGE' | 'RESOLVE_EVERY_PERIOD' | 'FIXED_INSTALLMENT';
  skipMode?: 'EXTEND_TERM' | 'MAINTAIN_TERM';
  lumpMode?: 'REDUCE_INSTALLMENT' | 'MAINTAIN_INSTALLMENT';
  currency?: string;
  originationFee?: number;
  product?: string;
  counterpartyId?: string;
}

export interface LoanEvent {
  id: string;
  loanId: string;
  companyId: string;
  date: string;
  kind: 'LUMP' | 'SKIP' | 'RESTRUCTURE' | 'WRITEOFF';
  amount: number | null;
  note: string | null;
  postedBy: string | null;
  postedAt: string;
}

export interface LoanEventInput {
  kind: 'LUMP' | 'SKIP' | 'RESTRUCTURE' | 'WRITEOFF';
  date: string;
  amount?: number;
  note?: string;
}

export interface ListLoansFilter {
  status?: 'active' | 'closed' | 'written_off';
  product?: string;
}
