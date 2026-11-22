/**
 * Staff Cost Rates Admin
 * Route: /accounting/practice/staff-cost-rates
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { DollarSign, Loader2, AlertCircle, Plus, Trash2 } from 'lucide-react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import type { CompanyUserSummary } from '@/modules/accounting/services/practice/practiceUsersService';
import type { StaffCostRate } from '@/modules/accounting/services/practice/practiceCostRateService';
import { localISODate } from '@/lib/dateUtils';
import { formatMoney } from '@/lib/money/formatMoney';
import { GatedDateField, useDateGate } from '@/components/forms/GatedDateField';
import { NO_PAYROLL_DETAIL_ACCESS } from '@/lib/payrollDetailAccess';
import { AmountInput } from '@/components/ui/AmountInput';
import { useAmountGuard } from '@/components/ui/useAmountGuard';

const INPUT = 'rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-tertiary)] px-3 py-1.5 text-sm text-[var(--ff-text-primary)] focus:outline-none focus:ring-2 focus:ring-teal-500/40 w-full';
const TH = 'text-left py-2 px-3 text-xs tracking-widest font-semibold text-[var(--ff-text-secondary)] uppercase';
const TD = 'py-2.5 px-3 text-sm text-[var(--ff-text-secondary)]';

function todayIso() { return localISODate(); }

function getUserLabel(users: CompanyUserSummary[], userId: string): string {
  return users.find((u) => u.id === userId)?.displayName ?? userId;
}

interface FormState {
  userId: string;
  costRate: string;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string;
  notes: string;
}

const EMPTY_FORM: FormState = {
  userId: '',
  costRate: '',
  currency: 'ZAR',
  effectiveFrom: todayIso(),
  effectiveTo: '',
  notes: '',
};

export default function StaffCostRatesPage() {
  const dateGate = useDateGate();
  const [users, setUsers] = useState<CompanyUserSummary[]>([]);
  const [rates, setRates] = useState<StaffCostRate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // The server answered 403 to the rate list: a person's cost per hour is Payroll's, so without Payroll read the page offers nothing (round 10).
  const [noAccess, setNoAccess] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [usersRes, ratesRes] = await Promise.all([
        apiFetch('/api/accounting/practice/users'),
        apiFetch('/api/accounting/practice/staff-cost-rates'),
      ]);
      setNoAccess(ratesRes.status === 403);
      if (ratesRes.status === 403) { setUsers([]); setRates([]); return; }
      await assertOk(usersRes, 'Could not load the staff list - try again');
      await assertOk(ratesRes, 'Could not load the cost rates - try again');

      const usersJson = await usersRes.json() as { data?: CompanyUserSummary[] } | CompanyUserSummary[];
      const ratesJson = await ratesRes.json() as { data?: StaffCostRate[] } | StaffCostRate[];

      setUsers(Array.isArray(usersJson) ? usersJson : ((usersJson as { data?: CompanyUserSummary[] }).data ?? []));
      setRates(Array.isArray(ratesJson) ? ratesJson : ((ratesJson as { data?: StaffCostRate[] }).data ?? []));
    } catch (e) {
      setUsers([]); setRates([]);
      setError(apiErrorMessage(e, 'Could not load the cost rates - try again'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const guard = useAmountGuard();
  async function handleAdd() {
    if (guard.blocked()) return;
    if (!form.userId || !form.costRate || !form.effectiveFrom) {
      setAddError('User, cost rate, and effective from are required');
      return;
    }
    const costRateNum = Number(form.costRate);
    if (isNaN(costRateNum) || costRateNum < 0) {
      setAddError('Cost rate must be a non-negative number');
      return;
    }
    setAdding(true);
    setAddError(null);
    try {
      const res = await apiFetch('/api/accounting/practice/staff-cost-rates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: form.userId,
          costRate: costRateNum,
          currency: form.currency || 'ZAR',
          effectiveFrom: form.effectiveFrom,
          effectiveTo: form.effectiveTo || null,
          notes: form.notes || null,
        }),
      });
      await assertOk(res, 'Could not add the cost rate - try again');
      dateGate.reset('effective-from'); dateGate.reset('effective-to');
      setForm(EMPTY_FORM);
      await loadData();
    } catch (e) {
      setAddError(apiErrorMessage(e, 'Could not add the cost rate - try again'));
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(id: string) {
    setDeletingId(id);
    try {
      const res = await apiFetch(`/api/accounting/practice/staff-cost-rates/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      await assertOk(res, 'Could not delete the cost rate - try again');
      await loadData();
    } catch (e) {
      setError(apiErrorMessage(e, 'Could not delete the cost rate - try again'));
    } finally {
      setDeletingId(null);
    }
  }

  function setField(field: keyof FormState, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  return (
    <AppLayout>
      <div ref={guard.ref} className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-teal-500/10">
              <DollarSign className="h-5 w-5 text-teal-400" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-[var(--ff-text-primary)]">Staff Cost Rates</h1>
              <p className="text-xs text-[var(--ff-text-tertiary)]">Internal cost per hour — used in client profitability margin calculation</p>
            </div>
          </div>
        </div>

        <div className="px-6 py-6 max-w-5xl space-y-6">
          {noAccess && !loading && (
            <div role="alert" className="flex items-start gap-2 p-4 rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-300 text-sm">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium">Staff cost rates need Payroll access.</p>
                <p className="text-xs opacity-80">{NO_PAYROLL_DETAIL_ACCESS} An owner or admin can grant Payroll in User Access.</p>
              </div>
            </div>
          )}
          {/* Add form */}
          {!noAccess && <div className="p-4 rounded-xl border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] space-y-4">
            <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Add cost rate</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <div className="flex flex-col gap-1 lg:col-span-2">
                <label className="text-xs font-medium text-[var(--ff-text-secondary)]">Staff member *</label>
                <select className={INPUT} value={form.userId} onChange={(e) => setField('userId', e.target.value)}>
                  <option value="">Select user…</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>{u.displayName}</option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-[var(--ff-text-secondary)]">Cost rate/hr *</label>
                <AmountInput min={0} decimals={4} className={INPUT} value={form.costRate}
                  onValueChange={(_n, t) => setField('costRate', t)} placeholder="0.00" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-[var(--ff-text-secondary)]">Currency</label>
                <input type="text" maxLength={3} className={INPUT} value={form.currency}
                  onChange={(e) => setField('currency', e.target.value.toUpperCase())} />
              </div>
              <div className="flex flex-col gap-1">
                <GatedDateField gate={dateGate} gateKey="effective-from" label="Effective from" required value={form.effectiveFrom || null} onValue={(iso) => setField('effectiveFrom', iso)} />
              </div>
              <div className="flex flex-col gap-1">
                <GatedDateField gate={dateGate} gateKey="effective-to" label="Effective to" value={form.effectiveTo || null} onValue={(iso) => setField('effectiveTo', iso)} />
              </div>
            </div>
            <div className="flex items-end gap-3">
              <div className="flex flex-col gap-1 flex-1">
                <label className="text-xs font-medium text-[var(--ff-text-secondary)]">Notes</label>
                <input type="text" className={INPUT} value={form.notes}
                  onChange={(e) => setField('notes', e.target.value)} placeholder="Optional notes…" />
              </div>
              <button
                type="button"
                onClick={() => void handleAdd()}
                disabled={adding || dateGate.blocked}
                className="inline-flex items-center gap-2 px-4 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Add
              </button>
            </div>
            {addError && (
              <p className="flex items-center gap-1 text-sm text-red-400">
                <AlertCircle className="h-4 w-4 shrink-0" />{addError}
              </p>
            )}
          </div>}

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
              <AlertCircle className="h-4 w-4 shrink-0" />{error}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-12 gap-2 text-[var(--ff-text-tertiary)] text-sm">
              <Loader2 className="h-5 w-5 animate-spin" />Loading…
            </div>
          ) : noAccess ? null : (
            <div className="rounded-xl border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] overflow-x-auto">
              <table className="table-auto w-full">
                <thead>
                  <tr className="bg-slate-50/5">
                    <th className={TH}>Staff member</th>
                    <th className={`${TH} text-right`}>Cost rate/hr</th>
                    <th className={TH}>Currency</th>
                    <th className={TH}>Effective from</th>
                    <th className={TH}>Effective to</th>
                    <th className={TH}>Notes</th>
                    <th className={TH}></th>
                  </tr>
                </thead>
                <tbody>
                  {rates.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-12 text-center text-[var(--ff-text-tertiary)] text-sm">
                        No cost rates configured yet.
                      </td>
                    </tr>
                  ) : rates.map((r, i) => (
                    <tr key={r.id} className={i % 2 === 1 ? 'bg-slate-50/5' : ''}>
                      <td className={`${TD} font-medium text-[var(--ff-text-primary)]`}>{getUserLabel(users, r.userId)}</td>
                      <td className={`${TD} text-right tabular-nums`}>{formatMoney(r.costRate)}</td>
                      <td className={TD}>{r.currency}</td>
                      <td className={TD}>{r.effectiveFrom}</td>
                      <td className={TD}>{r.effectiveTo ?? '—'}</td>
                      <td className={`${TD} text-[var(--ff-text-tertiary)]`}>{r.notes ?? '—'}</td>
                      <td className={TD}>
                        <button
                          type="button"
                          onClick={() => void handleDelete(r.id)}
                          disabled={deletingId === r.id}
                          className="p-1 rounded hover:bg-red-500/10 text-[var(--ff-text-tertiary)] hover:text-red-400 transition-colors disabled:opacity-50"
                          title="Delete"
                        >
                          {deletingId === r.id
                            ? <Loader2 className="h-4 w-4 animate-spin" />
                            : <Trash2 className="h-4 w-4" />}
                        </button>
                      </td>
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
