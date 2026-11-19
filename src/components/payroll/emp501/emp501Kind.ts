/** Which EMP501 reconciliation the page shows (wave 6 FQd, review #1622 L-K). */
export type Emp501Kind = 'annual' | 'interim';

/** Interim while the tax year is still running (today on or before its last day, end of February), annual after. */
export function defaultEmp501Kind(taxYear: number, today: Date = new Date()): Emp501Kind {
  const yearEnd = new Date(taxYear, 2, 0, 23, 59, 59); // day 0 of March: the last day of February
  return today <= yearEnd ? 'interim' : 'annual';
}
