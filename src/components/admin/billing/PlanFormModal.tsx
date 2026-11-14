/**
 * Add / Edit Plan dialog for the admin Plans page. A real dialog (audit 4.13: Escape, Tab trap, aria-modal,
 * labelled inputs). On edit the Code is read-only (the API never changes it) and the form says plainly that a
 * price change reprices every subscriber (audit 4.17); the page asks for a confirm before it saves one.
 */

import { useRef } from 'react';
import { AlertCircle, Check, Loader2, X } from 'lucide-react';
import { useFocusTrap } from '@/components/ui/useFocusTrap';

export interface PlanForm {
  code: string;
  name: string;
  description: string;
  monthly_price: string;
  annual_price: string;
  users_limit: string;
  features: string;
  limits: string;
}

export const EMPTY_PLAN_FORM: PlanForm = {
  code: '', name: '', description: '',
  monthly_price: '', annual_price: '',
  users_limit: '', features: '{}', limits: '{}',
};

interface Props {
  open: boolean;
  editing: boolean;
  /** False while a dialog over this one (the reprice confirm) owns the keyboard. */
  trapFocus: boolean;
  form: PlanForm;
  setForm: (update: (f: PlanForm) => PlanForm) => void;
  error: string;
  saving: boolean;
  onSave: () => void;
  onClose: () => void;
}

const INPUT = 'w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-teal-500 read-only:opacity-60';

export function PlanFormModal({ open, editing, trapFocus, form, setForm, error, saving, onSave, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, open && trapFocus, onClose);
  if (!open) return null;

  function field(key: keyof PlanForm, label: string, opts?: { type?: string; rows?: number; readOnly?: boolean }) {
    const id = `plan-field-${key}`;
    const onChange = (value: string) => setForm(f => ({ ...f, [key]: value }));
    return (
      <div>
        <label htmlFor={id} className="block text-xs font-medium text-ink-muted mb-1">{label}</label>
        {opts?.rows
          ? <textarea id={id} rows={opts.rows} value={form[key]} onChange={e => onChange(e.target.value)} className={INPUT} />
          : <input id={id} type={opts?.type ?? 'text'} readOnly={opts?.readOnly} value={form[key]} onChange={e => onChange(e.target.value)} className={INPUT} />
        }
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="plan-modal-title"
        className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700">
          <h3 id="plan-modal-title" className="text-sm font-semibold text-gray-900 dark:text-white">{editing ? 'Edit Plan' : 'Add Plan'}</h3>
          <button onClick={onClose} aria-label="Close" className="text-gray-600 dark:text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-4">
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-xs">
              <AlertCircle className="w-4 h-4 flex-shrink-0" /> {error}
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            {field('code', editing ? 'Code (fixed once created)' : 'Code (e.g. starter)', { readOnly: editing })}
            {field('name', 'Name')}
          </div>
          {field('description', 'Description')}
          <div className="grid grid-cols-3 gap-4">
            {field('monthly_price', 'Monthly Price (R)', { type: 'number' })}
            {field('annual_price',  'Annual Price (R)',  { type: 'number' })}
            {field('users_limit',   'Users Limit',       { type: 'number' })}
          </div>
          {editing && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              A price change applies to every subscriber on this plan at once: their next charge uses the new
              price, and MRR changes immediately. Subscriptions do not keep the old price.
            </p>
          )}
          {field('features', 'Features (JSON)', { rows: 4 })}
          {field('limits',   'Limits (JSON)',   { rows: 4 })}
        </div>
        <div className="px-5 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors">Cancel</button>
          <button
            onClick={onSave}
            disabled={saving}
            className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            {editing ? 'Save Changes' : 'Create Plan'}
          </button>
        </div>
      </div>
    </div>
  );
}
