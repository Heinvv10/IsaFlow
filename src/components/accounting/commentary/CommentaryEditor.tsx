/**
 * Inline editor for approving a draft with the approver's own wording. The
 * textarea starts from the machine draft; Cancel simply unmounts it, so the
 * draft row is exactly as it was. The count and the disabled button use the
 * same cap the service enforces (`commentaryLimits.ts`), measured on the
 * trimmed text because that is what is stored.
 */
import { useState } from 'react';
import { MAX_APPROVED_TEXT_CHARS } from '@/modules/accounting/services/commentary/commentaryLimits';

const BTN = 'rounded border border-[var(--ff-border-light)] px-2 py-0.5 text-xs text-[var(--ff-text-secondary)] hover:border-[var(--ff-brand-500)] disabled:cursor-not-allowed disabled:opacity-50';

export interface CommentaryEditorProps {
  initialText: string;
  /** Resolves true once the approval was accepted; false leaves the editor open. */
  onApprove: (text: string) => Promise<boolean>;
  onCancel: () => void;
}

export function CommentaryEditor({ initialText, onApprove, onCancel }: CommentaryEditorProps) {
  const [value, setValue] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const length = value.trim().length;
  const over = length > MAX_APPROVED_TEXT_CHARS;
  const invalid = length === 0 || over;

  async function submit() {
    if (invalid || busy) return;
    setBusy(true);
    try {
      await onApprove(value);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex-1 space-y-1">
      <textarea
        aria-label="Commentary text"
        value={value}
        onChange={e => setValue(e.target.value)}
        rows={3}
        className="w-full rounded border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] p-2 text-sm text-[var(--ff-text-primary)]"
      />
      <div className="flex items-center gap-2">
        <span className={`text-xs ${over ? 'text-[var(--ff-unfav)]' : 'text-[var(--ff-text-tertiary)]'}`}>
          {`${length} / ${MAX_APPROVED_TEXT_CHARS}`}
        </span>
        <button type="button" disabled={invalid || busy} onClick={() => void submit()} className={BTN}>
          Approve edited text
        </button>
        <button type="button" disabled={busy} onClick={onCancel} className={BTN}>Cancel</button>
      </div>
    </div>
  );
}
