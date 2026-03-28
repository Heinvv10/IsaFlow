/**
 * Cost Centres (Analysis Codes) Page
 * Phase 5: Custom reporting dimensions for GL entries
 * CC1 = Client-level, CC2 = Project-level
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Tag, Plus, Trash2, Loader2, ToggleLeft, ToggleRight, Pencil } from 'lucide-react';
import { ExportCSVButton } from '@/components/shared/ExportCSVButton';
import { apiFetch } from '@/lib/apiFetch';

type CcType = 'cc1' | 'cc2';

interface CostCentre {
  id: string; code: string; name: string;
  description?: string; department?: string; ccType: CcType; isActive: boolean;
}

const TAB_META: Record<CcType, { label: string; description: string }> = {
  cc1: { label: 'CC1 — Client', description: 'Client-level cost centres' },
  cc2: { label: 'CC2 — Project', description: 'Project-level cost centres' },
};

export default function CostCentresPage() {
  const [activeTab, setActiveTab] = useState<CcType>('cc1');
  const [items, setItems] = useState<CostCentre[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [form, setForm] = useState({ code: '', name: '', description: '', department: '' });
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const res = await apiFetch(`/api/accounting/cost-centres?cc_type=${activeTab}`, { credentials: 'include' });
    const json = await res.json();
    setItems(json.data?.items || []);
    setLoading(false);
  }, [activeTab]);

  useEffect(() => { load(); }, [load]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setBusy('save');
    try {
      if (editId) {
        const res = await apiFetch('/api/accounting/cost-centres-action', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ action: 'update', id: editId, ...form }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.message || 'Failed');
      } else {
        const res = await apiFetch('/api/accounting/cost-centres', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ ...form, ccType: activeTab }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.message || 'Failed');
      }
      setShowForm(false); setEditId(null);
      setForm({ code: '', name: '', description: '', department: '' });
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed'); }
    finally { setBusy(''); }
  };

  const startEdit = (cc: CostCentre) => {
    setForm({ code: cc.code, name: cc.name, description: cc.description || '', department: cc.department || '' });
    setEditId(cc.id); setShowForm(true);
  };

  const lowerSearch = search.toLowerCase();
  const filteredItems = items.filter(cc =>
    !search || cc.code.toLowerCase().includes(lowerSearch) || cc.name.toLowerCase().includes(lowerSearch) || (cc.department || '').toLowerCase().includes(lowerSearch)
  );

  const doAction = async (action: string, id: string, extra?: Record<string, unknown>) => {
    setBusy(id);
    try {
      await apiFetch('/api/accounting/cost-centres-action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ action, id, ...extra }),
      });
      await load();
    } catch { /* ignore */ }
    setBusy('');
  };

  const switchTab = (tab: CcType) => {
    setActiveTab(tab);
    setShowForm(false);
    setEditId(null);
    setSearch('');
    setError('');
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-purple-500/10"><Tag className="h-6 w-6 text-purple-500" /></div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Cost Centres</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Reporting dimensions for GL entries</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <ExportCSVButton endpoint="/api/accounting/cost-centres-export" filenamePrefix="cost-centres" label="Export CSV" />
              <button
                onClick={() => { setEditId(null); setForm({ code: '', name: '', description: '', department: '' }); setShowForm(!showForm); }}
                className="inline-flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-sm font-medium">
                <Plus className="h-4 w-4" /> New {TAB_META[activeTab].label.split(' — ')[0]}
              </button>
            </div>
          </div>

          {/* CC1 / CC2 tabs */}
          <div className="flex gap-0 mt-4 -mb-4">
            {(Object.keys(TAB_META) as CcType[]).map(tab => (
              <button
                key={tab}
                onClick={() => switchTab(tab)}
                className={`px-5 py-2 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === tab
                    ? 'border-purple-500 text-purple-400'
                    : 'border-transparent text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]'
                }`}>
                {TAB_META[tab].label}
              </button>
            ))}
          </div>
        </div>

        <div className="p-6 space-y-4">
          {error && <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>}

          <div className="flex items-center gap-3">
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search code, name..."
              className="px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm w-72"
            />
            <span className="text-sm text-[var(--ff-text-secondary)]">{filteredItems.length} {TAB_META[activeTab].description}</span>
          </div>

          {showForm && (
            <form onSubmit={handleSubmit} className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6 space-y-4">
              <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">
                {editId ? 'Edit' : 'New'} {TAB_META[activeTab].label}
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <input value={form.code} onChange={e => setForm(f => ({ ...f, code: e.target.value }))} className="ff-input" placeholder="Code (e.g. CC-001) *" required />
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="ff-input" placeholder="Name *" required />
                <input value={form.department} onChange={e => setForm(f => ({ ...f, department: e.target.value }))} className="ff-input" placeholder="Department (optional)" />
                <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className="ff-input" placeholder="Description (optional)" />
              </div>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => { setShowForm(false); setEditId(null); }} className="px-4 py-2 text-sm text-[var(--ff-text-secondary)]">Cancel</button>
                <button type="submit" disabled={busy === 'save'} className="px-6 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">
                  {busy === 'save' ? <Loader2 className="h-4 w-4 animate-spin" /> : editId ? 'Update' : 'Create'}
                </button>
              </div>
            </form>
          )}

          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                <th className="px-4 py-3">Code</th><th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Department</th><th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Actions</th>
              </tr></thead>
              <tbody>
                {loading && <tr><td colSpan={5} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">Loading...</td></tr>}
                {!loading && filteredItems.length === 0 && (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">
                    {search ? 'No matching cost centres' : `No ${TAB_META[activeTab].description}. Create one above.`}
                  </td></tr>
                )}
                {filteredItems.map(cc => (
                  <tr key={cc.id} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50">
                    <td className="px-4 py-3 font-mono text-purple-400 font-medium">{cc.code}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-primary)]">{cc.name}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{cc.department || '—'}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${cc.isActive ? 'bg-teal-500/10 text-teal-400' : 'bg-gray-500/10 text-gray-400'}`}>
                        {cc.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <button onClick={() => startEdit(cc)} className="p-1 text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]" title="Edit">
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button onClick={() => doAction('toggle', cc.id, { isActive: !cc.isActive })} disabled={busy === cc.id} className="p-1 text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]" title={cc.isActive ? 'Disable' : 'Enable'}>
                          {cc.isActive ? <ToggleRight className="h-4 w-4 text-teal-400" /> : <ToggleLeft className="h-4 w-4" />}
                        </button>
                        <button onClick={() => doAction('delete', cc.id)} disabled={busy === cc.id} className="p-1 text-red-400 hover:text-red-300" title="Delete">
                          {busy === cc.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
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
