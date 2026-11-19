/**
 * Suggested pairs: this company's open invoice and the partner's open bill with the same number and total. Nothing is chosen for
 * the person: they tick pairs (or all the unflagged ones), review them, and confirm. A confirmed pairing is a link between two
 * documents; nothing is posted.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { apiErrorMessage, apiJson } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';
import type { PairingCandidate, PairingDirection } from '@/modules/accounting/services/intercompany/pairingTypes';
import { DocCells, DocHeads, TD, TH } from './DocCells';
import { docLabels, sumCents } from './pairingFormat';

interface Props {
  connectionId: string;
  direction: PairingDirection;
  partnerName: string;
  suggestions: PairingCandidate[];
  confirmsBoth: boolean;
  onDone: (message: string) => void;
  onError: (message: string) => void;
}

const FLAG = 'inline-flex items-center rounded-full border px-2 py-0.5 text-xs bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30';

export function PairingSuggestions({ connectionId, direction, partnerName, suggestions, confirmsBoth, onDone, onError }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reviewing, setReviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const { mine: mineLabel, theirs: theirLabel } = docLabels(direction, partnerName);

  // A reload that removes a pair (paired by someone else, paid) must not leave it selected.
  useEffect(() => {
    const live = new Set(suggestions.map((s) => s.mine.id));
    setSelected((cur) => new Set([...cur].filter((id) => live.has(id))));
  }, [suggestions]);
  useEffect(() => { if (reviewing) reviewHeading.current?.focus(); }, [reviewing]);

  const unflagged = useMemo(() => suggestions.filter((s) => !s.ambiguous && !s.openDiffers), [suggestions]);
  const chosen = suggestions.filter((s) => selected.has(s.mine.id));
  const allUnflagged = unflagged.length > 0 && unflagged.every((s) => selected.has(s.mine.id));
  const toggle = (id: string) => setSelected((cur) => { const next = new Set(cur); if (!next.delete(id)) next.add(id); return next; });

  async function confirm() {
    setSaving(true);
    try {
      const res = await apiJson(`/api/accounting/intercompany/connections/${connectionId}/pairing`, {
        method: 'POST',
        body: JSON.stringify({ direction, pairs: chosen.map((s) => ({ mineId: s.mine.id, theirsId: s.theirs.id })) }),
      }, 'Could not record the pairings - try again');
      if (!('created' in res)) throw new Error('unexpected reply');
      setReviewing(false);
      setSelected(new Set());
      onDone(res.active === res.created
        ? `${res.created} pairing${res.created === 1 ? '' : 's'} confirmed on both sides.`
        : `${res.created} pairing${res.created === 1 ? '' : 's'} recorded. ${partnerName} is asked to confirm.`);
    } catch (err) {
      onError(apiErrorMessage(err, 'Could not record the pairings - try again'));
    } finally {
      setSaving(false);
    }
  }

  if (suggestions.length === 0) return null;

  return (
    <section className="bg-[var(--ff-canvas-mid)] border border-[var(--ff-canvas-border)] rounded-xl p-5 space-y-3" aria-labelledby="ic-suggest-h" data-testid="suggestions">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="ic-suggest-h" className="text-base font-semibold text-[var(--ff-text-primary)]">Suggested pairs ({suggestions.length})</h2>
        <span className="text-xs text-ink-muted">Same number and total on both sides.</span>
        {!reviewing && (
          <div className="ml-auto flex gap-2">
            <button type="button" onClick={() => setSelected(new Set(allUnflagged ? [] : unflagged.map((s) => s.mine.id)))} disabled={unflagged.length === 0}
              className="px-3 py-1.5 text-sm rounded-lg border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-tertiary)] disabled:opacity-50">
              {allUnflagged ? 'Clear selection' : 'Select all unflagged'}
            </button>
            <button type="button" onClick={() => setReviewing(true)} disabled={chosen.length === 0}
              className="px-3 py-1.5 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
              Review {chosen.length} selected
            </button>
          </div>
        )}
      </div>

      {reviewing ? (
        <div className="space-y-3" role="group" aria-labelledby="ic-review-h" data-testid="review">
          <h3 id="ic-review-h" ref={reviewHeading} tabIndex={-1} className="text-sm font-semibold text-[var(--ff-text-primary)] outline-none">
            Confirm {chosen.length} pairing{chosen.length === 1 ? '' : 's'} worth {formatCurrency(sumCents(chosen.map((s) => s.mine.total)))}
          </h3>
          <p className="text-sm text-ink-muted">
            {confirmsBoth
              ? `You can write in both companies, so each pairing is confirmed for ${partnerName} as well.`
              : `${partnerName} will see each pairing and has to confirm it before it counts.`}
            {' '}No journal is posted and no balance changes: a pairing only records that the two documents are the same invoice. You can unlink it later.
          </p>
          <ul className="text-sm text-[var(--ff-text-primary)] max-h-48 overflow-auto divide-y divide-[var(--ff-border-light)]">
            {chosen.map((s) => (
              <li key={s.mine.id} className="py-1 flex justify-between gap-3">
                <span>{s.mine.number} to {s.theirs.number}</span><span className="tabular-nums">{formatCurrency(s.mine.total)}</span>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <button type="button" onClick={() => void confirm()} disabled={saving}
              className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-2">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CheckCircle2 className="h-4 w-4" aria-hidden />}
              Confirm pairing
            </button>
            <button type="button" onClick={() => setReviewing(false)} disabled={saving}
              className="px-4 py-2 text-sm rounded-lg border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-tertiary)] disabled:opacity-50">
              Back
            </button>
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left">
            <caption className="sr-only">Suggested pairs of {mineLabel.toLowerCase()} and {theirLabel}</caption>
            <thead>
              <tr className="border-b border-[var(--ff-border-light)]">
                <th scope="col" className={`${TH} w-10`}>
                  <input type="checkbox" checked={allUnflagged} disabled={unflagged.length === 0} aria-label="Select all pairs that are not flagged"
                    onChange={() => setSelected(new Set(allUnflagged ? [] : unflagged.map((s) => s.mine.id)))} />
                </th>
                <DocHeads side={mineLabel} />
                <DocHeads side={theirLabel} />
                <th scope="col" className={TH}>Check</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--ff-border-light)]">
              {suggestions.map((s) => (
                <tr key={s.mine.id} className={selected.has(s.mine.id) ? 'bg-blue-500/5' : undefined}>
                  <td className={TD}>
                    <input type="checkbox" checked={selected.has(s.mine.id)} onChange={() => toggle(s.mine.id)}
                      aria-label={`Pair ${s.mine.number} with ${s.theirs.number}`} />
                  </td>
                  <DocCells doc={s.mine} />
                  <DocCells doc={s.theirs} />
                  <td className={`${TD} space-x-1`}>
                    {s.ambiguous && <span className={FLAG} title="This number appears more than once on a side">Repeated number</span>}
                    {s.openDiffers && <span className={FLAG} title="The open amounts differ: one side may have been part-paid">Open amounts differ</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
