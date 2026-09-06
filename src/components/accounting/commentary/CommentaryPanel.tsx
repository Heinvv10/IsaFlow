/**
 * Container around `CommentaryBlock`: fetches rows for one report pack,
 * wires approve/reject only for an approver, and gates a `replace` generation
 * behind an explicit confirmation so a stray click can never withdraw an
 * approval a person already gave (see `generateDrafts` in
 * `commentaryService.ts` — `replace` is the only path that does that).
 *
 * `canApprove` is a prop, not a lookup: the caller already holds the current
 * user's role (`useCompany().companyRole`) to decide `mode`, so this
 * component stays free of that context and easy to render in isolation —
 * including on the published share/PDF path, which never approves anything.
 */
import { useState } from 'react';
import { CommentaryBlock } from './CommentaryBlock';
import { useCommentary } from './useCommentary';
import type { SharePackParams } from '@/modules/accounting/services/reports/packParamsHash';

const BTN = 'rounded border border-[var(--ff-border-light)] px-2 py-1 text-xs text-[var(--ff-text-secondary)] hover:border-[var(--ff-brand-500)] disabled:cursor-not-allowed disabled:opacity-50';

export interface CommentaryPanelProps {
  sectionRef: string;
  mode: 'internal' | 'published';
  canApprove: boolean;
  params: SharePackParams;
}

export function CommentaryPanel({ sectionRef, mode, canApprove, params }: CommentaryPanelProps) {
  const { rows, error, generate, approve, reject } = useCommentary({ params });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);

  function closeConfirm() {
    setConfirmOpen(false);
    setReplaceConfirmed(false);
  }

  // Deliberately does not close the confirm panel: a second Generate
  // immediately after (e.g. retrying a rate-limited request) should not have
  // to reopen it. The checkbox itself DOES reset, on every completion whether
  // it succeeded or failed — a spent confirmation is spent; a second click on
  // Generate must never resend `replace: true` without a fresh, explicit tick.
  async function handleGenerate() {
    try {
      await generate(replaceConfirmed);
    } finally {
      setReplaceConfirmed(false);
    }
  }

  return (
    <div>
      <CommentaryBlock
        sectionRef={sectionRef}
        rows={rows}
        mode={mode}
        onApprove={canApprove ? approve : undefined}
        onReject={canApprove ? reject : undefined}
      />
      {error && <p className="mt-1 text-xs text-[var(--ff-unfav)]">{error}</p>}
      {mode === 'internal' && (
        <div className="mt-2">
          {!confirmOpen ? (
            <button type="button" onClick={() => setConfirmOpen(true)} className={BTN}>Regenerate</button>
          ) : (
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1 text-xs text-[var(--ff-text-tertiary)]">
                <input
                  type="checkbox"
                  checked={replaceConfirmed}
                  onChange={e => setReplaceConfirmed(e.target.checked)}
                />
                Overwrite approved commentary
              </label>
              <button type="button" onClick={() => void handleGenerate()} className={BTN}>Generate</button>
              <button type="button" onClick={closeConfirm} className={BTN}>Cancel</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
