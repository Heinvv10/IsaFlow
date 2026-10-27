/** Small form pieces shared by the wizard steps: a labelled select and a radio option. */
import type { ReactNode } from 'react';

export const LABEL = 'text-sm font-medium text-[var(--ff-text-secondary)]';
export const SELECT = 'h-9 w-full rounded-md border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] px-2 text-sm text-[var(--ff-text-primary)]';

export function SelectField({ label, value, onChange, children, disabled }: {
  label: string; value: string; onChange: (v: string) => void; children: ReactNode; disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className={LABEL}>{label}</span>
      <select className={SELECT} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>{children}</select>
    </label>
  );
}

export function RadioOption({ name, value, checked, onChange, label, hint }: {
  name: string; value: string; checked: boolean; onChange: (v: string) => void; label: string; hint?: string;
}) {
  const hintId = `${name}-${value}-hint`;
  return (
    <div>
      <label className="flex items-center gap-2 text-sm text-[var(--ff-text-primary)]">
        <input type="radio" name={name} value={value} checked={checked} aria-describedby={hint ? hintId : undefined} onChange={() => onChange(value)} />
        {label}
      </label>
      {hint && <p id={hintId} className="ml-6 text-xs text-[var(--ff-text-tertiary)]">{hint}</p>}
    </div>
  );
}
