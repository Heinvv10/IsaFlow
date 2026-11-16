/**
 * The status cell of a calendar item the company's own filings cover (sars_submissions): how it was
 * filed, the filings, and a manual mark on the same item with its Undo.
 * The kinds and their labels are sarsFilingKind's (one rule with the Filings list).
 */
import { CheckCircle2, Clock, Undo2 } from 'lucide-react';
import { formatDate } from '@/utils/formatters';
import { FILING_KIND_LABEL, type FilingKind } from '@/modules/accounting/services/reports/sarsFilingKind';

export type { FilingKind };
export interface Efiling {
  kind: FilingKind;
  filings: Array<{ reference: string | null; submittedAt: string | null; by: string | null }>;
}

const PILL = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium';

function KindBadge({ kind }: { kind: FilingKind }) {
  if (kind === 'processing') {
    return <span className={`${PILL} bg-amber-500/10 text-amber-400`}><Clock className="h-3 w-3" /> {FILING_KIND_LABEL.processing}</span>;
  }
  return (
    <span className={`${PILL} bg-emerald-500/10 text-emerald-400`}>
      <CheckCircle2 className="h-3 w-3" /> {FILING_KIND_LABEL[kind]}
    </span>
  );
}

/** One filing: "by X · Ref Y · date"; several: "N filings: Ref A; (no ref)" (references in period order). */
function filingsLine(e: Efiling): string {
  if (e.filings.length > 1) {
    const refs = [...new Set(e.filings.map((f) => (f.reference ? `Ref ${f.reference}` : '(no ref)')))];
    return `${e.filings.length} filings: ${refs.join('; ')}`;
  }
  const f = e.filings[0];
  if (!f) return '';
  return [f.by ? `by ${f.by}` : '', f.reference ? `Ref ${f.reference}` : '', f.submittedAt ? formatDate(f.submittedAt) : '']
    .filter(Boolean).join(' · ');
}

interface Props {
  efiling: Efiling;
  /** A manual "Marked filed" on the same item (kept so a wrong mark can still be removed). */
  mark?: { by: string | null } | null;
  /** Shown only to write roles. */
  onUndoMark?: () => void;
  busy?: boolean;
}

export function EfilingStatus({ efiling, mark, onUndoMark, busy = false }: Props) {
  const line = filingsLine(efiling);
  return (
    <>
      <KindBadge kind={efiling.kind} />
      {line && <p className="mt-1 text-xs text-[var(--ff-text-tertiary)]">{line}</p>}
      {mark && (
        <p className="mt-1 text-xs text-[var(--ff-text-tertiary)] flex items-center gap-2">
          <span>{`Also marked filed by ${mark.by || 'a team member'}`}</span>
          {onUndoMark && (
            <button type="button" disabled={busy} onClick={onUndoMark}
              className="inline-flex items-center gap-1 text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] disabled:opacity-50">
              <Undo2 className="h-3 w-3" /> Undo
            </button>
          )}
        </p>
      )}
    </>
  );
}
