/**
 * TableDensityToggle
 *
 * A compact two-button segmented control that switches between
 * 'comfortable' and 'compact' table-row density.
 *
 * Mount: AppLayout header (top-right, next to the theme toggle).
 * Icons: Rows3 = comfortable (fewer, spacious rows)
 *        Rows4 = compact     (more rows per screen)
 */

import { Rows3, Rows4 } from 'lucide-react';
import { useTableDensity, type Density } from '@/contexts/TableDensityContext';

interface SegmentProps {
  label: string;
  value: Density;
  current: Density;
  onClick: () => void;
  children: React.ReactNode;
}

function Segment({ label, value, current, onClick, children }: SegmentProps) {
  const active = value === current;
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={[
        'flex items-center justify-center w-7 h-7 rounded transition-colors',
        active
          ? 'bg-teal-600 text-white dark:bg-teal-500 dark:text-gray-900'
          : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-white/10',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

export function TableDensityToggle() {
  const { density, setDensity } = useTableDensity();

  return (
    <div
      className="flex items-center gap-0.5 rounded-lg border border-slate-200 dark:border-white/10 p-0.5"
      role="group"
      aria-label="Table row density"
    >
      <Segment
        label="Comfortable — standard row height"
        value="comfortable"
        current={density}
        onClick={() => setDensity('comfortable')}
      >
        <Rows3 className="w-3.5 h-3.5" />
      </Segment>
      <Segment
        label="Compact — reduced row height"
        value="compact"
        current={density}
        onClick={() => setDensity('compact')}
      >
        <Rows4 className="w-3.5 h-3.5" />
      </Segment>
    </div>
  );
}
