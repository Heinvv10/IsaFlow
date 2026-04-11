/**
 * BundleEditor — manage bundle component lines for an item.
 * Add/remove/reorder child items with quantities; save via API.
 */
'use client';

import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, Save, Loader2, Search } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface ItemOption {
  id: string;
  code: string | null;
  description: string | null;
  unit: string | null;
  selling_price_excl: number | null;
}

interface BundleLine {
  child_item_id: string;
  child_code: string | null;
  child_description: string | null;
  child_unit: string | null;
  child_selling_price_excl: number | null;
  quantity: number;
}

interface Props {
  itemId: string;
  parentDescription?: string;
  onSaved?: () => void;
}

const fmt = (n: number | null | undefined) =>
  n != null ? new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(Number(n)) : '—';

export function BundleEditor({ itemId, parentDescription, onSaved }: Props) {
  const [lines, setLines] = useState<BundleLine[]>([]);
  const [allItems, setAllItems] = useState<ItemOption[]>([]);
  const [search, setSearch] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const loadBundleLines = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/api/accounting/item-bundles?itemId=${itemId}`);
      const json = await res.json() as { data?: BundleLine[] };
      setLines(json.data ?? []);
    } catch { setError('Failed to load bundle lines'); }
    finally { setLoading(false); }
  }, [itemId]);

  const loadItems = useCallback(async () => {
    try {
      const res = await apiFetch('/api/accounting/items?active=true');
      const json = await res.json() as { data?: ItemOption[] };
      setAllItems((json.data ?? []).filter((it) => it.id !== itemId));
    } catch { setAllItems([]); }
  }, [itemId]);

  useEffect(() => { void loadBundleLines(); void loadItems(); }, [loadBundleLines, loadItems]);

  const filtered = allItems
    .filter((it) => !lines.some((l) => l.child_item_id === it.id))
    .filter((it) => {
      if (!search) return true;
      const s = search.toLowerCase();
      return (it.code ?? '').toLowerCase().includes(s) || (it.description ?? '').toLowerCase().includes(s);
    });

  const addItem = (item: ItemOption) => {
    setLines((p) => [...p, {
      child_item_id: item.id, child_code: item.code, child_description: item.description,
      child_unit: item.unit, child_selling_price_excl: item.selling_price_excl, quantity: 1,
    }]);
    setSearch(''); setShowSearch(false);
  };

  const setQty = (idx: number, val: string) => {
    const q = parseFloat(val);
    if (!isNaN(q) && q > 0) setLines((p) => p.map((l, i) => i === idx ? { ...l, quantity: q } : l));
  };

  const remove = (idx: number) => setLines((p) => p.filter((_, i) => i !== idx));

  const save = async () => {
    setSaving(true); setError(''); setSaved(false);
    try {
      const res = await apiFetch('/api/accounting/item-bundles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_id: itemId, lines: lines.map((l, i) => ({ child_item_id: l.child_item_id, quantity: l.quantity, sort_order: i })) }),
      });
      if (!res.ok) { const j = await res.json() as { message?: string }; throw new Error(j.message ?? 'Save failed'); }
      setSaved(true); onSaved?.();
    } catch (e) { setError(e instanceof Error ? e.message : 'Save failed'); }
    finally { setSaving(false); }
  };

  const total = lines.reduce((s, l) => s + (l.child_selling_price_excl ?? 0) * l.quantity, 0);

  if (loading) return (
    <div className="flex items-center gap-2 text-[var(--ff-text-secondary)] py-4">
      <Loader2 className="h-4 w-4 animate-spin" /><span className="text-sm">Loading...</span>
    </div>
  );

  return (
    <div className="space-y-4">
      {parentDescription && (
        <p className="text-sm text-[var(--ff-text-secondary)]">
          Components for <span className="font-medium text-[var(--ff-text-primary)]">{parentDescription}</span>
        </p>
      )}

      {lines.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-[var(--ff-border-light)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-tertiary)] text-xs uppercase">
                <th className="px-3 py-2 text-left">Code</th>
                <th className="px-3 py-2 text-left">Description</th>
                <th className="px-3 py-2 text-left">Unit</th>
                <th className="px-3 py-2 text-right">Price</th>
                <th className="px-3 py-2 text-right w-24">Qty</th>
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-2 py-2 w-8" />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, idx) => (
                <tr key={line.child_item_id} className="border-t border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-tertiary)]">
                  <td className="px-3 py-2 text-blue-400 font-mono text-xs">{line.child_code ?? '—'}</td>
                  <td className="px-3 py-2 text-[var(--ff-text-primary)]">{line.child_description ?? '—'}</td>
                  <td className="px-3 py-2 text-[var(--ff-text-secondary)]">{line.child_unit ?? 'each'}</td>
                  <td className="px-3 py-2 text-right text-[var(--ff-text-secondary)]">{fmt(line.child_selling_price_excl)}</td>
                  <td className="px-3 py-2 text-right">
                    <input type="number" min="0.0001" step="0.0001" value={line.quantity}
                      onChange={(e) => setQty(idx, e.target.value)}
                      className="w-20 text-right bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] rounded px-2 py-0.5 text-sm text-[var(--ff-text-primary)] focus:outline-none focus:border-blue-500"
                    />
                  </td>
                  <td className="px-3 py-2 text-right font-medium text-[var(--ff-text-primary)]">
                    {fmt((line.child_selling_price_excl ?? 0) * line.quantity)}
                  </td>
                  <td className="px-2 py-2">
                    <button onClick={() => remove(idx)} className="p-1 rounded hover:bg-red-500/10 text-[var(--ff-text-tertiary)] hover:text-red-400 transition-colors" title="Remove">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
                <td colSpan={5} className="px-3 py-2 text-right text-xs uppercase font-semibold text-[var(--ff-text-tertiary)]">Bundle Total (excl. VAT)</td>
                <td className="px-3 py-2 text-right font-bold text-[var(--ff-text-primary)]">{fmt(total)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {lines.length === 0 && !showSearch && (
        <p className="text-sm text-[var(--ff-text-tertiary)] py-2">No components yet. Add items below.</p>
      )}

      {showSearch ? (
        <div className="space-y-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ff-text-tertiary)]" />
            <input autoFocus type="text" placeholder="Search items..." value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-4 py-2 bg-[var(--ff-bg-primary)] border border-blue-500 rounded-lg text-sm text-[var(--ff-text-primary)] focus:outline-none"
            />
          </div>
          {search && (
            <div className="border border-[var(--ff-border-light)] rounded-lg max-h-48 overflow-y-auto">
              {filtered.length === 0
                ? <p className="text-sm text-[var(--ff-text-secondary)] px-3 py-2">No items found</p>
                : filtered.slice(0, 20).map((item) => (
                  <button key={item.id} onClick={() => addItem(item)}
                    className="w-full text-left px-3 py-2 hover:bg-[var(--ff-bg-tertiary)] flex items-center justify-between gap-2 border-b border-[var(--ff-border-light)] last:border-0"
                  >
                    <span className="text-sm text-[var(--ff-text-primary)]">
                      <span className="text-blue-400 font-mono text-xs mr-2">{item.code}</span>{item.description}
                    </span>
                    <span className="text-xs text-[var(--ff-text-tertiary)] whitespace-nowrap">{fmt(item.selling_price_excl)}</span>
                  </button>
                ))
              }
            </div>
          )}
          <button onClick={() => { setShowSearch(false); setSearch(''); }} className="text-xs text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">Cancel</button>
        </div>
      ) : (
        <button onClick={() => setShowSearch(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] hover:text-blue-400 hover:border-blue-500 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" /> Add Component
        </button>
      )}

      {error && <p className="text-sm text-red-400 bg-red-500/10 rounded px-3 py-2">{error}</p>}

      <div className="flex items-center gap-3">
        <button onClick={save} disabled={saving}
          className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm rounded-lg font-medium transition-colors"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save Bundle
        </button>
        {saved && <span className="text-sm text-teal-400">Saved successfully</span>}
      </div>
    </div>
  );
}
