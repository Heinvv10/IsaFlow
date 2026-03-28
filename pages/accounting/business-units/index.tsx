/**
 * Business Units Page
 * CRUD for departments used as BU dimension on bank transactions and GL journal lines
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Building2, Plus, Loader2, ToggleLeft, ToggleRight, Pencil } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface BusinessUnit {
  id: string;
  name: string;
  code: string;
  description?: string;
  isActive: boolean;
  staffCount?: number;
}

export default function BusinessUnitsPage() {
  const [items, setItems] = useState<BusinessUnit[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [form, setForm] = useState({ name: '', code: '', description: '' });
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const res = await apiFetch('/api/departments', { credentials: 'include' });
    const json = await res.json();
    const rows: BusinessUnit[] = (json.data || []).map((d: BusinessUnit) => ({
      id: d.id, name: d.name, code: d.code,
      description: d.description, isActive: d.isActive,
      staffCount: d.staffCount,
    }));
    setItems(rows);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setBusy('save');
    try {
      if (editId) {
        const res = await apiFetch(`/api/departments/${editId}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ name: form.name, code: form.code, description: form.description }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.message || 'Failed');
      } else {
        const res = await apiFetch('/api/departments', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ name: form.name, code: form.code, description: form.description }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.message || 'Failed');
      }
      setShowForm(false); setEditId(null);
      setForm({ name: '', code: '', description: '' });
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed'); }
    finally { setBusy(''); }
  };

  const startEdit = (bu: BusinessUnit) => {
    setForm({ name: bu.name, code: bu.code, description: bu.description || '' });
    setEditId(bu.id); setShowForm(true);
  };

  const toggleActive = async (bu: BusinessUnit) => {
    setBusy(bu.id);
    try {
      await apiFetch(`/api/departments/${bu.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ isActive: !bu.isActive }),
      });
      await load();
    } catch { /* ignore */ }
    setBusy('');
  };

  const lowerSearch = search.toLowerCase();
  const filteredItems = items.filter(bu =>
    !search ||
    bu.name.toLowerCase().includes(lowerSearch) ||
    bu.code.toLowerCase().includes(lowerSearch) ||
    (bu.description || '').toLowerCase().includes(lowerSearch)
  );

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-500/10"><Building2 className="h-6 w-6 text-blue-500" /></div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Business Units</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Departments used as BU dimension on GL entries</p>
              </div>
            </div>
            <button
              onClick={() => { setEditId(null); setForm({ name: '', code: '', description: '' }); setShowForm(!showForm); }}
              className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium">
              <Plus className="h-4 w-4" /> New Business Unit
            </button>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {error && <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>}

          <div className="flex items-center gap-3">
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search name or code..."
              className="px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm w-72"
            />
            <span className="text-sm text-[var(--ff-text-secondary)]">{filteredItems.length} business units</span>
          </div>

          {showForm && (
            <form onSubmit={handleSubmit} className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6 space-y-4">
              <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">{editId ? 'Edit' : 'New'} Business Unit</h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="ff-input" placeholder="Name *" required />
                <input value={form.code} onChange={e => setForm(f => ({ ...f, code: e.target.value }))} className="ff-input" placeholder="Code (e.g. FIN) *" required />
                <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className="ff-input" placeholder="Description (optional)" />
              </div>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => { setShowForm(false); setEditId(null); }} className="px-4 py-2 text-sm text-[var(--ff-text-secondary)]">Cancel</button>
                <button type="submit" disabled={busy === 'save'} className="px-6 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">
                  {busy === 'save' ? <Loader2 className="h-4 w-4 animate-spin" /> : editId ? 'Update' : 'Create'}
                </button>
              </div>
            </form>
          )}

          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                <th className="px-4 py-3">Code</th>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Description</th>
                <th className="px-4 py-3">Staff</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Actions</th>
              </tr></thead>
              <tbody>
                {loading && <tr><td colSpan={6} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">Loading...</td></tr>}
                {!loading && filteredItems.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">
                    {search ? 'No matching business units' : 'No business units yet.'}
                  </td></tr>
                )}
                {filteredItems.map(bu => (
                  <tr key={bu.id} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50">
                    <td className="px-4 py-3 font-mono text-blue-400 font-medium">{bu.code}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-primary)]">{bu.name}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)] text-xs">{bu.description || '—'}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{bu.staffCount ?? '—'}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${bu.isActive ? 'bg-teal-500/10 text-teal-400' : 'bg-gray-500/10 text-gray-400'}`}>
                        {bu.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <button onClick={() => startEdit(bu)} className="p-1 text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]" title="Edit">
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button onClick={() => toggleActive(bu)} disabled={busy === bu.id} className="p-1 text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]" title={bu.isActive ? 'Disable' : 'Enable'}>
                          {busy === bu.id
                            ? <Loader2 className="h-4 w-4 animate-spin" />
                            : bu.isActive
                              ? <ToggleRight className="h-4 w-4 text-teal-400" />
                              : <ToggleLeft className="h-4 w-4" />
                          }
                        </button>
                      </div>
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
