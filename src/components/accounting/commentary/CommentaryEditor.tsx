/**
 * Inline editor for approving a draft with the approver's own wording. The
 * textarea starts from the machine draft; Cancel simply unmounts it, so the
 * draft row is exactly as it was.
 *
 * The count is the pack's room on the board pack's page 4, in the page's own
 * wrapper: `commentaryCost`, the SAME function the service costs the pack with,
 * on the trimmed text because that is what is sent and stored. `costWith(text)`
 * is the pack's cost with that text in this row's place, or null for a pack
 * with no fixed page (only a generous character ceiling applies). The server
 * stays the authority; this only saves a round trip. When the screen says over
 * budget, `onRefresh` re-fetches the rows so a peer's withdrawal is picked up
 * without losing the typed text.
 */
import { useEffect, useRef, useState } from 'react';
import {
  MAX_APPROVED_PACK_EMS, MAX_UNBUDGETED_CHARS, approxCharsLeft,
} from '@/modules/accounting/services/commentary/commentaryLimits';

const BTN = 'rounded border border-[var(--ff-border-light)] px-2 py-0.5 text-xs text-[var(--ff-text-secondary)] hover:border-[var(--ff-brand-500)] disabled:cursor-not-allowed disabled:opacity-50';

export interface CommentaryEditorProps {
  initialText: string;
  /** What the pack's approved paragraph costs with this text in this row's
   *  place (`commentaryCost`), or null for a pack with no fixed page. */
  costWith: ((text: string) => number) | null;
  /** Re-fetch the pack's rows (and so re-cost). Offered only while over budget. */
  onRefresh?: () => void | Promise<void>;
  /** Resolves true once the approval was accepted (the parent then closes the
   *  editor); false leaves it open with the typed text. */
  onApprove: (text: string) => Promise<boolean>;
  onCancel: () => void;
}

export function CommentaryEditor({ initialText, costWith, onApprove, onCancel, onRefresh }: CommentaryEditorProps) {
  const [value, setValue] = useState(initialText);
  const [busy, setBusy] = useState(false);
  // A state flag is stale inside one tick, so two fast clicks would both pass
  // it; the ref is what actually keeps the second one out.
  const inFlight = useRef(false);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { box.current?.focus(); }, []);

  const trimmed = value.trim();
  const left = costWith === null ? null : MAX_APPROVED_PACK_EMS - costWith(trimmed);
  // A pack with no fixed page has no room figure, only a generous ceiling.
  const tooLong = costWith === null && trimmed.length > MAX_UNBUDGETED_CHARS;
  const over = (left !== null && left < 0) || tooLong;
  const invalid = trimmed.length === 0 || over;

  async function submit() {
    if (invalid || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    let accepted = false;
    try {
      accepted = await onApprove(trimmed);
    } finally {
      // On success the parent unmounts this editor; only a refusal reopens it.
      if (!accepted) { inFlight.current = false; setBusy(false); }
    }
  }

  return (
    <div className="flex-1 space-y-1">
      <textarea
        ref={box}
        aria-label="Commentary text"
        value={value}
        onChange={e => setValue(e.target.value)}
        rows={3}
        className="w-full rounded border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] p-2 text-sm text-[var(--ff-text-primary)]"
      />
      <div className="flex items-center gap-2">
        {(left !== null || tooLong) && (
          <span role="status" className={`text-xs ${over ? 'text-[var(--ff-unfav)]' : 'text-[var(--ff-text-tertiary)]'}`}>
            {left === null
              ? `over the ${MAX_UNBUDGETED_CHARS}-character limit`
              : over
                ? `over the page limit by about ${Math.max(1, approxCharsLeft(-left))} characters`
                : `about ${approxCharsLeft(left)} characters left`}
          </span>
        )}
        <button type="button" disabled={invalid || busy} onClick={() => void submit()} className={BTN}>
          Approve edited text
        </button>
        {left !== null && over && onRefresh && (
          <button type="button" disabled={busy} onClick={() => void onRefresh()} className={BTN}>Refresh</button>
        )}
        <button type="button" disabled={busy} onClick={onCancel} className={BTN}>Cancel</button>
      </div>
    </div>
  );
}
