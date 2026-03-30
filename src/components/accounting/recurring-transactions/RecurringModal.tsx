/**
 * RecurringModal — add/edit recurring transaction template
 */

import { Loader2, AlertCircle } from 'lucide-react';
import type { TemplateInput } from '@/modules/accounting/services/recurringTransactionService';

const INPUT_CLS = 'w-full px-3 py-2 text-sm bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] rounded-lg text-[var(--ff-text-primary)] placeholder-[var(--ff-text-secondary)] focus:outline-none focus:ring-2 focus:ring-teal-500/30';
const BTN_PRIMARY = 'inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors text-sm font-medium';
const BTN_GHOST = 'inline-flex items-center gap-2 px-3 py-1.5 text-sm text-[var(--ff-text-secondary)] border border-[var(--ff-border-light)] rounded-lg hover:bg-[var(--ff-bg-primary)] transition-colors';

export type EntityType = 'journal_entry' | 'customer_invoice' | 'supplier_invoice';
export type Frequency = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'annually';

export interface TemplateFormState {
  name: string;
  entityType: EntityType;
  frequency: Frequency;
  nextRunDate: string;
  isActive: boolean;
  autoPost: boolean;
  templateData: string;
}

export const ENTITY_LABELS: Record<EntityType, string> = {
  journal_entry: 'Journal Entry',
  customer_invoice: 'Customer Invoice',
  supplier_invoice: 'Supplier Invoice',
};

export const FREQ_LABELS: Record<Frequency, string> = {
  daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly',
  quarterly: 'Quarterly', annually: 'Annually',
};

interface Props {
  form: TemplateFormState;
  isEdit: boolean;
  saving: boolean;
  formError: string | null;
  onChange: (updates: Partial<TemplateFormState>) => void;
  onSave: () => void;
  onClose: () => void;
}

export function RecurringModal({ form, isEdit, saving, formError, onChange, onSave, onClose }: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-[var(--ff-border-light)] flex items-center justify-between">
          <h2 className="text-base font-semibold text-[var(--ff-text-primary)]">
            {isEdit ? 'Edit Template' : 'New Recurring Template'}
          </h2>
          <button onClick={onClose} className="text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors text-xl leading-none">&times;</button>
        </div>
        <div className="px-6 py-5 space-y-4">
          {formError && (
            <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
              <AlertCircle className="h-4 w-4 flex-shrink-0" /> {formError}
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Name</label>
              <input className={INPUT_CLS} placeholder="e.g. Monthly Rent Expense" value={form.name}
                onChange={e => onChange({ name: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Entity Type</label>
              <select className={INPUT_CLS} value={form.entityType}
                onChange={e => onChange({ entityType: e.target.value as EntityType })}>
                {(Object.keys(ENTITY_LABELS) as EntityType[]).map(k => (
                  <option key={k} value={k}>{ENTITY_LABELS[k]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Frequency</label>
              <select className={INPUT_CLS} value={form.frequency}
                onChange={e => onChange({ frequency: e.target.value as Frequency })}>
                {(Object.keys(FREQ_LABELS) as Frequency[]).map(k => (
                  <option key={k} value={k}>{FREQ_LABELS[k]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Next Run Date</label>
              <input type="date" className={INPUT_CLS} value={form.nextRunDate}
                onChange={e => onChange({ nextRunDate: e.target.value })} />
            </div>
            <div className="flex items-center gap-6 pt-5">
              <label className="flex items-center gap-2 text-sm text-[var(--ff-text-primary)] cursor-pointer">
                <input type="checkbox" checked={form.isActive}
                  onChange={e => onChange({ isActive: e.target.checked })} className="accent-teal-500" />
                Active
              </label>
              <label className="flex items-center gap-2 text-sm text-[var(--ff-text-primary)] cursor-pointer">
                <input type="checkbox" checked={form.autoPost}
                  onChange={e => onChange({ autoPost: e.target.checked })} className="accent-teal-500" />
                Auto-post
              </label>
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Template Data (JSON)</label>
              <textarea
                className={`${INPUT_CLS} font-mono min-h-[120px] resize-y`}
                placeholder='{"lines": [], "description": "..."}'
                value={form.templateData}
                onChange={e => onChange({ templateData: e.target.value })}
              />
              <p className="text-xs text-[var(--ff-text-secondary)] mt-1">
                For journal entries: include <code className="font-mono">lines</code> array.
                For invoices: include <code className="font-mono">clientId</code>/<code className="font-mono">supplierId</code>, <code className="font-mono">lines</code>, amounts.
              </p>
            </div>
          </div>
        </div>
        <div className="px-6 py-4 border-t border-[var(--ff-border-light)] flex gap-2">
          <button onClick={onSave} disabled={saving} className={BTN_PRIMARY}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {saving ? 'Saving...' : 'Save Template'}
          </button>
          <button onClick={onClose} className={BTN_GHOST}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

export function buildTemplateInput(form: TemplateFormState): Partial<TemplateInput> & { id?: string } {
  const parsedData = JSON.parse(form.templateData || '{}') as Record<string, unknown>;
  return {
    name: form.name,
    entityType: form.entityType,
    frequency: form.frequency,
    nextRunDate: form.nextRunDate || null,
    isActive: form.isActive,
    autoPost: form.autoPost,
    templateData: parsedData,
  };
}
