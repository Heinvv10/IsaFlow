/**
 * Subscriptions: the Add Subscription dialog. The page owns its state and its focus trap (`dialogRef`).
 */
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { AlertCircle, Check, Loader2, X } from 'lucide-react';
import { SubscriptionCompanyPicker } from '@/components/admin/SubscriptionCompanyPicker';
import type { Plan, SubForm } from './subscriptionModel';

interface AddSubscriptionModalProps {
  formRef: RefObject<HTMLDivElement>;
  form: SubForm;
  setForm: Dispatch<SetStateAction<SubForm>>;
  formError: string;
  plans: Plan[];
  saving: boolean;
  setCompanyNamed: (named: boolean) => void;
  onClose: () => void;
  onCreate: () => void;
}

export function AddSubscriptionModal({ formRef, form, setForm, formError, plans, saving, setCompanyNamed, onClose, onCreate }: AddSubscriptionModalProps) {
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="subscription-modal-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div ref={formRef} className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700">
          <h3 id="subscription-modal-title" className="text-sm font-semibold text-gray-900 dark:text-white">Add Subscription</h3>
          <button onClick={onClose} aria-label="Close" className="text-gray-600 dark:text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-4">
          {formError && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-xs">
              <AlertCircle className="w-4 h-4 flex-shrink-0" /> {formError}
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-ink-faint dark:text-gray-400 mb-1">Company</label>
            <SubscriptionCompanyPicker companyId={form.company_id} onChange={id => setForm(f => ({ ...f, company_id: id }))} onNamedChange={setCompanyNamed} />
          </div>
          <div>
            <label htmlFor="sub-plan" className="block text-xs font-medium text-ink-faint dark:text-gray-400 mb-1">Plan</label>
            <select id="sub-plan" value={form.plan_id} onChange={e => setForm(f => ({ ...f, plan_id: e.target.value }))}
              className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500">
              <option value="">Select a plan...</option>
              {plans.map(p => <option key={p.id} value={p.id}>{p.name} ({p.code})</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="sub-cycle" className="block text-xs font-medium text-ink-faint dark:text-gray-400 mb-1">Billing Cycle</label>
              <select id="sub-cycle" value={form.billing_cycle} onChange={e => setForm(f => ({ ...f, billing_cycle: e.target.value }))}
                className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500">
                <option value="monthly">Monthly</option>
                <option value="annual">Annual</option>
              </select>
            </div>
            <div>
              <label htmlFor="sub-discount" className="block text-xs font-medium text-ink-faint dark:text-gray-400 mb-1">Discount %</label>
              <input id="sub-discount" type="number" min="0" max="50" value={form.discount_pct} onChange={e => setForm(f => ({ ...f, discount_pct: e.target.value }))}
                className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500" />
            </div>
          </div>
        </div>
        <div className="px-5 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors">Cancel</button>
          <button onClick={onCreate} disabled={saving}
            className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Create
          </button>
        </div>
      </div>
    </div>
  );
}
