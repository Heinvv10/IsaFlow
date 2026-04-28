// ClientRateOverrides — per-staff billing rate overrides for a practice client.
import { useState, useEffect, useCallback } from 'react';
import { DollarSign, Plus, Trash2, Loader2, AlertCircle } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { localISODate } from '@/lib/dateUtils';

interface RateOverride {
  id: string;
  staffUserId: string;
  ratePerHour: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  notes: string | null;
  staffEmail: string | null;
  staffName: string | null;
}

interface StaffMember {
  userId: string;
  email: string | null;
  fullName: string | null;
}

interface AddFormState {
  staffUserId: string;
  ratePerHour: string;
  effectiveFrom: string;
  effectiveTo: string;
  notes: string;
}

const today = localISODate();
const EMPTY_FORM: AddFormState = { staffUserId: '', ratePerHour: '', effectiveFrom: today, effectiveTo: '', notes: '' };

function staffLabel(s: StaffMember): string {
  return s.fullName ? `${s.fullName} (${s.email ?? ''})` : (s.email ?? s.userId);
}

interface Props {
  clientId: string;
}

export function ClientRateOverrides({ clientId }: Props) {
  const [overrides, setOverrides] = useState<RateOverride[]>([]);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<AddFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const baseUrl = `/api/accounting/practice/clients/${clientId}`;

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [overridesRes, staffRes] = await Promise.all([
        apiFetch(`${baseUrl}/rate-overrides`),
        apiFetch(`${baseUrl}/staff`),
      ]);
      if (overridesRes.ok) {
        const json = await overridesRes.json() as { data?: RateOverride[] } | RateOverride[];
        setOverrides(('data' in json ? json.data : json) as RateOverride[] ?? []);
      }
      if (staffRes.ok) {
        const json = await staffRes.json() as { data?: StaffMember[] } | StaffMember[];
        setStaff(('data' in json ? json.data : json) as StaffMember[] ?? []);
      }
    } catch {
      setError('Failed to load rate overrides');
    } finally {
      setLoading(false);
    }
  }, [baseUrl]);

  useEffect(() => { void loadData(); }, [loadData]);

  const handleAdd = async () => {
    setFormError('');
    if (!form.staffUserId) { setFormError('Select a staff member'); return; }
    if (!form.ratePerHour || Number(form.ratePerHour) < 0) { setFormError('Enter a valid rate'); return; }
    if (!form.effectiveFrom) { setFormError('Effective from date is required'); return; }

    setSaving(true);
    try {
      const res = await apiFetch(`${baseUrl}/rate-overrides`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          staffUserId: form.staffUserId,
          ratePerHour: Number(form.ratePerHour),
          effectiveFrom: form.effectiveFrom,
          effectiveTo: form.effectiveTo || null,
          notes: form.notes || null,
        }),
      });
      if (!res.ok) {
        const json = await res.json() as { error?: { message?: string }; message?: string };
        throw new Error(json.error?.message ?? json.message ?? `HTTP ${res.status}`);
      }
      setShowForm(false);
      setForm(EMPTY_FORM);
      await loadData();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await apiFetch(`${baseUrl}/rate-overrides?overrideId=${id}`, { method: 'DELETE' });
      await loadData();
    } catch {
      setError('Failed to delete override');
    } finally {
      setDeletingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-teal-400" />
      </div>
    );
  }

  return (
    <div>
      {error && (
        <div className="flex items-center gap-2 text-red-400 text-sm mb-4">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      )}

      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-[var(--ff-text-secondary)]">
          Override the default hourly rate for specific staff members on this client.
        </p>
        <button
          onClick={() => { setShowForm(true); setFormError(''); }}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          Add Override
        </button>
      </div>

      {showForm && (
        <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-tertiary)] p-4 mb-4">
          <h3 className="text-sm font-semibold text-[var(--ff-text-primary)] mb-3">New Rate Override</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-[var(--ff-text-secondary)] mb-1">Staff Member *</label>
              <select
                value={form.staffUserId}
                onChange={(e) => setForm((f) => ({ ...f, staffUserId: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] text-sm text-[var(--ff-text-primary)] focus:outline-none focus:ring-1 focus:ring-teal-500"
              >
                <option value="">Select staff member…</option>
                {staff.map((s) => (
                  <option key={s.userId} value={s.userId}>{staffLabel(s)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-[var(--ff-text-secondary)] mb-1">Rate per Hour (R) *</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.ratePerHour}
                onChange={(e) => setForm((f) => ({ ...f, ratePerHour: e.target.value }))}
                placeholder="0.00"
                className="w-full px-3 py-2 rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] text-sm text-[var(--ff-text-primary)] focus:outline-none focus:ring-1 focus:ring-teal-500"
              />
            </div>
            <div>
              <label className="block text-xs text-[var(--ff-text-secondary)] mb-1">Effective From *</label>
              <input
                type="date"
                value={form.effectiveFrom}
                onChange={(e) => setForm((f) => ({ ...f, effectiveFrom: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] text-sm text-[var(--ff-text-primary)] focus:outline-none focus:ring-1 focus:ring-teal-500"
              />
            </div>
            <div>
              <label className="block text-xs text-[var(--ff-text-secondary)] mb-1">Effective To</label>
              <input
                type="date"
                value={form.effectiveTo}
                onChange={(e) => setForm((f) => ({ ...f, effectiveTo: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] text-sm text-[var(--ff-text-primary)] focus:outline-none focus:ring-1 focus:ring-teal-500"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs text-[var(--ff-text-secondary)] mb-1">Notes</label>
              <input
                type="text"
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                placeholder="Optional notes…"
                className="w-full px-3 py-2 rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] text-sm text-[var(--ff-text-primary)] focus:outline-none focus:ring-1 focus:ring-teal-500"
              />
            </div>
          </div>
          {formError && (
            <p className="mt-2 text-xs text-red-400">{formError}</p>
          )}
          <div className="flex gap-2 mt-3">
            <button
              onClick={() => void handleAdd()}
              disabled={saving}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-sm font-medium transition-colors"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Save
            </button>
            <button
              onClick={() => { setShowForm(false); setForm(EMPTY_FORM); setFormError(''); }}
              className="px-3 py-1.5 rounded-lg border border-[var(--ff-border-primary)] text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {overrides.length === 0 ? (
        <div className="text-center py-12">
          <DollarSign className="h-8 w-8 text-[var(--ff-text-tertiary)] mx-auto mb-2" />
          <p className="text-sm text-[var(--ff-text-secondary)]">No rate overrides yet</p>
          <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">
            Default rate profile rates will apply for all staff.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-[var(--ff-border-primary)] overflow-hidden bg-[var(--ff-bg-secondary)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-tertiary)]">
                <th className="text-left py-3 px-4 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Staff Member</th>
                <th className="text-right py-3 px-4 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Rate/Hour</th>
                <th className="text-left py-3 px-4 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Effective From</th>
                <th className="text-left py-3 px-4 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Effective To</th>
                <th className="text-left py-3 px-4 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Notes</th>
                <th className="py-3 px-4" />
              </tr>
            </thead>
            <tbody>
              {overrides.map((o) => (
                <tr key={o.id} className="border-b border-[var(--ff-border-primary)] last:border-0">
                  <td className="py-3 px-4">
                    <span className="font-medium text-[var(--ff-text-primary)]">
                      {o.staffName ?? o.staffEmail ?? o.staffUserId}
                    </span>
                    {o.staffName && o.staffEmail && (
                      <span className="block text-xs text-[var(--ff-text-tertiary)]">{o.staffEmail}</span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-right font-mono text-[var(--ff-text-primary)]">
                    R {Number(o.ratePerHour).toFixed(2)}
                  </td>
                  <td className="py-3 px-4 text-[var(--ff-text-secondary)]">{o.effectiveFrom}</td>
                  <td className="py-3 px-4 text-[var(--ff-text-secondary)]">{o.effectiveTo ?? '—'}</td>
                  <td className="py-3 px-4 text-[var(--ff-text-secondary)] max-w-xs truncate">{o.notes ?? '—'}</td>
                  <td className="py-3 px-4">
                    <button
                      onClick={() => void handleDelete(o.id)}
                      disabled={deletingId === o.id}
                      className="p-1 rounded text-[var(--ff-text-tertiary)] hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                      title="Delete override"
                    >
                      {deletingId === o.id
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <Trash2 className="h-3.5 w-3.5" />
                      }
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
