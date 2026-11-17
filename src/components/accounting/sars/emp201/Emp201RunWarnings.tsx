/**
 * The runs the EMP201 leaves out or cannot reconcile, by name (wave 6 EF, `EMP201Data.runWarnings`): an approved/paid
 * run with no approval time (not final, so not declared) and a run whose lines' UIF split differs from its header.
 * Nothing renders when there is none (or an older API omits the field).
 */
import type { EMP201Data } from './emp201Types';

export function Emp201RunWarnings({ data }: { data: EMP201Data }) {
  const warnings = data.runWarnings ?? [];
  if (warnings.length === 0) return null;
  return (
    <div data-testid="emp201-run-warnings" className="border-b border-[var(--ff-border-light)]">
      {warnings.map((w) => (
        <p key={w} role="note" className="px-4 py-2 text-xs text-amber-700 dark:text-amber-400">{w}</p>
      ))}
    </div>
  );
}
