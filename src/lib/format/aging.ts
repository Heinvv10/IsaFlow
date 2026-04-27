/**
 * formatOverdueDays — display-layer cap for aging day counts.
 *
 * The DB may return very large values when demo data is seeded with
 * forward-dated invoices. Raw "${days}d overdue" labels like "2268d overdue"
 * destroy accountant trust. This function normalises the label.
 *
 * Rules:
 *   days < 0  (not yet due / current)  → ""
 *   days === 0                          → "Due today"
 *   1 ≤ days ≤ 365                     → "${days}d overdue"
 *   days > 365                         → ">365d overdue"
 *   NaN / non-finite / non-numeric     → ""
 */
export function formatOverdueDays(days: number): string {
  if (typeof days !== 'number' || !Number.isFinite(days) || Number.isNaN(days)) {
    return '';
  }

  const d = Math.trunc(days);

  if (d < 0) return '';
  if (d === 0) return 'Due today';
  if (d <= 365) return `${d}d overdue`;
  return '>365d overdue';
}
