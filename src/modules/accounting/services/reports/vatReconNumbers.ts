/** Number helpers shared by the VAT reconciliation reports (split from vatReconciliationService). */

// ── Helpers ─────────────────────────────────────────────────────────────────

export function toNum(v: unknown): number {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

export function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function fmtNum(n: number): string {
  return new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(n));
}
