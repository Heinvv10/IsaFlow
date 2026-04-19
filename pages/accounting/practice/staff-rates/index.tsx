/**
 * Staff Billable Rates Admin
 * Route: /accounting/practice/staff-rates
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { DollarSign, Loader2, AlertCircle, Plus } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import type { CompanyUserSummary } from '@/modules/accounting/services/practice/practiceUsersService';
import type { StaffRate } from '@/modules/accounting/services/practice/practiceStaffRateService';

const INPUT = 'rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-tertiary)] px-3 py-1.5 text-sm text-[var(--ff-text-primary)] focus:outline-none focus:ring-2 focus:ring-teal-500/40 w-full';
const TH = 'text-left py-2 px-3 text-[10px] tracking-widest font-semibold text-[var(--ff-text-secondary)] uppercase';
const TD = 'py-2.5 px-3 text-sm text-[var(--ff-text-secondary)]';

function todayIso() { return new Date().toISOString().slice(0, 10); }

interface FormState {
  userId: string;
  rate: string;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string;
}

const EMPTY_FORM: FormState = {
  userId: '',
  rate: '',
  currency: 'ZAR',
  effectiveFrom: todayIso(),
  effectiveTo: '',
};

export default function StaffRatesPage() {
  const [users, setUsers] = useState<CompanyUserSummary[]>([]);
  const [selectedUser, setSelectedUser] = useState('');
  const [rates, setRates] = useState<StaffRate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/accounting/practice/users');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { data?: CompanyUserSummary[] };
      const list = json.data ?? [];
      setUsers(list);
      if (list[0]) {
        setSelectedUser(list[0].id);
        setForm((f) => ({ ...f, userId: list[0]!.id }));
      }
    } catch {
      setError('Failed to load users');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadRates = useCallback(async (userId: string) => {
    if (!userId) return;
    try {
      const res = await apiFetch(`/api/accounting/practice/staff-rates?userId=${userId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { data?: StaffRate[] };
      setRates(json.data ?? []);
    } catch {
      setRates([]);
    }
  }, []);

  useEffect(() => { void loadUsers(); }, [loadUsers]);
  useEffect(() => { void loadRates(selectedUser); }, [selectedUser, loadRates]);

  const handleUserChange = (userId: string) => {
    setSelectedUser(userId);
    setForm((f) => ({ ...f, userId }));
  };

  const handleAdd = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (!form.userId || !form.rate || !form.effectiveFrom) {
      setAddError('User, rate, and effective from date are required');
      return;
    }
    setAdding(true);
    setAddError(null);
    try {
      const res = await apiFetch('/api/accounting/practice/staff-rates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: form.userId,
          rate: Number(form.rate),
          currency: form.currency,
          effectiveFrom: form.effectiveFrom,
          effectiveTo: form.effectiveTo || undefined,
        }),
      });
      if (!res.ok) {
        const j = await res.json() as { message?: string };
        throw new Error(j.message ?? `HTTP ${res.status}`);
      }
      setForm((f) => ({ ...EMPTY_FORM, userId: f.userId, currency: f.currency }));
      await loadRates(selectedUser);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Failed to add rate');
    } finally {
      setAdding(false);
    }
  };

  const fmtDate = (d: string) => d ? new Date(d).toLocaleDateString('en-ZA') : '—';
  const fmtRate = (r: number, currency: string) =>
    `${currency} ${r.toLocaleString('en-ZA', { minimumFractionDigits: 2 })} /hr`;

  return (
    <AppLayout>
      <div className="max-w-3xl mx-auto px-6 py-10">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 rounded-lg bg-teal-500/10">
            <DollarSign className="w-5 h-5 text-teal-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-[var(--ff-text-primary)]">Staff Billable Rates</h1>
            <p className="text-sm text-[var(--ff-text-secondary)]">Set hourly billing rates per staff member</p>
          </div>
        </div>

        {loading && (
          <div className="flex items-center justify-center py-16 text-[var(--ff-text-secondary)]">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 p-4 rounded-lg bg-red-500/10 text-red-400 text-sm mb-6">
            <AlertCircle className="w-4 h-4 shrink-0" /> {error}
          </div>
        )}

        {!loading && !error && (
          <>
            {/* User selector */}
            <div className="mb-6">
              <label className="block text-xs font-semibold text-[var(--ff-text-secondary)] mb-1">Select Staff Member</label>
              <select
                value={selectedUser}
                onChange={(e) => handleUserChange(e.target.value)}
                className={INPUT + ' max-w-xs'}
              >
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{u.displayName}</option>
                ))}
              </select>
            </div>

            {/* Rate history */}
            <div className="rounded-xl border border-[var(--ff-border-primary)] overflow-hidden mb-6">
              <table className="w-full">
                <thead className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
                  <tr>
                    <th className={TH}>Rate</th>
                    <th className={TH}>Effective From</th>
                    <th className={TH}>Effective To</th>
                    <th className={TH}>Added</th>
                  </tr>
                </thead>
                <tbody>
                  {rates.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="py-8 text-center text-sm text-[var(--ff-text-secondary)]">
                        No rates set for this staff member
                      </td>
                    </tr>
                  ) : rates.map((r) => (
                    <tr key={r.id} className="border-b border-[var(--ff-border-primary)] last:border-0">
                      <td className={TD + ' font-medium text-[var(--ff-text-primary)]'}>{fmtRate(r.rate, r.currency)}</td>
                      <td className={TD}>{fmtDate(r.effectiveFrom)}</td>
                      <td className={TD}>{r.effectiveTo ? fmtDate(r.effectiveTo) : <span className="text-teal-400 text-xs">Current</span>}</td>
                      <td className={TD}>{fmtDate(r.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Add form */}
            <form onSubmit={(e) => { void handleAdd(e); }} className="rounded-xl border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] p-5">
              <h2 className="text-sm font-semibold text-[var(--ff-text-primary)] mb-4 flex items-center gap-2">
                <Plus className="w-4 h-4" /> Add Rate
              </h2>

              {addError && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-4">
                  <AlertCircle className="w-4 h-4 shrink-0" /> {addError}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Hourly Rate</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.rate}
                    onChange={(e) => setForm((f) => ({ ...f, rate: e.target.value }))}
                    placeholder="e.g. 850.00"
                    className={INPUT}
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Currency</label>
                  <select
                    value={form.currency}
                    onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}
                    className={INPUT}
                  >
                    <option value="ZAR">ZAR</option>
                    <option value="USD">USD</option>
                    <option value="EUR">EUR</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Effective From</label>
                  <input
                    type="date"
                    value={form.effectiveFrom}
                    onChange={(e) => setForm((f) => ({ ...f, effectiveFrom: e.target.value }))}
                    className={INPUT}
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Effective To (optional)</label>
                  <input
                    type="date"
                    value={form.effectiveTo}
                    onChange={(e) => setForm((f) => ({ ...f, effectiveTo: e.target.value }))}
                    className={INPUT}
                  />
                </div>
              </div>

              <div className="flex justify-end mt-4">
                <button
                  type="submit"
                  disabled={adding}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium disabled:opacity-50"
                >
                  {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                  {adding ? 'Saving…' : 'Add Rate'}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </AppLayout>
  );
}
