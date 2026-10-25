/**
 * Financial Years Management — shared types
 */
import type { FiscalPeriod } from '@/modules/accounting/types/gl.types';
import { formatDisplayDate } from '@/utils/dateFormat';

/** What a stored financial year adds to its card: its own dates, length and kind. */
export interface FiscalYearInfo {
  startDate: string;
  endDate: string;
  months: number;
  kind: 'normal' | 'transition';
}

export interface FiscalYearGroup {
  info?: FiscalYearInfo;
  year: number;
  label: string;
  periods: FiscalPeriod[];
  status: 'open' | 'closed' | 'mixed';
  lockedCount: number;
  closedCount: number;
}

type StoredYear = FiscalYearInfo & { fiscalYear: number; periods: Array<Omit<FiscalPeriod, 'createdAt' | 'updatedAt'>> };

/** One group per STORED financial year (newest first), so a transition year stays one card. */
export function groupStoredYears(years: StoredYear[]): FiscalYearGroup[] {
  return years.map(y => {
    const group = groupPeriodsIntoYears(
      y.periods.map(p => ({ ...p, createdAt: '', updatedAt: '' })),
    )[0];
    return {
      year: y.fiscalYear,
      label: `FY ${y.fiscalYear}`,
      periods: group?.periods ?? [],
      status: group?.status ?? 'open',
      lockedCount: group?.lockedCount ?? 0,
      closedCount: group?.closedCount ?? 0,
      info: { startDate: y.startDate, endDate: y.endDate, months: y.months, kind: y.kind },
    } satisfies FiscalYearGroup;
  }).sort((a, b) => (b.info?.startDate ?? '').localeCompare(a.info?.startDate ?? ''));
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
  return formatDisplayDate(date);
}
