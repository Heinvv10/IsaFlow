/** One SARS source code in a side drawer (admin SARS Codes page). A modal dialog: Escape closes, Tab stays in. */

import { useRef } from 'react';
import { X, BadgeCheck, Ban, ExternalLink } from 'lucide-react';
import { useFocusTrap } from '@/components/ui/useFocusTrap';
import { CATEGORY_LABELS, STATUS_BADGE, type CodeRow } from './sarsCodeTypes';

export function CodeDrawer({ code, onClose, onToggleStatus }: {
  code: CodeRow;
  onClose: () => void;
  onToggleStatus: () => void;
}) {
  const badge = STATUS_BADGE[code.status] ?? STATUS_BADGE.active!;
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true, onClose); // audit 4.13: Escape closes, Tab stays in the drawer
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div ref={ref} role="dialog" aria-modal="true" aria-label={`SARS code ${code.code}`} className="relative w-full max-w-xl h-full overflow-y-auto bg-[var(--ff-surface-primary)] border-l border-[var(--ff-border-primary)] shadow-xl p-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="font-id text-2xl text-[var(--ff-text-primary)]">{code.code}{code.foreign_code ? <span className="text-base text-[var(--ff-text-tertiary)] ml-2">/ {code.foreign_code}</span> : null}</div>
            <div className="text-sm text-[var(--ff-text-secondary)] mt-1">{code.description}</div>
            <div className="flex items-center gap-2 mt-2">
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${badge.bg} ${badge.fg}`}>{badge.label}</span>
              <span className="text-xs text-[var(--ff-text-tertiary)]">Year {code.effective_year} · BRS {code.brs_version ?? '—'}</span>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--ff-bg-tertiary)]"><X className="h-5 w-5 text-[var(--ff-text-secondary)]" /></button>
        </div>

        <div className="space-y-4 text-sm">
          <Field label="Category">{CATEGORY_LABELS[code.category] ?? code.category}</Field>
          {code.code_pair && <Field label="Code pair">{code.code_pair}</Field>}
          {code.applicability_note && <Field label="Applicability">{code.applicability_note}</Field>}
          {code.official_excerpt && (
            <div>
              <div className="text-xs text-[var(--ff-text-tertiary)] mb-1">Official SARS guide excerpt</div>
              <div className="text-xs text-[var(--ff-text-secondary)] whitespace-pre-wrap p-3 rounded bg-[var(--ff-bg-tertiary)] max-h-64 overflow-y-auto">
                {code.official_excerpt}
              </div>
            </div>
          )}
          {code.source_url && (
            <Field label="Source">
              <a href={code.source_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-teal-400 hover:underline break-all">
                {code.source_document ?? code.source_url} <ExternalLink className="h-3 w-3" />
              </a>
            </Field>
          )}
          <Field label="Used by">{code.used_by_companies} compan{code.used_by_companies === 1 ? 'y' : 'ies'}</Field>
        </div>

        <div className="mt-6 pt-4 border-t border-[var(--ff-border-primary)]">
          <button
            onClick={onToggleStatus}
            className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${code.status === 'deprecated' ? 'bg-success-700 hover:bg-success-800 text-white' : 'bg-red-600 hover:bg-red-700 text-white'}`}
          >
            {code.status === 'deprecated' ? <><BadgeCheck className="h-4 w-4" /> Restore to active</> : <><Ban className="h-4 w-4" /> Mark deprecated</>}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-[var(--ff-text-tertiary)] mb-1">{label}</div>
      <div className="text-sm text-[var(--ff-text-primary)]">{children}</div>
    </div>
  );
}
