/**
 * Item Opening Balances Page
 * Sage Parity: Items > Special > Item Opening Balances
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { PackageOpen, Save, Loader2, Search } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

interface Item { id: string; item_code: string; name: string; category: string; uom: string; quantity_on_hand: number; cost_price: number; }
interface Edit { quantity: string; unitCost: string; }

export default function ItemOpeningBalancesPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const res = await apiFetch('/api/accounting/item-opening-balances', { credentials: 'include' });
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

  const totalValue = useMemo(() => items.reduce((s, item) => {
    const e = edits[item.id];
    const qty = e ? Number(e.quantity) : Number(item.quantity_on_hand || 0);
    const cost = e ? Number(e.unitCost) : Number(item.cost_price || 0);
    return s + qty * cost;
  }, 0), [items, edits]);

  const setField = (id: string, field: 'quantity' | 'unitCost', value: string) => {
    setEdits(prev => {
      const cur = prev[id] || { quantity: String(items.find(i => i.id === id)?.quantity_on_hand ?? 0), unitCost: String(items.find(i => i.id === id)?.cost_price ?? 0) };
      return { ...prev, [id]: { ...cur, [field]: value } };
    });
  };

  const save = async () => {
    if (!changedCount) return;
    setSaving(true); setMsg('');
    const payload = Object.entries(edits).map(([itemId, v]) => ({ itemId, quantity: Number(v.quantity), unitCost: Number(v.unitCost) }));
    const res = await apiFetch('/api/accounting/item-opening-balances', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'include', body: JSON.stringify({ items: payload }),
    });
    if (res.ok) { setMsg(`Balances set for ${payload.length} item(s)`); await load(); }
    else { setMsg('Failed to save'); }
    setSaving(false);
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10"><PackageOpen className="h-6 w-6 text-teal-500" /></div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Item Opening Balances</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Set initial stock quantities and unit costs</p>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <div className="text-right">
                <p className="text-xs text-[var(--ff-text-tertiary)]">Total Value</p>
                <p className="text-lg font-bold text-[var(--ff-text-primary)]">{fmt(totalValue)}</p>
              </div>
              <button onClick={save} disabled={saving || !changedCount}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium disabled:opacity-50">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save {changedCount > 0 ? `(${changedCount})` : ''}
              </button>
            </div>
          </div>
          <div className="relative mt-4 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ff-text-tertiary)]" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search items..." className="ff-input w-full pl-9" />
          </div>
        </div>

        <div className="p-6">
          {msg && <div className={`p-3 rounded-lg text-sm mb-4 ${msg.includes('set') ? 'bg-teal-500/10 text-teal-400' : 'bg-red-500/10 text-red-400'}`}>{msg}</div>}

          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            {loading ? (
              <div className="p-8 text-center"><Loader2 className="h-6 w-6 animate-spin text-[var(--ff-text-tertiary)] mx-auto" /></div>
            ) : (
              <table className="w-full text-sm">
                <thead><tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Code</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Item</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">UOM</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Quantity</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Unit Cost</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Total Value</th>
                </tr></thead>
                <tbody className="divide-y divide-[var(--ff-border-light)]">
                  {filtered.map(item => {
                    const e = edits[item.id];
                    const qty = e ? Number(e.quantity) : Number(item.quantity_on_hand || 0);
                    const cost = e ? Number(e.unitCost) : Number(item.cost_price || 0);
                    const changed = Boolean(e);
                    return (
                      <tr key={item.id} className={`hover:bg-[var(--ff-bg-tertiary)] ${changed ? 'bg-teal-500/5' : ''}`}>
                        <td className="px-4 py-2 font-mono text-xs text-[var(--ff-text-tertiary)]">{item.item_code}</td>
                        <td className="px-4 py-2 text-[var(--ff-text-primary)]">{item.name}</td>
                        <td className="px-4 py-2 text-[var(--ff-text-tertiary)]">{item.uom}</td>
                        <td className="px-4 py-2 text-right">
                          <input type="number" step="0.0001" min="0" value={e?.quantity ?? (item.quantity_on_hand ?? '')}
                            onChange={ev => setField(item.id, 'quantity', ev.target.value)}
                            className={`w-28 px-2 py-1 text-right rounded bg-[var(--ff-bg-tertiary)] border text-[var(--ff-text-primary)] text-sm ${changed ? 'border-teal-500' : 'border-[var(--ff-border-light)]'}`} />
                        </td>
                        <td className="px-4 py-2 text-right">
                          <input type="number" step="0.01" min="0" value={e?.unitCost ?? (item.cost_price ?? '')}
                            onChange={ev => setField(item.id, 'unitCost', ev.target.value)}
                            className={`w-32 px-2 py-1 text-right rounded bg-[var(--ff-bg-tertiary)] border text-[var(--ff-text-primary)] text-sm ${changed ? 'border-teal-500' : 'border-[var(--ff-border-light)]'}`} />
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-[var(--ff-text-primary)]">{fmt(qty * cost)}</td>
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
