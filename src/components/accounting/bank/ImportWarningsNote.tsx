import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

/** More messages than this start collapsed. */
const OPEN_UP_TO = 3;

/**
 * The import's own problems for one file — a failed auto-post ("… still
 * unposted"), a transfer-link failure, a parse error — kept in the file's row
 * so a swallowed failure is not read as a clean import. Apart from
 * DroppedPicksList (a cost centre a posting could not apply), and never a
 * "Posted —" notice. A long list collapses behind a toggle, as that one does.
 */
export function ImportWarningsNote({ warnings }: { warnings: readonly string[] }) {
  const [open, setOpen] = useState(warnings.length <= OPEN_UP_TO);
  if (warnings.length === 0) return null;
  const heading = 'Imported with problems';
  return (
    <div className="ml-6 rounded border border-rose-500/30 bg-rose-500/5 px-2 py-1.5 text-xs text-rose-500">
      {warnings.length > OPEN_UP_TO ? (
        <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} className="inline-flex items-center gap-1 font-medium">
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {heading} — {warnings.length} messages
        </button>
      ) : (
        <p className="font-medium">{heading}</p>
      )}
      {open && (
        <ul className="mt-1 space-y-0.5 break-words">
          {warnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}
    </div>
  );
}
