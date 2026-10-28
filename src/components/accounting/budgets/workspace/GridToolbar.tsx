/**
 * The grid toolbar (spec §4.4, §11): view (Company / By CC1 / By CC2 / By BU) and, in a dimension
 * view, the member picker showing each member's FY net profit so the user sees where the money
 * sits; rounding unit for spreads (R1 / R100 / R1 000, decision 5); reading density
 * (`useDensity` + `DensityToggle`); the PY / Δ columns toggle; Excel template download and import.
 * Renders and calls back; the view itself is resolved by `useBudgetGrid` (pivot.ts).
 */
import { Download, Upload } from 'lucide-react';
import { DensityToggle } from '@/components/accounting/reportControls/DensityToggle';
import type { Density } from '@/components/accounting/reportControls/useDensity';
import { formatStatementFigure } from '@/lib/format/money';
import type { RoundingUnit } from '@/modules/accounting/services/budgets/grid/cents';
import type { Dimension } from '@/modules/accounting/services/budgets/grid/cellKey';
import type { View } from '@/modules/accounting/services/budgets/grid/pivot';
import type { GridDimensions } from '@/modules/accounting/services/budgets/gridReadTypes';
import type { MemberTotal } from './useBudgetGrid';

export interface GridToolbarProps {
  view: View;
  /** The model's members per dimension (a dimension with none is not offered). */
  dimensions: GridDimensions;
  /** Members of the current dimension view, with their FY net profit; [] in Company view. */
  members: readonly MemberTotal[];
  onViewChange: (view: View) => void;
  roundingUnit: RoundingUnit;
  onRoundingUnitChange: (unit: RoundingUnit) => void;
  density: Density;
  onDensityChange: (d: Density) => void;
  /** The PY and Δ vs PY columns (BudgetGrid shows both or neither). */
  showPy: boolean;
  onShowPyChange: (on: boolean) => void;
  onDownloadTemplate: () => void;
  /** Null hides Import (read-only version or role). */
  onImport: (() => void) | null;
  disabled: boolean;
}

const VIEW_LABEL: Record<View['kind'], string> = { company: 'Company', cc1: 'By CC1', cc2: 'By CC2', bu: 'By BU' };
const DIMENSIONS: readonly Dimension[] = ['cc1', 'cc2', 'bu'];
const UNIT_LABEL: Record<RoundingUnit, string> = { 1: 'R1', 100: 'R100', 1000: 'R1 000' };
const UNITS: readonly RoundingUnit[] = [1, 100, 1000];

const SELECT = 'min-w-0 max-w-full rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)] px-2 py-1.5 text-sm text-[var(--ff-text-primary)]';
const BTN = 'inline-flex items-center gap-1.5 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)] px-3 py-1.5 text-sm text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-hover)] disabled:opacity-50';

/** 'CC-A Alpha · R 1 234' — the member picker's option text (NP in rand, statement style). */
export const memberOptionLabel = (m: MemberTotal): string =>
  `${m.code} ${m.name} · NP ${formatStatementFigure(m.total / 100)}`;

function Toggle({ label, on, onChange, disabled }: { label: string; on: boolean; onChange: (on: boolean) => void; disabled: boolean }) {
  return (
    <button type="button" aria-pressed={on} disabled={disabled} onClick={() => onChange(!on)}
      className={`rounded px-2.5 py-1 text-xs ${on ? 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-primary)]' : 'text-[var(--ff-text-secondary)]'} disabled:opacity-50`}>
      {label}
    </button>
  );
}

export function GridToolbar(p: GridToolbarProps) {
  const available = DIMENSIONS.filter((d) => p.dimensions[d].length > 0);
  const changeKind = (kind: View['kind']) => {
    if (kind === 'company') { p.onViewChange({ kind: 'company' }); return; }
    const first = p.dimensions[kind][0];
    if (first) p.onViewChange({ kind, memberId: first.id });
  };
  return (
    <div data-testid="grid-toolbar" className="flex flex-wrap items-center gap-2">
      <select aria-label="View" value={p.view.kind} disabled={p.disabled} className={SELECT} data-testid="toolbar-view"
        onChange={(e) => changeKind(e.target.value as View['kind'])}>
        <option value="company">{VIEW_LABEL.company}</option>
        {available.map((d) => <option key={d} value={d}>{VIEW_LABEL[d]}</option>)}
      </select>
      {p.view.kind !== 'company' && (
        <select aria-label="Member" value={p.view.memberId} disabled={p.disabled} className={SELECT} data-testid="toolbar-member"
          onChange={(e) => { if (p.view.kind !== 'company') p.onViewChange({ kind: p.view.kind, memberId: e.target.value }); }}>
          {p.members.map((m) => <option key={m.id} value={m.id}>{memberOptionLabel(m)}</option>)}
        </select>
      )}
      <select aria-label="Rounding unit" value={p.roundingUnit} disabled={p.disabled} className={SELECT}
        onChange={(e) => p.onRoundingUnitChange(Number(e.target.value) as RoundingUnit)} title="Spreads round to this unit; the last month takes the remainder">
        {UNITS.map((u) => <option key={u} value={u}>Round to {UNIT_LABEL[u]}</option>)}
      </select>
      <DensityToggle density={p.density} onChange={p.onDensityChange} />
      <div className="inline-flex rounded-md border border-[var(--ff-border-light)] p-0.5" role="group" aria-label="Columns">
        <Toggle label="PY and Δ" on={p.showPy} onChange={p.onShowPyChange} disabled={p.disabled} />
      </div>
      <div className="ml-auto flex items-center gap-2">
        <button type="button" className={BTN} disabled={p.disabled} onClick={p.onDownloadTemplate}>
          <Download className="h-4 w-4" aria-hidden="true" />Template
        </button>
        {p.onImport && (
          <button type="button" className={BTN} disabled={p.disabled} onClick={p.onImport}>
            <Upload className="h-4 w-4" aria-hidden="true" />Import
          </button>
        )}
      </div>
    </div>
  );
}
