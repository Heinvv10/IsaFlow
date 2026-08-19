/**
 * One labelled input on the public auth forms: label, optional leading icon,
 * and the shared input styling. Extracted so SignupForm stays under the
 * 300-line limit and every field renders identically.
 */

import type { LucideIcon } from 'lucide-react';
import { AUTH_ICON_CLASS, AUTH_INPUT_CLASS, AUTH_LABEL_CLASS } from './authCardStyles';

interface AuthFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  type?: 'text' | 'email' | 'password';
  autoComplete?: string;
  inputMode?: 'text' | 'numeric';
  placeholder?: string;
  icon?: LucideIcon;
  /** Helper text under the field. */
  hint?: string;
}

export function AuthField({
  id, label, value, onChange, disabled, required, type = 'text',
  autoComplete, inputMode, placeholder, icon: Icon, hint,
}: AuthFieldProps) {
  return (
    <div className="mb-4">
      <label htmlFor={id} className={AUTH_LABEL_CLASS}>
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      <div className="relative">
        {Icon && <Icon className={AUTH_ICON_CLASS} />}
        <input
          id={id}
          type={type}
          autoComplete={autoComplete}
          inputMode={inputMode}
          required={required}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className={Icon ? AUTH_INPUT_CLASS : AUTH_INPUT_CLASS.replace('px-10', 'px-3.5')}
          placeholder={placeholder}
        />
      </div>
      {hint && <p className="mt-1.5 text-xs leading-5 text-slate-500">{hint}</p>}
    </div>
  );
}
