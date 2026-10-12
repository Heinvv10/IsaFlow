import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { postingWarningFact } from '@/components/accounting/postingWarningsNotice';
import type { DroppedPickLine } from './commitStatement';

/** More lines than this start collapsed. */
const OPEN_UP_TO = 3;

/**
 * Under an imported file: the bank lines whose auto-post could not apply a
 * cost centre — the line posted without it. Persistent (the toast only points
 * here): each line by date, amount and description, so two debit orders for the
 * same amount on one day can be told apart, with every warning it carries.
 */
export function DroppedPicksList({ lines }: { lines: readonly DroppedPickLine[] }) {
  const [open, setOpen] = useState(lines.length <= OPEN_UP_TO);
  if (lines.length === 0) return null;
  const heading = `${lines.length} line${lines.length === 1 ? '' : 's'} posted without ${lines.length === 1 ? 'its' : 'their'} cost centre`;
  const collapsible = lines.length > OPEN_UP_TO;

  return (
    <div className="ml-6 rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-xs text-amber-500">
      {collapsible ? (
        <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
          className="inline-flex items-center gap-1 font-medium">
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {heading}
        </button>
      ) : (
        <p className="font-medium">{heading}</p>
      )}
      {open && (
        <ul className="mt-1 space-y-1 text-[var(--ff-text-primary)]">
          {lines.map((l, i) => (
            <li key={l.txId ?? i}>
              <span className="font-medium">{l.label}</span>
              {l.description ? <span className="text-[var(--ff-text-muted)]"> · {l.description}</span> : null}
              {(l.warnings ?? []).map((w, j) => (
                <div key={j} className="text-amber-500">{postingWarningFact(w)}</div>
              ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
