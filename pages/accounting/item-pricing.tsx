/**
 * Item Pricing Page
 * Sage Parity: Items > Transactions > Adjust Selling Prices
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Tag, Save, Loader2, Search } from 'lucide-react';

const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

interface Item { id: string; item_code: string; name: string; category: string; uom: string; selling_price: number; cost_price: number; }

export default function ItemPricingPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch('/api/accounting/item-pricing', { credentials: 'include' });
    const json = await res.json();
    setItems(json.data || []);
    setEdits({});
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    if (!search) return items;
    const q = search.toLowerCase();
    return items.filter(i => i.name.toLowerCase().includes(q) || i.item_code.toLowerCase().includes(q));
  }, [items, search]);

  const changedCount = Object.keys(edits).length;

  const save = async () => {
    const updates = Object.entries(edits).map(([itemId, sellingPrice]) => ({ itemId, sellingPrice: Number(sellingPrice) }));
    if (!updates.length) return;
    setSaving(true); setMsg('');
    const res = await fetch('/api/accounting/item-pricing', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      credentials: 'include', body: JSON.stringify({ updates }),
    });
    if (res.ok) { setMsg(`${updates.length} price(s) updated`); await load(); }
    else { setMsg('Failed to save'); }
    setSaving(false);
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-violet-500/10"><Tag className="h-6 w-6 text-violet-500" /></div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Adjust Selling Prices</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Bulk update selling prices</p>
              </div>
            </div>
            <button onClick={save} disabled={saving || !changedCount}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium disabled:opacity-50">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save {changedCount > 0 ? `(${changedCount})` : ''}
            </button>
          </div>
          <div className="relative mt-4 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ff-text-tertiary)]" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search items..." className="ff-input w-full pl-9" />
          </div>
        </div>

        <div className="p-6 space-y-4">
          {msg && <div className={`p-3 rounded-lg text-sm ${msg.includes('updated') ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>{msg}</div>}

          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            {loading ? (
              <div className="p-8 text-center"><Loader2 className="h-6 w-6 animate-spin text-[var(--ff-text-tertiary)] mx-auto" /></div>
            ) : (
              <table className="w-full text-sm">
                <thead><tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Code</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Item</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Category</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Cost Price</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Selling Price</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Margin</th>
                </tr></thead>
                <tbody className="divide-y divide-[var(--ff-border-light)]">
                  {filtered.map(item => {
                    const sp = edits[item.id] !== undefined ? Number(edits[item.id]) : Number(item.selling_price || 0);
                    const cp = Number(item.cost_price || 0);
                    const margin = cp > 0 ? ((sp - cp) / cp * 100) : 0;
                    const changed = edits[item.id] !== undefined;
                    return (
                      <tr key={item.id} className={`hover:bg-[var(--ff-bg-tertiary)] ${changed ? 'bg-blue-500/5' : ''}`}>
                        <td className="px-4 py-2 font-mono text-xs text-[var(--ff-text-tertiary)]">{item.item_code}</td>
                        <td className="px-4 py-2 text-[var(--ff-text-primary)]">{item.name}</td>
                        <td className="px-4 py-2 text-[var(--ff-text-secondary)]">{item.category || '—'}</td>
                        <td className="px-4 py-2 text-right text-[var(--ff-text-secondary)]">{fmt(cp)}</td>
                        <td className="px-4 py-2 text-right">
                          <input type="number" step="0.01" min="0"
                            value={edits[item.id] !== undefined ? edits[item.id] : (item.selling_price ?? '')}
                            onChange={e => setEdits(p => ({ ...p, [item.id]: e.target.value }))}
                            className={`w-32 px-2 py-1 text-right rounded bg-[var(--ff-bg-tertiary)] border text-[var(--ff-text-primary)] text-sm ${changed ? 'border-blue-500' : 'border-[var(--ff-border-light)]'}`} />
                        </td>
                        <td className={`px-4 py-2 text-right ${margin >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{margin.toFixed(1)}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
