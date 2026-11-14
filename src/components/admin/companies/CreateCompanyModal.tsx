/**
 * Add Company dialog for the admin Companies list. A real dialog (audit 4.13): role=dialog + aria-modal,
 * Escape closes, Tab stays inside, every input has a label.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { AlertCircle, Loader2, X } from 'lucide-react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { useFocusTrap } from '@/components/ui/useFocusTrap';

interface CreateForm {
  name: string;
  trading_name: string;
  email: string;
  phone: string;
  plan_id: string;
}

const EMPTY: CreateForm = { name: '', trading_name: '', email: '', phone: '', plan_id: '' };
const INPUT = 'w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500';
const LABEL = 'block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export function CreateCompanyModal({ open, onClose, onCreated }: Props) {
  const [form, setForm]         = useState<CreateForm>(EMPTY);
  const [creating, setCreating] = useState(false);
  const [error, setError]       = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useFocusTrap(ref, open, () => { if (!creating) onClose(); });
  // Closed (Cancel, X, Escape or created) = a fresh form next time.
  useEffect(() => { if (!open) { setForm(EMPTY); setError(''); } }, [open]);

  if (!open) return null;

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) { setError('Name is required'); return; }
    setCreating(true); setError('');
    try {
      const res = await apiFetch('/api/admin/companies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Request': 'true' },
        body: JSON.stringify(form),
      });
      await assertOk(res, 'Could not create the company - try again');
      setForm(EMPTY);
      onCreated();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not create the company - try again'));
    } finally {
      setCreating(false);
    }
  }

  const field = (key: keyof CreateForm, label: string, type = 'text', required = false) => (
    <div>
      <label htmlFor={`${id}-${key}`} className={LABEL}>{label}{required ? ' *' : ''}</label>
      <input id={`${id}-${key}`} type={type} required={required} value={form[key]}
        onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} className={INPUT} />
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}
        className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 id={`${id}-title`} className="text-sm font-semibold text-gray-900 dark:text-white">Add Company</h2>
          <button onClick={onClose} aria-label="Close" className="text-gray-600 dark:text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
            <X className="w-4 h-4" />
          </button>
        </div>
        <form onSubmit={e => void handleCreate(e)} className="p-5 space-y-4">
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
              <AlertCircle className="w-4 h-4 flex-shrink-0" /> {error}
            </div>
          )}
          {field('name', 'Company Name', 'text', true)}
          {field('trading_name', 'Trading Name')}
          <div className="grid grid-cols-2 gap-4">
            {field('email', 'Email', 'email')}
            {field('phone', 'Phone', 'tel')}
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose}
              className="px-4 py-2 text-sm font-medium rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={creating}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 hover:bg-brand-700 text-white transition-colors disabled:opacity-50">
              {creating && <Loader2 className="w-4 h-4 animate-spin" />}
              Create Company
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
