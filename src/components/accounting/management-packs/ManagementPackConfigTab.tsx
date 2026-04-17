// src/components/accounting/management-packs/ManagementPackConfigTab.tsx
import { useState, useEffect } from 'react';
import { Plus, Trash2, AlertCircle, Loader2 } from 'lucide-react';
import type { ManagementPackConfig, PackRecipient, PackStyle } from '@/modules/accounting/services/afs/afsTypes';

const SECTIONS_META: Array<{ key: string; label: string }> = [
  { key: 'cover', label: 'Cover Page' },
  { key: 'ai_executive_summary', label: 'AI Executive Summary' },
  { key: 'kpi_scorecard', label: 'KPI Scorecard' },
  { key: 'income_statement', label: 'Income Statement' },
  { key: 'income_vs_budget', label: 'Income vs Budget' },
  { key: 'balance_sheet', label: 'Balance Sheet' },
  { key: 'cash_flow', label: 'Cash Flow' },
  { key: 'debtors_ageing', label: 'Debtors Ageing' },
  { key: 'creditors_ageing', label: 'Creditors Ageing' },
  { key: 'bank_reconciliation', label: 'Bank Reconciliation' },
  { key: 'revenue_analysis', label: 'Revenue Analysis' },
  { key: 'expense_analysis', label: 'Expense Analysis' },
  { key: 'budget_variance', label: 'Budget Variance' },
  { key: 'cash_flow_forecast', label: 'Cash Flow Forecast' },
  { key: 'vat_dashboard', label: 'VAT Dashboard' },
  { key: 'cfo_narrative', label: 'CFO Narrative' },
];

const DAYS = Array.from({ length: 28 }, (_, i) => i + 1);

interface Props {
  config: ManagementPackConfig;
  onSave: (c: ManagementPackConfig) => Promise<void>;
}

export function ManagementPackConfigTab({ config, onSave }: Props) {
  const [form, setForm] = useState<ManagementPackConfig>(config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [newRecipient, setNewRecipient] = useState<PackRecipient>({ email: '', role: '', receives: 'both' });

  useEffect(() => { setForm(config); }, [config]);

  async function handleSave() {
    setSaving(true); setError('');
    try { await onSave(form); }
    catch (e) { setError(e instanceof Error ? e.message : 'Save failed'); }
    finally { setSaving(false); }
  }

  function addRecipient() {
    if (!newRecipient.email || !newRecipient.role) return;
    setForm(f => ({ ...f, recipients: [...f.recipients, { ...newRecipient }] }));
    setNewRecipient({ email: '', role: '', receives: 'both' });
  }

  function removeRecipient(idx: number) {
    setForm(f => ({ ...f, recipients: f.recipients.filter((_, i) => i !== idx) }));
  }

  return (
    <div className="space-y-6">
      <div className="bg-white dark:bg-slate-900 border border-zinc-200 dark:border-slate-800 rounded-xl p-6">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-slate-100 uppercase tracking-wide mb-4">Scheduler Settings</h3>
        <div className="grid grid-cols-2 gap-4">
          <label className="flex items-center gap-3">
            <span className="text-sm text-zinc-700 dark:text-slate-300 w-40">Automated packs</span>
            <input type="checkbox" checked={form.enabled} onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))} className="w-4 h-4 accent-teal-600" />
          </label>
          <label className="flex items-center gap-3">
            <span className="text-sm text-zinc-700 dark:text-slate-300 w-40">Review required</span>
            <input type="checkbox" checked={form.reviewRequired} onChange={e => setForm(f => ({ ...f, reviewRequired: e.target.checked }))} className="w-4 h-4 accent-teal-600" />
          </label>
          <label className="flex items-center gap-3">
            <span className="text-sm text-zinc-700 dark:text-slate-300 w-40">Generate on day</span>
            <select value={form.generationDay} onChange={e => setForm(f => ({ ...f, generationDay: Number(e.target.value) }))} className="border border-zinc-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 rounded-lg px-3 py-1.5 text-sm">
              {DAYS.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-3">
            <span className="text-sm text-zinc-700 dark:text-slate-300 w-40">Delivery on day</span>
            <select value={form.deliveryDay} onChange={e => setForm(f => ({ ...f, deliveryDay: Number(e.target.value) }))} className="border border-zinc-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 rounded-lg px-3 py-1.5 text-sm">
              {DAYS.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-3">
            <span className="text-sm text-zinc-700 dark:text-slate-300 w-40">Pack style</span>
            <select value={form.packStyle} onChange={e => setForm(f => ({ ...f, packStyle: e.target.value as PackStyle }))} className="border border-zinc-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 rounded-lg px-3 py-1.5 text-sm">
              <option value="executive">Executive</option>
              <option value="detailed">Detailed</option>
              <option value="board">Board</option>
            </select>
          </label>
          <label className="flex items-center gap-3">
            <span className="text-sm text-zinc-700 dark:text-slate-300 w-40">Comparison</span>
            <select value={form.comparisonMode} onChange={e => setForm(f => ({ ...f, comparisonMode: e.target.value as ManagementPackConfig['comparisonMode'] }))} className="border border-zinc-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 rounded-lg px-3 py-1.5 text-sm">
              <option value="prior_month">Prior Month</option>
              <option value="prior_year">Prior Year</option>
              <option value="budget">Budget</option>
              <option value="all_three">All Three</option>
            </select>
          </label>
        </div>
      </div>

      <div className="bg-white dark:bg-slate-900 border border-zinc-200 dark:border-slate-800 rounded-xl p-6">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-slate-100 uppercase tracking-wide mb-4">Sections</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {SECTIONS_META.map(({ key, label }) => (
            <label key={key} className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox"
                checked={form.sectionsEnabled[key] ?? false}
                onChange={e => setForm(f => ({ ...f, sectionsEnabled: { ...f.sectionsEnabled, [key]: e.target.checked } }))}
                className="w-4 h-4 accent-teal-600" />
              <span className="text-sm text-zinc-700 dark:text-slate-300">{label}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="bg-white dark:bg-slate-900 border border-zinc-200 dark:border-slate-800 rounded-xl p-6">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-slate-100 uppercase tracking-wide mb-4">Recipients</h3>
        <div className="space-y-2 mb-4">
          {form.recipients.map((r, i) => (
            <div key={i} className="flex items-center gap-3 bg-zinc-50 dark:bg-slate-800/60 rounded-lg px-3 py-2">
              <span className="text-sm font-medium text-zinc-900 dark:text-slate-100 flex-1">{r.email}</span>
              <span className="text-xs text-zinc-500 dark:text-slate-400">{r.role}</span>
              <span className="text-xs bg-zinc-200 dark:bg-slate-700 text-zinc-700 dark:text-slate-200 px-2 py-0.5 rounded-full">{r.receives}</span>
              <button onClick={() => removeRecipient(i)} className="text-zinc-400 dark:text-slate-500 hover:text-red-500 dark:hover:text-red-400"><Trash2 className="w-4 h-4" /></button>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <input value={newRecipient.email} onChange={e => setNewRecipient(r => ({ ...r, email: e.target.value }))}
            placeholder="email@example.com" className="border border-zinc-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 rounded-lg px-3 py-1.5 text-sm flex-1" />
          <input value={newRecipient.role} onChange={e => setNewRecipient(r => ({ ...r, role: e.target.value }))}
            placeholder="Role" className="border border-zinc-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 rounded-lg px-3 py-1.5 text-sm w-32" />
          <select value={newRecipient.receives} onChange={e => setNewRecipient(r => ({ ...r, receives: e.target.value as PackRecipient['receives'] }))}
            className="border border-zinc-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 rounded-lg px-3 py-1.5 text-sm">
            <option value="draft">Draft</option>
            <option value="final">Final</option>
            <option value="both">Both</option>
          </select>
          <button onClick={addRecipient} className="inline-flex items-center gap-1 px-3 py-1.5 bg-teal-600 hover:bg-teal-700 text-white text-sm rounded-lg">
            <Plus className="w-4 h-4" /> Add
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400 flex items-center gap-1"><AlertCircle className="w-4 h-4" />{error}</p>}

      <button onClick={handleSave} disabled={saving}
        className="inline-flex items-center gap-2 px-5 py-2.5 bg-teal-600 hover:bg-teal-700 text-white font-semibold rounded-lg disabled:opacity-50">
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
        Save Configuration
      </button>
    </div>
  );
}
