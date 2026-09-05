/**
 * The comparator checkbox state for a statement page, seeded from the reading
 * density. Owner opens with a clean statement; accountant opens with prior +
 * variance, which is what an accountant reaches for first.
 *
 * The seed is applied ONCE the density has resolved, and never after the user
 * has touched a checkbox — the density preference arrives from the server on
 * a later tick, and re-seeding then would silently undo a column the user had
 * already switched on.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { StatementColumns } from '@/modules/accounting/services/reports/statementRows/statementModel';
import { useDensity, type Density } from './useDensity';

export const DENSITY_COLUMNS: Record<Density, StatementColumns> = {
  owner: { prior: false, budget: false, variance: false, trend: false },
  accountant: { prior: true, budget: false, variance: true, trend: false },
};

export function useComparatorColumns(): {
  columns: StatementColumns;
  setColumns: (next: StatementColumns) => void;
} {
  const { density, loading } = useDensity();
  const [columns, setState] = useState<StatementColumns>(DENSITY_COLUMNS.owner);
  const touched = useRef(false);

  useEffect(() => {
    if (loading || touched.current) return;
    setState(DENSITY_COLUMNS[density]);
  }, [density, loading]);

  const setColumns = useCallback((next: StatementColumns) => {
    touched.current = true;
    setState(next);
  }, []);

  return { columns, setColumns };
}
