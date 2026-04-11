/**
 * Financial Years Management — shared types
 */
import type { FiscalPeriod } from '@/modules/accounting/types/gl.types';

export interface FiscalYearGroup {
  year: number;
  label: string;
  periods: FiscalPeriod[];
  status: 'open' | 'closed' | 'mixed';
  lockedCount: number;
  closedCount: number;
}

export function groupPeriodsIntoYears(periods: FiscalPeriod[]): FiscalYearGroup[] {
  const map = new Map<number, FiscalPeriod[]>();
  for (const p of periods) {
    const list = map.get(p.fiscalYear) ?? [];
    list.push(p);
    map.set(p.fiscalYear, list);
  }

  const years: FiscalYearGroup[] = [];
  for (const [year, ps] of Array.from(map.entries()).sort((a, b) => b[0] - a[0])) {
    const lockedCount = ps.filter(p => p.status === 'locked').length;
    const closedCount = ps.filter(p => p.status === 'closed').length;
    const openCount = ps.filter(p => p.status === 'open').length;

    let status: FiscalYearGroup['status'];
    if (openCount === 0) status = 'closed';
    else if (openCount === ps.length) status = 'open';
    else status = 'mixed';

    years.push({
      year,
      label: `FY ${year}`,
      periods: ps.sort((a, b) => a.periodNumber - b.periodNumber),
      status,
      lockedCount,
      closedCount,
    });
  }
  return years;
}

export function formatDate(d: string | Date): string {
  const date = d instanceof Date ? d : new Date(d);
  return date.toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' });
}
