/**
 * Shared types for the Loan Amortisation module.
 */

export interface Loan {
  id: string;
  companyId: string;
  curveId: string | null;
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
  dayCount: string;
  repriceMode: string;
  skipMode: string;
  lumpMode: string;
  recurringSkipMonths: number[];
  status: 'active' | 'closed' | 'written_off';
  ncaCompliant: boolean;
  currency: string;
  createdAt: string;
}

export interface ScheduleRow {
  period: number;
  date: string;
  opening: number;
  rate: number;
  installment: number;
  interest: number;
  principal: number;
  skip: boolean;
  payment: number;
  lump: number;
  closing: number;
  stLiability: number;
  extrapolated: boolean;
  nca_flagged: boolean;
}

export interface LoanEvent {
  id: string;
  loanId: string;
  date: string;
  kind: string;
  amount: number | null;
  note: string | null;
}

export interface PortfolioSummary {
  totalLoans: number;
  totalOutstanding: number;
  weightedAvgRate: number;
  next12mInterest: number;
  totalCurrentPortion: number;
  activeCount: number;
  closedCount: number;
}

export interface RateCurve {
  id: string;
  name: string;
  pointCount?: number;
}

export interface RatePoint {
  id?: string;
  curveId?: string;
  effectiveDate: string;
  rate: number;
}

export const PRODUCT_LABELS: Record<string, string> = {
  bond: 'Bond',
  vehicle_finance: 'Vehicle Finance',
  shareholder_loan: 'Shareholder Loan',
  inter_company: 'Inter-Company',
  other: 'Other',
};

export const STATUS_COLOURS: Record<string, string> = {
  active: 'bg-teal-500/10 text-teal-400',
  closed: 'bg-gray-500/10 text-gray-400',
  written_off: 'bg-red-500/10 text-red-400',
};

export const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

export const fmtPct = (n: number) => `${Number(n).toFixed(4)}%`;

export const fmtDate = (d: string) => {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-ZA', { year: 'numeric', month: 'short', day: '2-digit' });
};
