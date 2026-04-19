export interface LoanInputs {
  id: string;
  principal: number;
  startDate: string; // ISO date (YYYY-MM-DD)
  termMonths: number;
  rateMode: 'FIXED' | 'PRIME_PLUS' | 'PRIME_MINUS';
  margin: number; // e.g. 4.0 for Prime+4%
  fixedRate?: number; // used when rateMode='FIXED'
  residual: number; // balloon payment (0 if none)
  recurringSkipMonths: number[]; // [12, 1] = skip Dec and Jan every year (calendar months)
  dayCount: 'ACTUAL_365' | 'ACTUAL_360' | '30_360';
  repriceMode: 'RESOLVE_ON_RATE_CHANGE' | 'RESOLVE_EVERY_PERIOD' | 'FIXED_INSTALLMENT';
  skipMode: 'EXTEND_TERM' | 'MAINTAIN_TERM';
  lumpMode: 'REDUCE_INSTALLMENT' | 'MAINTAIN_INSTALLMENT';
}

export interface LoanEvent {
  kind: 'LUMP' | 'SKIP' | 'RESTRUCTURE' | 'WRITEOFF';
  date: string; // ISO date
  amount?: number;
  note?: string;
}

export interface RatePoint {
  effectiveDate: string; // ISO date
  rate: number; // annual percentage, e.g. 9.75 for 9.75%
}

export interface ScheduleRow {
  period: number;
  date: string;
  opening: number;
  rate: number; // effective annual rate for this period
  installment: number;
  interest: number;
  principal: number; // principal portion of payment (payment - interest)
  intPortion: number; // same as interest (for compatibility)
  skip: boolean;
  payment: number; // 0 on skip months
  lump: number; // lump sum applied this period
  closing: number;
  stLiability: number; // current portion: Σ(payment+lump-interest) for next 12 months
  extrapolated: boolean;
  nca_flagged: boolean;
}
