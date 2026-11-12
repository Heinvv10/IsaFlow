/** The EMP201 form card: one file per field section (wave 5 L2 split; L3u adds drill links in the sections). */
import { useState } from 'react';
import { formatDate } from '@/utils/formatters';
import type { DrillOpener, EMP201Data } from './emp201Types';
import { Emp201DrillDrawer } from '../drill/Emp201DrillDrawer';
import { MAX_DRILL_WINDOW_DAYS, windowTooLong } from '../drill/returnDrillClient';
import { Emp201EmployeeSection } from './Emp201EmployeeSection';
import { Emp201PayeSection } from './Emp201PayeSection';
import { Emp201EtiSection } from './Emp201EtiSection';
import { Emp201UifSdlSection } from './Emp201UifSdlSection';
import { Emp201TotalSection } from './Emp201TotalSection';

/** `etiMonth` (YYYY-MM) when the EMP201 covers one month: the ETI section offers "Book ETI for this month". */
/** `canDrill`: the viewer's role may read payroll detail (the drill route refuses the rest). */
export function Emp201ReturnForm({ data, etiMonth = null, onEtiBooked, canDrill = false }: { data: EMP201Data; etiMonth?: string | null; onEtiBooked?: () => void; canDrill?: boolean }) {
  const [drillField, setDrillField] = useState<string | null>(null);
  const tooLong = windowTooLong(data.periodStart, data.periodEnd);
  const onDrill: DrillOpener | undefined = canDrill && !tooLong ? (field, amount) => (amount !== 0 ? () => setDrillField(field) : undefined) : undefined;
  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)]">
      <div className="px-4 py-3 border-b border-[var(--ff-border-light)]">
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">
          EMP201 — {formatDate(data.periodStart)} to {formatDate(data.periodEnd)}
        </h2>
      </div>

      <div className="divide-y divide-[var(--ff-border-light)]">
        <Emp201EmployeeSection data={data} onDrill={onDrill} />
        <Emp201PayeSection data={data} onDrill={onDrill} />
        <Emp201EtiSection data={data} month={etiMonth} onBooked={onEtiBooked} onDrill={onDrill} />
        <Emp201UifSdlSection data={data} onDrill={onDrill} />
        <Emp201TotalSection data={data} />
      </div>
      {canDrill && tooLong && (
        <p className="px-4 py-2 text-xs text-[var(--ff-text-secondary)]" data-testid="emp201-drill-window-note">
          Lines are available for periods up to {MAX_DRILL_WINDOW_DAYS} days; narrow the period.
        </p>
      )}
      <Emp201DrillDrawer field={drillField} from={data.periodStart} to={data.periodEnd} onClose={() => setDrillField(null)} />
    </div>
  );
}
