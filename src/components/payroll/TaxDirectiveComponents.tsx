/**
 * Tax Directive sub-components — Create Modal (the Lump Sum Calculator is in LumpSumCalculator.tsx)
 * Used by /payroll/tax-directives page.
 */

import { useState } from 'react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { X, Loader2, Plus } from 'lucide-react';
import { DateField } from '@/components/ui/DateField';
import type { FieldValidity } from '@/components/ui/useParsedField';
import { DirectiveEmployeeSelect, useDirectiveEmployees } from './TaxDirectiveEmployeeSelect';
import { Select } from '@/components/ui/Select';
import { DIRECTIVE_TYPES, isRegularPayDirectiveType } from '@/modules/accounting/services/payroll/taxDirectiveKinds';
import { TYPE_LABELS, type DirectiveType } from './taxDirectiveLabels';

export { LumpSumCalculator } from './LumpSumCalculator';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TYPE_OPTIONS = DIRECTIVE_TYPES.map(t => ({ value: t, label: TYPE_LABELS[t] }));

const inputCls = 'w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-400 focus:outline-none focus:border-teal-500';
const labelCls = 'block text-xs font-medium text-gray-400 mb-1';

// ─── Create Modal ─────────────────────────────────────────────────────────────

interface CreateModalProps {
  onClose: () => void;
  onCreated: () => void;
}

export function CreateTaxDirectiveModal({ onClose, onCreated }: CreateModalProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const { employees, loading: employeesLoading, error: employeesError, reload: reloadEmployees } = useDirectiveEmployees();
  const [form, setForm] = useState({
    employee_id: '',
    directive_number: '',
    directive_type: 'retirement' as DirectiveType,
    amount: '',
    tax_rate: '',
    tax_amount: '',
    effective_date: '',
    issued_date: '',
    expiry_date: '',
    sars_reference: '',
    notes: '',
  });

  // A refused date arrives as null (valid=false). Saving it as "no date" would drop a date the user typed, so it blocks save.
  const [refused, setRefused] = useState<Record<string, boolean>>({});
  const setDate = (k: 'effective_date' | 'issued_date' | 'expiry_date') => (iso: string | null, v: FieldValidity) => {
    setRefused(r => ({ ...r, [k]: !v.valid }));
    if (v.valid) setForm(f => ({ ...f, [k]: iso ?? '' }));
  };

  const set = (k: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(f => ({ ...f, [k]: e.target.value }));

  // The directive is paid to this employee (a run, or /apply): its name and tax number are the employee's, shown
  // read-only and never posted (the server stores the record's, and a posted tax number would only reach the log).
  const picked = employees.find(emp => emp.id === form.employee_id);
  const regular = isRegularPayDirectiveType(form.directive_type);
  const pickEmployee = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setForm(f => ({ ...f, employee_id: e.target.value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // The select is required, but a submit can get past the browser's check: never POST without the employee.
    if (!form.employee_id) {
      setError('Choose the employee the directive is paid to');
      return;
    }
    if (Object.values(refused).some(Boolean)) {
      setError('Fix the dates marked in red before saving');
      return;
    }
    if (!form.effective_date) {
      setError('Enter the effective date');
      return;
    }
    setSaving(true);
    setError('');
    try {
      // A fixed-percentage or fixed-amount directive (IRP3(b)/(c)) carries a rate or a tax amount a month, no gross.
      const { tax_amount: taxAmount, ...rest } = form;
      const body = {
        ...rest,
        amount: regular ? undefined : parseFloat(form.amount),
        tax_rate: form.tax_rate && form.directive_type !== 'fixed_amount' ? parseFloat(form.tax_rate) / 100 : undefined,
        tax_amount: form.directive_type === 'fixed_amount' ? parseFloat(taxAmount) : undefined,
        // A blank date input is '', which the DATE columns refuse (expiry_date was a 500 on every create without one).
        issued_date: form.issued_date || undefined,
        expiry_date: form.expiry_date || undefined,
      };
      const res = await apiFetch('/api/accounting/tax-directives', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      await assertOk(res, 'Could not create the tax directive - try again');
      onCreated();
      onClose();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not create the tax directive - try again'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-slate-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-300 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white">New Tax Directive</h2>
          <button onClick={onClose} className="text-gray-600 dark:text-gray-400 hover:text-white"><X className="h-5 w-5" /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</p>
          )}
          <div className="grid grid-cols-2 gap-4">
            <DirectiveEmployeeSelect value={form.employee_id} onChange={pickEmployee} employees={employees}
              loading={employeesLoading} error={employeesError} inputCls={inputCls} labelCls={labelCls} onRetry={reloadEmployees} />
            <div className="col-span-2">
              <label htmlFor="td-employee-name" className={labelCls}>Employee Name *</label>
              <input id="td-employee-name" className={inputCls} value={picked ? `${picked.firstName} ${picked.lastName}` : ''} readOnly required placeholder="From the employee picked" />
            </div>
            <div>
              <label htmlFor="td-tax-number" className={labelCls}>Tax Number</label>
              <input id="td-tax-number" className={inputCls} value={picked?.taxNumber ?? ''} readOnly placeholder="From the employee picked" />
            </div>
            <Select label="Directive Type *" labelClassName={labelCls} options={TYPE_OPTIONS} value={form.directive_type}
              onChange={v => v && setForm(f => ({ ...f, directive_type: v as DirectiveType }))} />
            {regular ? (
              <>
                {form.directive_type === 'fixed_percentage' ? (
                  <div>
                    <label htmlFor="td-rate" className={labelCls}>Directive Rate (%) *</label>
                    <input id="td-rate" className={inputCls} type="number" min="0" max="100" step="0.01" value={form.tax_rate} onChange={set('tax_rate')} required placeholder="e.g. 20.00" />
                  </div>
                ) : (
                  <div>
                    <label htmlFor="td-tax-amount" className={labelCls}>PAYE a month (ZAR) *</label>
                    <input id="td-tax-amount" className={inputCls} type="number" min="0" step="0.01" value={form.tax_amount} onChange={set('tax_amount')} required placeholder="0.00" />
                  </div>
                )}
                <p className="col-span-2 text-xs text-[var(--ff-text-secondary)]">
                  Every pay run takes PAYE on regular pay from this directive, before retirement fund deductions, while it is in force.
                  Leave Expiry Date blank for the end of the tax year (SARS PAYE-GEN-01-G21, p. 15).
                </p>
              </>
            ) : (
              <>
                <div>
                  <label htmlFor="td-amount" className={labelCls}>Gross Amount (ZAR) *</label>
                  <input id="td-amount" className={inputCls} type="number" min="0" step="0.01" value={form.amount} onChange={set('amount')} required placeholder="0.00" />
                </div>
                <div>
                  <label htmlFor="td-lump-rate" className={labelCls}>Directive Rate (%) — leave blank for SARS table</label>
                  <input id="td-lump-rate" className={inputCls} type="number" min="0" max="100" step="0.01" value={form.tax_rate} onChange={set('tax_rate')} placeholder="e.g. 18.00" />
                </div>
              </>
            )}
            <DateField label="Effective Date" required value={form.effective_date || null} onChange={setDate('effective_date')} />
            <DateField label="Issued Date (by SARS)" value={form.issued_date || null} onChange={setDate('issued_date')} />
            <DateField label="Expiry Date" value={form.expiry_date || null} onChange={setDate('expiry_date')} />
            <div>
              <label className={labelCls}>Directive Number</label>
              <input className={inputCls} value={form.directive_number} onChange={set('directive_number')} placeholder="SARS directive number" />
            </div>
            <div>
              <label className={labelCls}>SARS Reference</label>
              <input className={inputCls} value={form.sars_reference} onChange={set('sars_reference')} placeholder="SARS case reference" />
            </div>
            <div className="col-span-2">
              <label className={labelCls}>Notes</label>
              <textarea className={inputCls} rows={2} value={form.notes} onChange={set('notes')} placeholder="Optional notes" />
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:text-white border border-gray-600 rounded-lg">
              Cancel
            </button>
            <button type="submit" disabled={saving || employees.length === 0} className="px-4 py-2 text-sm font-medium bg-brand-600 hover:bg-brand-700 text-white rounded-lg disabled:opacity-50 flex items-center gap-2">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              <Plus className="h-4 w-4" />
              Create Directive
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
