/** The pieces the supplier and customer forms (and their sections) are built from. */
import React, { useId } from 'react';
import type { DateGate } from '@/hooks/useDateGate';

export const inputClass =
  'w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] placeholder:text-[var(--ff-text-tertiary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500';
export const textareaClass = `${inputClass} resize-none`;
export const selectClass = `${inputClass} cursor-pointer`;

/** `create` shows the opening balance; `edit` does not (it is set once, and corrected with a journal). */
export type FormMode = 'create' | 'edit';

/** What every section of a contact form is given. */
export interface SectionProps<F> {
  form: F;
  set: <K extends keyof F>(key: K, value: F[K]) => void;
  patch: (changes: Partial<F>) => void;
  fieldErrors: Partial<Record<keyof F, string>>;
  mode: FormMode;
  dates: DateGate;
}

export function Field({ label, required, children, hint, error, htmlFor }: {
  label: string; required?: boolean; children: React.ReactNode; hint?: string; error?: string; htmlFor?: string;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">
        {label}
        {required && <span className="text-red-400 ml-1">*</span>}
      </label>
      {children}
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
      {hint && !error && <p className="mt-1 text-xs text-[var(--ff-text-tertiary)]">{hint}</p>}
    </div>
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-sm font-semibold text-[var(--ff-text-primary)] uppercase tracking-wide mb-4">
      {children}
    </h2>
  );
}

export function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-6 mb-6">
      {children}
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <div className="flex items-center gap-3">
      <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${checked ? 'bg-brand-600' : 'bg-[var(--ff-bg-tertiary)]'}`}>
        <span className={`inline-block h-4 w-4 rounded-full bg-white shadow ring-0 transition-transform ${checked ? 'translate-x-4' : 'translate-x-0'}`} />
      </button>
      <span className="text-sm text-[var(--ff-text-secondary)]">{label}</span>
    </div>
  );
}

interface FieldBase { label: string; hint?: string; error?: string; required?: boolean }

/** A labelled text-like input: the label names the input (same id), so the form needs no raw, unlabelled <input>. */
export function TextField({ label, hint, error, required, value, onChange, ...input }: FieldBase & {
  value: string; onChange: (v: string) => void;
  type?: 'text' | 'email' | 'tel' | 'url' | 'number'; placeholder?: string; autoFocus?: boolean;
  inputMode?: 'tel'; min?: string; max?: string; step?: string;
}) {
  const id = useId();
  return (
    <Field label={label} hint={hint} error={error} required={required} htmlFor={id}>
      <input id={id} value={value} onChange={(e) => onChange(e.target.value)} className={inputClass} {...input} />
    </Field>
  );
}

export function TextAreaField({ label, hint, error, value, onChange, rows = 3, placeholder }: FieldBase & {
  value: string; onChange: (v: string) => void; rows?: number; placeholder?: string;
}) {
  const id = useId();
  return (
    <Field label={label} hint={hint} error={error} htmlFor={id}>
      <textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} rows={rows} placeholder={placeholder} className={textareaClass} />
    </Field>
  );
}

export function SelectField({ label, hint, error, value, onChange, children }: FieldBase & {
  value: string; onChange: (v: string) => void; children: React.ReactNode;
}) {
  const id = useId();
  return (
    <Field label={label} hint={hint} error={error} htmlFor={id}>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={selectClass}>{children}</select>
    </Field>
  );
}
