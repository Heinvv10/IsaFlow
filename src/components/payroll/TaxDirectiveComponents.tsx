/**
 * Tax Directive sub-components — Create Modal + Lump Sum Calculator
 * Used by /payroll/tax-directives page.
 */

import { useState } from 'react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { X, Loader2, Calculator, Plus } from 'lucide-react';
import { calculateLumpSumTax, type LumpSumCalculation } from '@/lib/taxCalculations';
import { DirectiveEmployeeSelect, useDirectiveEmployees } from './TaxDirectiveEmployeeSelect';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtCurrency = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const DIRECTIVE_TYPES = ['lump_sum', 'retirement', 'severance', 'death'] as const;
type DirectiveType = typeof DIRECTIVE_TYPES[number];

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
  const { employees, loading: employeesLoading, error: employeesError } = useDirectiveEmployees();
  const [form, setForm] = useState({
    employee_id: '',
    employee_name: '',
    employee_tax_number: '',
    directive_number: '',
    directive_type: 'retirement' as DirectiveType,
    amount: '',
    tax_rate: '',
    effective_date: '',
    issued_date: '',
    expiry_date: '',
    sars_reference: '',
    notes: '',
  });

  const set = (k: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(f => ({ ...f, [k]: e.target.value }));

  // The directive is paid to this employee (a run, or /apply): name and tax number follow the pick, still editable.
  const pickEmployee = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const picked = employees.find(emp => emp.id === e.target.value);
    setForm(f => ({
      ...f,
      employee_id: e.target.value,
      employee_name: picked ? `${picked.firstName} ${picked.lastName}` : f.employee_name,
      employee_tax_number: picked ? picked.taxNumber ?? '' : f.employee_tax_number,
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // The select is required, but a submit can get past the browser's check: never POST without the employee.
    if (!form.employee_id) {
      setError('Choose the employee the directive is paid to');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const body = {
        ...form,
        amount: parseFloat(form.amount),
        tax_rate: form.tax_rate ? parseFloat(form.tax_rate) / 100 : undefined,
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
              loading={employeesLoading} error={employeesError} inputCls={inputCls} labelCls={labelCls} />
            <div className="col-span-2">
              <label htmlFor="td-employee-name" className={labelCls}>Employee Name *</label>
              <input id="td-employee-name" className={inputCls} value={form.employee_name} onChange={set('employee_name')} required placeholder="Full name, as on the directive" />
            </div>
            <div>
              <label htmlFor="td-tax-number" className={labelCls}>Tax Number</label>
              <input id="td-tax-number" className={inputCls} value={form.employee_tax_number} onChange={set('employee_tax_number')} placeholder="SARS tax number" />
            </div>
            <div>
              <label className={labelCls}>Directive Type *</label>
              <select className={inputCls} value={form.directive_type} onChange={set('directive_type')} required>
                {DIRECTIVE_TYPES.map(t => (
                  <option key={t} value={t}>{t.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="td-amount" className={labelCls}>Gross Amount (ZAR) *</label>
              <input id="td-amount" className={inputCls} type="number" min="0" step="0.01" value={form.amount} onChange={set('amount')} required placeholder="0.00" />
            </div>
            <div>
              <label className={labelCls}>Directive Rate (%) — leave blank for SARS table</label>
              <input className={inputCls} type="number" min="0" max="100" step="0.01" value={form.tax_rate} onChange={set('tax_rate')} placeholder="e.g. 18.00" />
            </div>
            <div>
              <label htmlFor="td-effective" className={labelCls}>Effective Date *</label>
              <input id="td-effective" className={inputCls} type="date" value={form.effective_date} onChange={set('effective_date')} required />
            </div>
            <div>
              <label className={labelCls}>Issued Date (by SARS)</label>
              <input className={inputCls} type="date" value={form.issued_date} onChange={set('issued_date')} aria-label="Issued Date" />
            </div>
            <div>
              <label className={labelCls}>Expiry Date</label>
              <input className={inputCls} type="date" value={form.expiry_date} onChange={set('expiry_date')} />
            </div>
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
            <button type="submit" disabled={saving || employees.length === 0} className="px-4 py-2 text-sm font-medium bg-teal-600 hover:bg-teal-500 text-white rounded-lg disabled:opacity-50 flex items-center gap-2">
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

// ─── Lump Sum Calculator ──────────────────────────────────────────────────────

export function LumpSumCalculator() {
  const [gross, setGross] = useState('');
  const [useDirectiveRate, setUseDirectiveRate] = useState(false);
  const [directiveRate, setDirectiveRate] = useState('');
  const [result, setResult] = useState<LumpSumCalculation | null>(null);

  const calculate = () => {
    const amount = parseFloat(gross);
    if (isNaN(amount) || amount <= 0) return;
    const rate = useDirectiveRate && directiveRate ? parseFloat(directiveRate) / 100 : null;
    setResult(calculateLumpSumTax(amount, rate));
  };

  return (
    <div className="bg-slate-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <Calculator className="h-5 w-5 text-teal-400" />
        <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Lump Sum Calculator</h3>
      </div>
      <div className="space-y-3">
        <div>
          <label className={labelCls}>Gross Amount (ZAR)</label>
          <input
            type="number" min="0" step="0.01"
            className={inputCls}
            value={gross} onChange={e => setGross(e.target.value)} placeholder="0.00"
          />
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={useDirectiveRate} onChange={e => setUseDirectiveRate(e.target.checked)} className="accent-teal-500" />
          <span className="text-xs text-gray-700 dark:text-gray-300">Use directive rate</span>
        </label>
        {useDirectiveRate && (
          <div>
            <label className={labelCls}>Directive Rate (%)</label>
            <input
              type="number" min="0" max="100" step="0.01"
              className={inputCls}
              value={directiveRate} onChange={e => setDirectiveRate(e.target.value)} placeholder="e.g. 18.00"
            />
          </div>
        )}
        <button onClick={calculate} className="w-full py-2 text-sm font-medium bg-teal-600 hover:bg-teal-500 text-white rounded-lg transition-colors">
          Calculate Tax
        </button>
        {result && (
          <div className="mt-3 space-y-2 border-t border-gray-300 dark:border-gray-700 pt-3">
            <div className="space-y-1">
              {result.breakdown.map((b, i) => (
                <div key={i} className="flex justify-between text-xs">
                  <span className="text-gray-600 dark:text-gray-400">{b.bracket}</span>
                  <span className="text-gray-800 dark:text-gray-200">{fmtCurrency(b.tax)}</span>
                </div>
              ))}
            </div>
            <div className="flex justify-between text-sm font-semibold border-t border-gray-600 pt-2">
              <span className="text-slate-900 dark:text-white">Total Tax</span>
              <span className="text-red-400">{fmtCurrency(result.taxAmount)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-gray-600 dark:text-gray-400">Net Payment</span>
              <span className="text-teal-400">{fmtCurrency(result.grossAmount - result.taxAmount)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-gray-600 dark:text-gray-400">Effective Rate</span>
              <span className="text-gray-800 dark:text-gray-200">{(result.effectiveRate * 100).toFixed(2)}%</span>
            </div>
            {result.directiveRateUsed && (
              <p className="text-xs text-amber-400">Using SARS directive rate</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
