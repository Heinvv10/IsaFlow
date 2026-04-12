/**
 * Tax Directive sub-components — Create Modal + Lump Sum Calculator
 * Used by /payroll/tax-directives page.
 */

import { useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { X, Loader2, Calculator, Plus } from 'lucide-react';
import { calculateLumpSumTax, type LumpSumCalculation } from '@/lib/taxCalculations';

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
  const [form, setForm] = useState({
    employee_name: '',
    employee_tax_number: '',
    directive_number: '',
    directive_type: 'retirement' as DirectiveType,
    amount: '',
    tax_rate: '',
    effective_date: '',
    expiry_date: '',
    sars_reference: '',
    notes: '',
  });

  const set = (k: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(f => ({ ...f, [k]: e.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const body = {
        ...form,
        amount: parseFloat(form.amount),
        tax_rate: form.tax_rate ? parseFloat(form.tax_rate) / 100 : undefined,
      };
      const res = await apiFetch('/api/accounting/tax-directives', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json();
        throw new Error(j.error?.message ?? 'Failed to create directive');
      }
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-gray-800 border border-gray-700 rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700">
          <h2 className="text-lg font-semibold text-white">New Tax Directive</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white"><X className="h-5 w-5" /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</p>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className={labelCls}>Employee Name *</label>
              <input className={inputCls} value={form.employee_name} onChange={set('employee_name')} required placeholder="Full name" />
            </div>
            <div>
              <label className={labelCls}>Tax Number</label>
              <input className={inputCls} value={form.employee_tax_number} onChange={set('employee_tax_number')} placeholder="SARS tax number" />
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
              <label className={labelCls}>Gross Amount (ZAR) *</label>
              <input className={inputCls} type="number" min="0" step="0.01" value={form.amount} onChange={set('amount')} required placeholder="0.00" />
            </div>
            <div>
              <label className={labelCls}>Directive Rate (%) — leave blank for SARS table</label>
              <input className={inputCls} type="number" min="0" max="100" step="0.01" value={form.tax_rate} onChange={set('tax_rate')} placeholder="e.g. 18.00" />
            </div>
            <div>
              <label className={labelCls}>Effective Date *</label>
              <input className={inputCls} type="date" value={form.effective_date} onChange={set('effective_date')} required />
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
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-300 hover:text-white border border-gray-600 rounded-lg">
              Cancel
            </button>
            <button type="submit" disabled={saving} className="px-4 py-2 text-sm font-medium bg-teal-600 hover:bg-teal-500 text-white rounded-lg disabled:opacity-50 flex items-center gap-2">
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
    <div className="bg-gray-800 border border-gray-700 rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <Calculator className="h-5 w-5 text-teal-400" />
        <h3 className="text-sm font-semibold text-white">Lump Sum Calculator</h3>
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
          <span className="text-xs text-gray-300">Use directive rate</span>
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
          <div className="mt-3 space-y-2 border-t border-gray-700 pt-3">
            <div className="space-y-1">
              {result.breakdown.map((b, i) => (
                <div key={i} className="flex justify-between text-xs">
                  <span className="text-gray-400">{b.bracket}</span>
                  <span className="text-gray-200">{fmtCurrency(b.tax)}</span>
                </div>
              ))}
            </div>
            <div className="flex justify-between text-sm font-semibold border-t border-gray-600 pt-2">
              <span className="text-white">Total Tax</span>
              <span className="text-red-400">{fmtCurrency(result.taxAmount)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-gray-400">Net Payment</span>
              <span className="text-teal-400">{fmtCurrency(result.grossAmount - result.taxAmount)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-gray-400">Effective Rate</span>
              <span className="text-gray-200">{(result.effectiveRate * 100).toFixed(2)}%</span>
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
