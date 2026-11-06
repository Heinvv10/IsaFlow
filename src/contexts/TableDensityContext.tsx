/**
 * TableDensityContext
 *
 * Provides a two-mode density setting for data tables:
 *   - 'comfortable' — standard row padding (matches today's layout exactly)
 *   - 'compact'     — reduced row padding (py-1, 4 px top and bottom, on the grid)
 *
 * Usage:
 *   const { density, rowClass, headerClass } = useTableDensity();
 *   <td className={rowClass}>…</td>
 *
 * rowClass / headerClass can be spread onto any <td>/<th> in any table
 * that wants to respect the user's density preference.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type Density = 'comfortable' | 'compact';

interface TableDensityContextType {
  density: Density;
  setDensity: (d: Density) => void;
  /** Padding class for <td> cells */
  rowClass: string;
  /** Padding class for <th> cells */
  headerClass: string;
}

const STORAGE_KEY = 'isaflow.tableDensity';

const DENSITY_CLASSES: Record<Density, { row: string; header: string }> = {
  comfortable: { row: 'px-4 py-3', header: 'px-4 py-3' },
  compact:     { row: 'px-4 py-1', header: 'px-4 py-2' },
};

const TableDensityContext = createContext<TableDensityContextType | undefined>(undefined);

export function TableDensityProvider({ children }: { children: ReactNode }) {
  const [density, setDensityState] = useState<Density>('comfortable');

  // Hydrate from localStorage on mount (client-only).
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY) as Density | null;
    if (saved === 'comfortable' || saved === 'compact') {
      setDensityState(saved);
    }
  }, []);

  // The ONE root switch: styles/globals.css reads html[data-density] and
  // compacts every non-exempt table's cells (exempt: [data-density-exempt], table[role=grid]).
  useEffect(() => {
    document.documentElement.dataset.density = density;
  }, [density]);

  const setDensity = useCallback((next: Density) => {
    setDensityState(next);
    localStorage.setItem(STORAGE_KEY, next);
  }, []);

  const value = useMemo<TableDensityContextType>(() => ({
    density,
    setDensity,
    rowClass: DENSITY_CLASSES[density].row,
    headerClass: DENSITY_CLASSES[density].header,
  }), [density, setDensity]);

  return (
    <TableDensityContext.Provider value={value}>
      {children}
    </TableDensityContext.Provider>
  );
}

export function useTableDensity(): TableDensityContextType {
  const ctx = useContext(TableDensityContext);
  if (!ctx) throw new Error('useTableDensity must be used within TableDensityProvider');
  return ctx;
}
