/**
 * Accounting Adjustments Page
 * Phase 1 Sage Alignment: Customer & supplier balance adjustments
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { SlidersHorizontal, Plus, Check, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface Adjustment {
  id: string; adjustmentNumber: string; entityType: string; entityId: string;
  entityName?: string; adjustmentType: string; amount: number; reason: string;
  adjustmentDate: string; status: string;
}
interface Entity { id: string; company_name: string }

const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const STATUS_BADGE: Record<string, string> = {
  draft: 'bg-gray-500/10 text-gray-400',
  approved: 'bg-teal-500/10 text-teal-400',
  cancelled: 'bg-red-500/10 text-red-400',
};

export default function AdjustmentsPage() {
  const router = useRouter();
  const entityType = (router.query.type as string) || 'customer';
  const [items, setItems] = useState<Adjustment[]>([]);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [form, setForm] = useState({ entityId: '', adjustmentType: 'debit', amount: '', reason: '' });

  const load = useCallback(async () => {
    setLoading(true);
    const res = await apiFetch(`/api/accounting/adjustments?entityType=${entityType}`, { credentials: 'include' });
    const json = await res.json();
    setItems(json.data?.items || []);
    setLoading(false);
  }, [entityType]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const url = entityType === 'supplier' ? '/api/suppliers' : '/api/clients';
    apiFetch(url).then(r => r.json()).then(res => {
      const d = res.data || res;
      setEntities(Array.isArray(d) ? d : d.clients || d.suppliers || []);
    });
  }, [entityType]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setBusy('new');
    try {
      const res = await apiFetch('/api/accounting/adjustments', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ entityType, entityId: form.entityId, adjustmentType: form.adjustmentType, amount: Number(form.amount), reason: form.reason }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed');
      setShowForm(false);
      setForm({ entityId: '', adjustmentType: 'debit', amount: '', reason: '' });
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed'); }
    finally { setBusy(''); }
  };

  const approve = async (id: string) => {
    setBusy(id);
    await apiFetch('/api/accounting/adjustments-action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'include', body: JSON.stringify({ action: 'approve', id }),
    });
    await load(); setBusy('');
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-amber-500/10"><SlidersHorizontal className="h-6 w-6 text-amber-500" /></div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">{entityType === 'supplier' ? 'Supplier' : 'Customer'} Adjustments</h1>
            </div>
            <button onClick={() => setShowForm(!showForm)} className="inline-flex items-center gap-2 px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 text-sm font-medium">
              <Plus className="h-4 w-4" /> New Adjustment
            </button>
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={() => router.push('/accounting/adjustments?type=customer')} className={`px-4 py-2 rounded text-sm ${entityType === 'customer' ? 'bg-amber-600 text-white' : 'text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]'}`}>Customer</button>
            <button onClick={() => router.push('/accounting/adjustments?type=supplier')} className={`px-4 py-2 rounded text-sm ${entityType === 'supplier' ? 'bg-amber-600 text-white' : 'text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]'}`}>Supplier</button>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {error && <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>}

          {showForm && (
            <form onSubmit={handleSubmit} className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6 space-y-4">
              <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">New {entityType === 'supplier' ? 'Supplier' : 'Customer'} Adjustment</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <select value={form.entityId} onChange={e => setForm(f => ({ ...f, entityId: e.target.value }))} className="ff-select" required>
                  <option value="">Select {entityType === 'supplier' ? 'Supplier' : 'Client'} *</option>
                  {entities.map(e => <option key={e.id} value={e.id}>{e.company_name}</option>)}
                </select>
                <select value={form.adjustmentType} onChange={e => setForm(f => ({ ...f, adjustmentType: e.target.value }))} className="ff-select">
                  <option value="debit">Debit (Increase Balance)</option>
                  <option value="credit">Credit (Decrease Balance)</option>
                </select>
                <input type="number" step="0.01" min="0.01" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} className="ff-input" placeholder="Amount *" required />
                <input value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} className="ff-input" placeholder="Reason *" required />
              </div>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 text-sm text-[var(--ff-text-secondary)]">Cancel</button>
                <button type="submit" disabled={busy === 'new'} className="px-6 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">
                  {busy === 'new' ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create Adjustment'}
                </button>
              </div>
            </form>
          )}

          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                <th className="px-4 py-3">ADJ Number</th><th className="px-4 py-3">{entityType === 'supplier' ? 'Supplier' : 'Client'}</th>
                <th className="px-4 py-3">Type</th><th className="px-4 py-3 text-right">Amount</th>
                <th className="px-4 py-3">Reason</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Actions</th>
              </tr></thead>
              <tbody>
                {loading && <tr><td colSpan={7} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">Loading...</td></tr>}
                {!loading && items.length === 0 && <tr><td colSpan={7} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">No adjustments</td></tr>}
                {items.map(item => (
                  <tr key={item.id} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50">
                    <td className="px-4 py-3 text-[var(--ff-text-primary)] font-medium">{item.adjustmentNumber}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{item.entityName || '—'}</td>
                    <td className="px-4 py-3"><span className={`px-2 py-0.5 rounded text-xs font-medium ${item.adjustmentType === 'debit' ? 'bg-blue-500/10 text-blue-400' : 'bg-orange-500/10 text-orange-400'}`}>{item.adjustmentType}</span></td>
                    <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">{fmt(item.amount)}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)] truncate max-w-[200px]">{item.reason}</td>
                    <td className="px-4 py-3"><span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_BADGE[item.status] || ''}`}>{item.status}</span></td>
                    <td className="px-4 py-3">
                      {item.status === 'draft' && (
                        <button onClick={() => approve(item.id)} disabled={busy === item.id} className="p-1 text-teal-400 hover:text-teal-300" title="Approve">
                          {busy === item.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
