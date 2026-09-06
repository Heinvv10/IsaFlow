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
import type { Density } from './useDensity';

export const DENSITY_COLUMNS: Record<Density, StatementColumns> = {
  owner: { prior: false, budget: false, variance: false, trend: false },
  accountant: { prior: true, budget: false, variance: true, trend: false },
};

/**
 * The density is PASSED IN rather than read with a second `useDensity()`.
 * That hook owns a fetch and a save; a page that also renders a
 * `DensityToggle` would otherwise hold two independent copies of the same
 * preference — two GETs on mount, and a toggle whose change the seeding copy
 * never sees. One instance per page, threaded through.
 */
export function useComparatorColumns(
  { density, loading }: { density: Density; loading: boolean },
): {
  columns: StatementColumns;
  setColumns: (next: StatementColumns) => void;
} {
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
