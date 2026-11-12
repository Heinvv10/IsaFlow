/** A labelled reason textarea for the return lifecycle dialogs. */
import { forwardRef } from 'react';

const TEXTAREA = 'w-full rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] px-3 py-2 text-sm text-[var(--ff-text-primary)]';

interface Props { id: string; label: string; value: string; onChange: (v: string) => void; hint?: string }

export const ReturnReasonField = forwardRef<HTMLTextAreaElement, Props>(function ReturnReasonField({ id, label, value, onChange, hint }, ref) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-[var(--ff-text-primary)]">{label}</label>
      <textarea ref={ref} id={id} rows={3} value={value} maxLength={2000} onChange={(e) => onChange(e.target.value)} className={TEXTAREA} />
      {hint && <p className="text-xs text-[var(--ff-text-secondary)]">{hint}</p>}
    </div>
  );
});
