/**
 * Budget Management Page
 * Create and manage budgets per GL account for a financial year. Amounts are
 * per calendar month, so a 14-month transition year shows 14 month columns.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Wallet, Plus, Trash2, Loader2, Copy, Pencil } from 'lucide-react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { BudgetForm, type BudgetSubmit } from '@/components/accounting/budgets/BudgetForm';
import {
  fmt, monthLabel, yearOptionLabel, yearRangeLabel,
  type BudgetRow, type BudgetYear, type GLAccount,
} from '@/components/accounting/budgets/budgetClient';

export default function BudgetManagementPage() {
  const [budgets, setBudgets] = useState<BudgetRow[]>([]);
  const [accounts, setAccounts] = useState<GLAccount[]>([]);
  // null until the first load: the API answers with the financial year holding today.
  const [fiscalYear, setFiscalYear] = useState<number | null>(null);
  const [year, setYear] = useState<BudgetYear | null>(null);
  const [years, setYears] = useState<BudgetYear[]>([]);
  const [editing, setEditing] = useState<BudgetRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  // The year the first load resolved to: selecting it must not fetch a second time.
  const loadedYear = useRef<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/accounting/budgets?fiscal_year=${fiscalYear ?? ''}`, { credentials: 'include' });
      await assertOk(res, 'Could not load budgets - try again');
      const json = await res.json();
      setBudgets(json.data?.items || []);
      setYear(json.data?.year ?? null);
      setYears(json.data?.years ?? []);
      if (fiscalYear === null && json.data?.fiscalYear) {
        loadedYear.current = Number(json.data.fiscalYear);
        setFiscalYear(loadedYear.current);
      }
    } catch (err) {
      setBudgets([]);
      setYear(null);
      setError(apiErrorMessage(err, 'Could not load budgets - try again'));
    } finally { setLoading(false); }
  }, [fiscalYear]);

  useEffect(() => {
    if (fiscalYear !== null && fiscalYear === loadedYear.current) { loadedYear.current = null; return; }
    void load();
  }, [load, fiscalYear]);

  useEffect(() => {
    apiFetch('/api/accounting/chart-of-accounts', { credentials: 'include' })
      .then(async r => { await assertOk(r, 'Could not load GL accounts - try again'); return r.json(); }).then(res => {
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
    }).catch((err) => {
      setError(apiErrorMessage(err, 'Could not load GL accounts - try again'));
    });
  }, []);

  const handleSubmit = async (body: BudgetSubmit) => {
    setError(''); setSuccess(''); setBusy('save');
    try {
      const res = await apiFetch('/api/accounting/budgets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ ...body, fiscalYear }),
      });
      await assertOk(res, 'Could not save the budget - try again');
      setShowForm(false); setEditing(null);
      setSuccess('Budget saved');
      await load();
    } catch (err) { setError(apiErrorMessage(err, 'Could not save the budget - try again')); }
    finally { setBusy(''); }
  };

  const handleDelete = async (glAccountId: string) => {
    setBusy(glAccountId); setSuccess(''); setError('');
    try {
      const res = await apiFetch('/api/accounting/budgets-action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ action: 'delete', glAccountId, fiscalYear }),
      });
      await assertOk(res, 'Could not delete the budget - try again');
      setSuccess('Budget deleted');
      await load();
    } catch (err) { setError(apiErrorMessage(err, 'Could not delete the budget - try again')); }
    finally { setBusy(''); }
  };

  const handleCopy = async () => {
    if (!nextYear) return;
    setBusy('copy'); setSuccess(''); setError('');
    try {
      const res = await apiFetch('/api/accounting/budgets-action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'copy', fromYear: fiscalYear, toYear: nextYear.fiscalYear }),
      });
      await assertOk(res, 'Could not copy the budgets - try again');
      const json = await res.json();
      setSuccess(`Copied ${json.data?.copied || 0} budgets to ${nextYear.fiscalYear}, month by month`
        + ' (months beyond the shorter year are not copied; months already budgeted there are kept)');
    } catch (err) { setError(apiErrorMessage(err, 'Could not copy the budgets - try again')); }
    finally { setBusy(''); }
  };

  const totalBudget = budgets.reduce((s, b) => s + b.annualAmount, 0);
  const monthKeys = year?.monthKeys ?? [];
  // The year after this one in the list: after a change of year end the next label can skip one.
  const nextYear = years.find(y => year !== null && y.startDate > year.startDate) ?? null;
  const usedAccountIds = new Set(budgets.map(b => b.glAccountId));
  const availableAccounts = accounts.filter(a => !usedAccountIds.has(a.id));
  const formAccounts = editing ? accounts.filter(a => a.id === editing.glAccountId) : availableAccounts;
  const yearOptions = years.length > 0 ? years : fiscalYear !== null
    ? [{ fiscalYear, startDate: '', endDate: '', kind: 'normal', monthKeys: [] }] : [];

  const closeForm = () => { setShowForm(false); setEditing(null); };
  const changeYear = (value: number) => { closeForm(); setFiscalYear(value); };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-amber-500/10"><Wallet className="h-6 w-6 text-amber-500" /></div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Budget Management</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  Set budgets per GL account, by month{year ? ` - ${yearRangeLabel(year)}` : ''}
                  {year?.kind === 'transition' ? ' - transition year' : ''}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <select value={fiscalYear ?? ''} onChange={e => changeYear(Number(e.target.value))} data-testid="budget-year"
                className="px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm">
                {yearOptions.map(y => <option key={y.fiscalYear} value={y.fiscalYear}>{yearOptionLabel(y)}</option>)}
              </select>
              <button onClick={handleCopy} disabled={budgets.length === 0 || !nextYear || !!busy}
                className="inline-flex items-center gap-2 px-3 py-2 bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] rounded-lg text-sm hover:bg-[var(--ff-border-light)] disabled:opacity-50">
                <Copy className="h-4 w-4" /> Copy to {nextYear?.fiscalYear ?? 'next year'}
              </button>
              <button onClick={() => { setEditing(null); setShowForm(!showForm); }}
                className="inline-flex items-center gap-2 px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 text-sm font-medium">
                <Plus className="h-4 w-4" /> Add Budget
              </button>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {error && <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>}
          {success && <div className="p-3 rounded-lg bg-teal-500/10 text-teal-400 text-sm">{success}</div>}

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

          {(showForm || editing) && fiscalYear !== null && (
            <BudgetForm key={`${fiscalYear}-${editing?.glAccountId ?? 'new'}`} fiscalYear={fiscalYear}
              monthKeys={monthKeys} accounts={formAccounts} editing={editing}
              busy={busy === 'save'} onSubmit={handleSubmit} onCancel={closeForm} />
          )}

          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                <th className="px-4 py-3">Account</th><th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3 text-right">Total</th>
                <th className="px-4 py-3 text-right">Monthly average</th>
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
                  <tr key={b.glAccountId} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50">
                    <td className="px-4 py-3 font-mono text-[var(--ff-text-tertiary)]">{b.accountCode}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-primary)]">{b.accountName}</td>
                    <td className="px-4 py-3"><span className="px-2 py-0.5 rounded text-xs bg-[var(--ff-bg-primary)] text-[var(--ff-text-secondary)]">{b.accountType}</span></td>
                    <td data-testid={`budget-total-${b.accountCode}`} className="px-4 py-3 text-right text-[var(--ff-text-primary)] font-medium">{fmt(b.annualAmount)}</td>
                    <td className="px-4 py-3 text-right text-[var(--ff-text-secondary)]">{fmt(b.annualAmount / (monthKeys.length || 12))}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-tertiary)] text-xs truncate max-w-[150px]">{b.notes || '—'}</td>
                    <td className="px-4 py-3">
                      <button onClick={() => { setShowForm(false); setEditing(b); }} className="p-1 text-[var(--ff-text-secondary)]" title="Edit">
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button onClick={() => handleDelete(b.glAccountId)} disabled={busy === b.glAccountId} className="p-1 text-red-400 hover:text-red-300" title="Delete">
                        {busy === b.glAccountId ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              {budgets.length > 0 && (
                <tfoot><tr className="border-t-2 border-[var(--ff-border-light)] font-bold">
                  <td colSpan={3} className="px-4 py-3 text-[var(--ff-text-primary)]">TOTAL</td>
                  <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">{fmt(totalBudget)}</td>
                  <td className="px-4 py-3 text-right text-[var(--ff-text-secondary)]">{fmt(totalBudget / (monthKeys.length || 12))}</td>
                  <td colSpan={2}></td>
                </tr></tfoot>
              )}
            </table>
          </div>

          {/* Monthly breakdown: one column per month of the year */}
          {budgets.length > 0 && (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                  <th className="px-3 py-2 sticky left-0 bg-[var(--ff-bg-secondary)]">Account</th>
                  {monthKeys.map(k => <th key={k} className="px-3 py-2 text-right whitespace-nowrap">{monthLabel(k)}</th>)}
                </tr></thead>
                <tbody>
                  {budgets.map(b => (
                    <tr key={b.glAccountId} className="border-b border-[var(--ff-border-light)]">
                      <td className="px-3 py-2 font-mono text-[var(--ff-text-tertiary)] sticky left-0 bg-[var(--ff-bg-secondary)]">{b.accountCode}</td>
                      {b.months.map(m => (
                        <td key={m.month} className="px-3 py-2 text-right text-[var(--ff-text-primary)]">{fmt(m.amount)}</td>
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
