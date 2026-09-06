/**
 * Two segmented buttons picking the reading density. `aria-pressed` rather
 * than a radio group because these are actions on the current view, and a
 * screen reader must still be able to tell which one is on.
 */
import type { Density } from './useDensity';

const OPTIONS: Array<{ value: Density; label: string }> = [
  { value: 'owner', label: 'Owner' },
  { value: 'accountant', label: 'Accountant' },
];

export function DensityToggle({
  density, onChange,
}: { density: Density; onChange: (d: Density) => void }) {
  return (
    <div className="inline-flex rounded-md border border-[var(--ff-border-light)] p-0.5" role="group" aria-label="Reading density">
      {OPTIONS.map((o) => {
        const active = o.value === density;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            onClick={() => { if (!active) onChange(o.value); }}
            className={`px-3 py-1 text-xs rounded ${active
              ? 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-primary)]'
              : 'text-[var(--ff-text-secondary)]'}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
