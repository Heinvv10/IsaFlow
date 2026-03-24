/**
 * Budget Management Page
 * Phase 5: Create and manage annual budgets per GL account
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Wallet, Plus, Trash2, Loader2, Copy } from 'lucide-react';

interface GLAccount { id: string; accountCode: string; accountName: string }
interface BudgetEntry {
  id: string; glAccountId: string; accountCode: string; accountName: string;
  accountType: string; fiscalYear: number; annualAmount: number; months: number[]; notes?: string;
}

const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);
const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export default function BudgetManagementPage() {
  const [budgets, setBudgets] = useState<BudgetEntry[]>([]);
  const [accounts, setAccounts] = useState<GLAccount[]>([]);
  const [fiscalYear, setFiscalYear] = useState(new Date().getFullYear());
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [form, setForm] = useState({ glAccountId: '', annualAmount: '', notes: '' });

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/accounting/budgets?fiscal_year=${fiscalYear}`, { credentials: 'include' });
    const json = await res.json();
    setBudgets(json.data?.items || []);
    setLoading(false);
  }, [fiscalYear]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    fetch('/api/accounting/chart-of-accounts', { credentials: 'include' }).then(r => r.json()).then(res => {
      const d = res.data || res;
      const list = Array.isArray(d) ? d : d.accounts || d.items || [];
      setAccounts(list
        .filter((a: Record<string, unknown>) => {
          const type = String(a.accountType || a.account_type || '');
          return type === 'expense' || type === 'revenue';
        })
        .map((a: Record<string, unknown>) => ({
          id: String(a.id),
          accountCode: String(a.accountCode || a.account_code || ''),
          accountName: String(a.accountName || a.account_name || ''),
        }))
      );
    });
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setBusy('save');
    try {
      const res = await fetch('/api/accounting/budgets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          glAccountId: form.glAccountId, fiscalYear,
          annualAmount: Number(form.annualAmount), notes: form.notes || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed');
      setShowForm(false);
      setForm({ glAccountId: '', annualAmount: '', notes: '' });
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed'); }
    finally { setBusy(''); }
  };

  const handleDelete = async (id: string) => {
    setBusy(id);
    await fetch('/api/accounting/budgets-action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'include', body: JSON.stringify({ action: 'delete', id }),
    });
    await load(); setBusy('');
  };

  const handleCopy = async () => {
    setBusy('copy'); setSuccess('');
    try {
      const res = await fetch('/api/accounting/budgets-action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'copy', fromYear: fiscalYear, toYear: fiscalYear + 1 }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed');
      setSuccess(`Copied ${json.data?.copied || 0} budgets to ${fiscalYear + 1}`);
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed'); }
    finally { setBusy(''); }
  };

  const totalBudget = budgets.reduce((s, b) => s + b.annualAmount, 0);
  const usedAccountIds = new Set(budgets.map(b => b.glAccountId));
  const availableAccounts = accounts.filter(a => !usedAccountIds.has(a.id));

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-amber-500/10"><Wallet className="h-6 w-6 text-amber-500" /></div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Budget Management</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Set annual budgets per GL account</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <select value={fiscalYear} onChange={e => setFiscalYear(Number(e.target.value))}
                className="px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm">
                {[2024, 2025, 2026, 2027].map(y => <option key={y} value={y}>{y}</option>)}
              </select>
              <button onClick={handleCopy} disabled={budgets.length === 0 || !!busy}
                className="inline-flex items-center gap-2 px-3 py-2 bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] rounded-lg text-sm hover:bg-[var(--ff-border-light)] disabled:opacity-50">
                <Copy className="h-4 w-4" /> Copy to {fiscalYear + 1}
              </button>
              <button onClick={() => setShowForm(!showForm)}
                className="inline-flex items-center gap-2 px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 text-sm font-medium">
                <Plus className="h-4 w-4" /> Add Budget
              </button>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {error && <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>}
          {success && <div className="p-3 rounded-lg bg-emerald-500/10 text-emerald-400 text-sm">{success}</div>}

          {/* Summary card */}
          {!loading && budgets.length > 0 && (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4 flex items-center justify-between">
              <div>
                <p className="text-xs text-[var(--ff-text-tertiary)]">Total Budget for {fiscalYear}</p>
                <p className="text-2xl font-bold text-[var(--ff-text-primary)]">{fmt(totalBudget)}</p>
              </div>
              <div className="text-sm text-[var(--ff-text-secondary)]">{budgets.length} accounts budgeted</div>
            </div>
          )}

          {showForm && (
            <form onSubmit={handleSubmit} className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6 space-y-4">
              <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Add Budget for {fiscalYear}</h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <select value={form.glAccountId} onChange={e => setForm(f => ({ ...f, glAccountId: e.target.value }))} className="ff-select" required>
                  <option value="">Select GL Account *</option>
                  {availableAccounts.map(a => <option key={a.id} value={a.id}>{a.accountCode} — {a.accountName}</option>)}
                </select>
                <input type="number" step="0.01" min="0" value={form.annualAmount} onChange={e => setForm(f => ({ ...f, annualAmount: e.target.value }))}
                  className="ff-input" placeholder="Annual Amount *" required />
                <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  className="ff-input" placeholder="Notes (optional)" />
              </div>
              <p className="text-xs text-[var(--ff-text-tertiary)]">Amount will be distributed evenly across 12 months.</p>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 text-sm text-[var(--ff-text-secondary)]">Cancel</button>
                <button type="submit" disabled={busy === 'save'} className="px-6 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">
                  {busy === 'save' ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save Budget'}
                </button>
              </div>
            </form>
          )}

          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                <th className="px-4 py-3">Account</th><th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3 text-right">Annual</th>
                <th className="px-4 py-3 text-right">Monthly</th>
                <th className="px-4 py-3">Notes</th>
                <th className="px-4 py-3">Actions</th>
              </tr></thead>
              <tbody>
                {loading && <tr><td colSpan={7} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">Loading...</td></tr>}
                {!loading && budgets.length === 0 && (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">
                    No budgets for {fiscalYear}. Add one or copy from another year.
                  </td></tr>
                )}
                {budgets.map(b => (
                  <tr key={b.id} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50">
                    <td className="px-4 py-3 font-mono text-[var(--ff-text-tertiary)]">{b.accountCode}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-primary)]">{b.accountName}</td>
                    <td className="px-4 py-3"><span className="px-2 py-0.5 rounded text-xs bg-[var(--ff-bg-primary)] text-[var(--ff-text-secondary)]">{b.accountType}</span></td>
                    <td className="px-4 py-3 text-right text-[var(--ff-text-primary)] font-medium">{fmt(b.annualAmount)}</td>
                    <td className="px-4 py-3 text-right text-[var(--ff-text-secondary)]">{fmt(b.annualAmount / 12)}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-tertiary)] text-xs truncate max-w-[150px]">{b.notes || '—'}</td>
                    <td className="px-4 py-3">
                      <button onClick={() => handleDelete(b.id)} disabled={busy === b.id} className="p-1 text-red-400 hover:text-red-300" title="Delete">
                        {busy === b.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              {budgets.length > 0 && (
                <tfoot><tr className="border-t-2 border-[var(--ff-border-light)] font-bold">
                  <td colSpan={3} className="px-4 py-3 text-[var(--ff-text-primary)]">TOTAL</td>
                  <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">{fmt(totalBudget)}</td>
                  <td className="px-4 py-3 text-right text-[var(--ff-text-secondary)]">{fmt(totalBudget / 12)}</td>
                  <td colSpan={2}></td>
                </tr></tfoot>
              )}
            </table>
          </div>

          {/* Monthly breakdown */}
          {budgets.length > 0 && (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                  <th className="px-3 py-2 sticky left-0 bg-[var(--ff-bg-secondary)]">Account</th>
                  {MONTH_LABELS.map(m => <th key={m} className="px-3 py-2 text-right">{m}</th>)}
                </tr></thead>
                <tbody>
                  {budgets.map(b => (
                    <tr key={b.id} className="border-b border-[var(--ff-border-light)]">
                      <td className="px-3 py-2 font-mono text-[var(--ff-text-tertiary)] sticky left-0 bg-[var(--ff-bg-secondary)]">{b.accountCode}</td>
                      {b.months.map((m, i) => (
                        <td key={i} className="px-3 py-2 text-right text-[var(--ff-text-primary)]">{fmt(m)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
