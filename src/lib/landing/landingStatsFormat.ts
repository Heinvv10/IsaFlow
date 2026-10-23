/**
 * Landing stats shape and display formatting. Pure — safe in the browser
 * bundle, unlike landingStats.ts, which imports the DB client.
 */

export interface LandingStats {
  transactionAmount: number;   // sum of ABS(amount) from bank_transactions
  businessCount: number;       // non-test companies
  invoiceCount: number;        // customer + supplier invoices
}

export interface StatItem { value: string; label: string }

export function formatRand(amount: number): string {
  if (amount >= 1_000_000_000) return `R ${(amount / 1_000_000_000).toFixed(1)}B+`;
  if (amount >= 1_000_000)     return `R ${(amount / 1_000_000).toFixed(0)}M+`;
  if (amount >= 1_000)         return `R ${(amount / 1_000).toFixed(0)}K+`;
  return `R ${amount.toFixed(0)}`;
}

export function formatCount(n: number): string {
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K+`;
  return `${n}+`;
}

export function buildStats(data: LandingStats): StatItem[] {
  return [
    { value: formatRand(data.transactionAmount), label: 'Transactions Processed' },
    { value: formatCount(data.businessCount),    label: 'Businesses' },
    { value: formatCount(data.invoiceCount),     label: 'Invoices Processed' },
  ];
}
