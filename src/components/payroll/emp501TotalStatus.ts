/**
 * The EMP501 reconciliation's Total-row status (pages/payroll/emp501). A year whose whole variance is PSP PAYE (on the
 * EMP201, on no natural-person certificate until PSP-H) reads 'explained_psp', as its rows do: the rows' unexplained
 * variance is nil in every month and their PSP PAYE is above nil (review of #1566, coordinator ruling). The per-row PSP figures reach
 * payroll-detail roles only, so a viewer's Total stays 'variance'.
 */
export interface Emp501TotalRow { variance: number; pspPaye?: number; unexplainedVariance?: number }

export function emp501TotalStatus(rows: readonly Emp501TotalRow[], totalVariance: number): 'balanced' | 'explained_psp' | 'variance' {
  if (Math.abs(totalVariance) < 0.01) return 'balanced';
  const psp = rows.reduce((t, r) => t + (r.pspPaye ?? 0), 0);
  // Every month on its own, never the sum: +x in one month and -x in another must not read as explained (final delta L1).
  const everyMonthExplained = rows.every((r) => Math.abs(r.unexplainedVariance ?? 0) < 0.01);
  return psp > 0 && everyMonthExplained ? 'explained_psp' : 'variance';
}

/** "All periods reconcile" holds only when no month has any variance, PSP-explained or not. */
export function emp501AllReconciled(rows: ReadonlyArray<{ status: string }>): boolean {
  return rows.every((r) => r.status === 'balanced' || r.status === 'no_data') && rows.some((r) => r.status === 'balanced');
}
