/**
 * Cost Centres — list, inline create, toggle active.
 * Route: /payroll/cost-centres
 */
import { useEffect, useState, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { Building2, Loader2, AlertCircle, Plus, Check, X } from 'lucide-react';

interface CostCentre {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  isActive: boolean;
  notes: string | null;
}

interface Mapping {
  costCentreId: string;
  expenseAccountId: string;
  accountCode: string;
  accountName: string;
}

interface GlAccount {
  id: string;
  accountCode: string;
  accountName: string;
  accountType: string;
}

export default function CostCentresPage() {
  const [rows, setRows] = useState<CostCentre[]>([]);
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [accounts, setAccounts] = useState<GlAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showInactive, setShowInactive] = useState(false);

  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editCode, setEditCode] = useState('');
  const [editName, setEditName] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const qs = showInactive ? '' : '?activeOnly=1';
      const [ccRes, mapRes, acctRes] = await Promise.all([
        apiFetch(`/api/payroll/cost-centres${qs}`),
        apiFetch('/api/payroll/cost-centres/gl-mappings'),
        apiFetch('/api/accounting/chart-of-accounts'),
      ]);
      if (!ccRes.ok) throw new Error(`HTTP ${ccRes.status}`);
      const ccJson = await ccRes.json();
      setRows((ccJson.data ?? ccJson) as CostCentre[]);
      if (mapRes.ok) {
        const j = await mapRes.json();
        setMappings(((j.data ?? j) as Mapping[]) ?? []);
      }
      if (acctRes.ok) {
        const j = await acctRes.json();
        const all = ((j.data ?? j) as GlAccount[]) ?? [];
        setAccounts(all.filter(a => a.accountType === 'expense'));
      }
    } catch {
      setError('Failed to load cost centres');
    } finally {
      setLoading(false);
    }
  }, [showInactive]);

  async function setMapping(costCentreId: string, expenseAccountId: string | ''): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const res = expenseAccountId === ''
        ? await apiFetch(`/api/payroll/cost-centres/${costCentreId}/gl-mapping`, { method: 'DELETE' })
        : await apiFetch(`/api/payroll/cost-centres/${costCentreId}/gl-mapping`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ expenseAccountId }),
          });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error?.message ?? j.message ?? 'GL mapping save failed');
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void load(); }, [load]);

  async function create(): Promise<void> {
    if (!newCode.trim() || !newName.trim()) {
      setError('Code and name required');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await apiFetch('/api/payroll/cost-centres', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: newCode.trim(), name: newName.trim() }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json.error?.message ?? json.message ?? 'Create failed');
        return;
      }
      setNewCode('');
      setNewName('');
      await load();
    } finally {
      setBusy(false);
    }
  }

  function startEdit(cc: CostCentre): void {
    setEditingId(cc.id);
    setEditCode(cc.code);
    setEditName(cc.name);
  }

  async function saveEdit(id: string): Promise<void> {
    setBusy(true);
    try {
      const res = await apiFetch(`/api/payroll/cost-centres/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: editCode.trim(), name: editName.trim() }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json.error?.message ?? json.message ?? 'Save failed');
      } else {
        setEditingId(null);
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(cc: CostCentre): Promise<void> {
    setBusy(true);
    try {
      if (cc.isActive) {
        await apiFetch(`/api/payroll/cost-centres/${cc.id}`, { method: 'DELETE' });
      } else {
        await apiFetch(`/api/payroll/cost-centres/${cc.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isActive: true }),
        });
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-sky-500/10"><Building2 className="h-6 w-6 text-sky-500" /></div>
            <div>
              <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Cost Centres</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">Group employees for cross-run reporting</p>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-[var(--ff-text-secondary)]">
            <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
            Show inactive
          </label>
        </div>

        <div className="p-6 space-y-4 max-w-5xl">
          {error && <div className="flex items-center gap-2 text-sm text-red-400 bg-red-500/10 rounded-lg p-3"><AlertCircle className="h-4 w-4" />{error}</div>}

          <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-4">
            <div className="text-sm font-medium text-[var(--ff-text-primary)] mb-3">Add a cost centre</div>
            <div className="grid gap-2" style={{ gridTemplateColumns: '1fr 2fr auto' }}>
              <input value={newCode} onChange={e => setNewCode(e.target.value)} placeholder="Code (e.g. ADMIN)"
                className="rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] text-sm px-3 py-2 text-[var(--ff-text-primary)] font-mono" />
              <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Name"
                className="rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] text-sm px-3 py-2 text-[var(--ff-text-primary)]" />
              <button onClick={create} disabled={busy}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-medium disabled:opacity-50">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add
              </button>
            </div>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-sky-500" /></div>
          ) : rows.length === 0 ? (
            <div className="text-center py-12">
              <Building2 className="h-12 w-12 text-[var(--ff-text-tertiary)] mx-auto mb-3" />
              <p className="text-[var(--ff-text-secondary)]">No cost centres yet</p>
            </div>
          ) : (
            <div className="rounded-lg border border-[var(--ff-border-primary)] overflow-hidden bg-[var(--ff-surface-primary)]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] text-left">
                    <th className="py-2 px-3 font-medium text-[var(--ff-text-secondary)]">Code</th>
                    <th className="py-2 px-3 font-medium text-[var(--ff-text-secondary)]">Name</th>
                    <th className="py-2 px-3 font-medium text-[var(--ff-text-secondary)]">GL expense account</th>
                    <th className="py-2 px-3 font-medium text-[var(--ff-text-secondary)]">Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map(cc => {
                    const editing = editingId === cc.id;
                    return (
                      <tr key={cc.id} className="border-b border-[var(--ff-border-primary)] last:border-0">
                        <td className="py-2 px-3 font-mono text-[var(--ff-text-primary)]">
                          {editing ? (
                            <input value={editCode} onChange={e => setEditCode(e.target.value)}
                              className="rounded bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] text-sm px-2 py-1 w-28" />
                          ) : cc.code}
                        </td>
                        <td className="py-2 px-3 text-[var(--ff-text-primary)]">
                          {editing ? (
                            <input value={editName} onChange={e => setEditName(e.target.value)}
                              className="rounded bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] text-sm px-2 py-1 w-full" />
                          ) : cc.name}
                        </td>
                        <td className="py-2 px-3 text-[var(--ff-text-primary)]">
                          <select
                            value={mappings.find(m => m.costCentreId === cc.id)?.expenseAccountId ?? ''}
                            onChange={e => setMapping(cc.id, e.target.value)}
                            disabled={busy || accounts.length === 0}
                            className="rounded bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] text-xs px-2 py-1 text-[var(--ff-text-primary)] min-w-[14rem]"
                          >
                            <option value="">(fallback — default)</option>
                            {accounts.map(a => (
                              <option key={a.id} value={a.id}>{a.accountCode} — {a.accountName}</option>
                            ))}
                          </select>
                        </td>
                        <td className="py-2 px-3">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cc.isActive ? 'bg-emerald-500/10 text-emerald-400' : 'bg-gray-500/10 text-gray-400'}`}>
                            {cc.isActive ? 'active' : 'inactive'}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-right">
                          {editing ? (
                            <div className="inline-flex gap-1">
                              <button onClick={() => saveEdit(cc.id)} disabled={busy}
                                className="p-1 rounded hover:bg-[var(--ff-bg-tertiary)]"><Check className="h-4 w-4 text-emerald-500" /></button>
                              <button onClick={() => setEditingId(null)} disabled={busy}
                                className="p-1 rounded hover:bg-[var(--ff-bg-tertiary)]"><X className="h-4 w-4 text-red-500" /></button>
                            </div>
                          ) : (
                            <div className="inline-flex gap-3">
                              <button onClick={() => startEdit(cc)} className="text-xs text-sky-400 hover:text-sky-300">Edit</button>
                              <button onClick={() => toggleActive(cc)} className="text-xs text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">
                                {cc.isActive ? 'Deactivate' : 'Reactivate'}
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
