/**
 * Item Categories Management
 * Sage Parity: Lists > Item Categories
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Tag, Plus, Pencil, Trash2, Loader2, X, Check } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface Category { id: string; name: string; description: string; }

export default function ItemCategoriesPage() {
  const [items, setItems] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', description: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await apiFetch('/api/accounting/item-categories', { credentials: 'include' });
      const json = await res.json();
      setItems(json.data || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load categories');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!form.name.trim()) return;
    setBusy(true);
    setError('');
    try {
      const method = editing ? 'PUT' : 'POST';
      const body = editing ? { id: editing, ...form } : form;
      const res = await apiFetch('/api/accounting/item-categories', {
        method, headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || 'Failed to save');
      setForm({ name: '', description: '' });
      setEditing(null); setAdding(false);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this item category?')) return;
    setError('');
    try {
      const res = await apiFetch('/api/accounting/item-categories', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || 'Failed to delete');
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to delete');
    }
  };

  const startEdit = (cat: Category) => {
    setEditing(cat.id);
    setForm({ name: cat.name, description: cat.description || '' });
    setAdding(false);
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-orange-500/10"><Tag className="h-6 w-6 text-orange-500" /></div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Item Categories</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Organize and classify inventory items</p>
              </div>
            </div>
            {!adding && !editing && (
              <button onClick={() => { setAdding(true); setForm({ name: '', description: '' }); }}
                className="flex items-center gap-2 px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 text-sm font-medium">
                <Plus className="h-4 w-4" /> Add Category
              </button>
            )}
          </div>
        </div>

        <div className="p-6">
          {error && (
            <div className="mb-4 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">{error}</div>
          )}

          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                <th className="px-4 py-3">Name</th><th className="px-4 py-3">Description</th>
                <th className="px-4 py-3 w-24">Actions</th>
              </tr></thead>
              <tbody>
                {(adding || editing) && (
                  <tr className="border-b border-[var(--ff-border-light)] bg-orange-500/5">
                    <td className="px-4 py-2">
                      <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
                        placeholder="Category name" className="w-full px-2 py-1 bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] rounded text-[var(--ff-text-primary)] text-sm" />
                    </td>
                    <td className="px-4 py-2">
                      <input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })}
                        placeholder="Description" className="w-full px-2 py-1 bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] rounded text-[var(--ff-text-primary)] text-sm" />
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-1">
                        <button onClick={save} disabled={busy} className="p-1 text-teal-400 hover:text-teal-300">
                          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                        </button>
                        <button onClick={() => { setAdding(false); setEditing(null); }} className="p-1 text-red-400 hover:text-red-300">
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
                {loading && <tr><td colSpan={3} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">Loading...</td></tr>}
                {!loading && items.length === 0 && !adding && (
                  <tr><td colSpan={3} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">No item categories yet</td></tr>
                )}
                {items.map(cat => editing === cat.id ? null : (
                  <tr key={cat.id} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50">
                    <td className="px-4 py-3 text-[var(--ff-text-primary)] font-medium">{cat.name}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{cat.description || '-'}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <button onClick={() => startEdit(cat)} className="p-1 text-blue-400 hover:text-blue-300"><Pencil className="h-4 w-4" /></button>
                        <button onClick={() => remove(cat.id)} className="p-1 text-red-400 hover:text-red-300"><Trash2 className="h-4 w-4" /></button>
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
