/**
 * Customer Quotes List Page — Sage-parity
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { FileText, Plus, Search, Loader2, Send, Check, X, ArrowRight } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface Quote {
  id: string; quoteNumber: string; customerName: string; quoteDate: string;
  expiryDate: string | null; status: string; total: number;
}

const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const STATUS_BADGE: Record<string, string> = {
  draft: 'bg-gray-500/10 text-gray-400',
  sent: 'bg-blue-500/10 text-blue-400',
  accepted: 'bg-teal-500/10 text-teal-400',
  declined: 'bg-red-500/10 text-red-400',
  expired: 'bg-amber-500/10 text-amber-400',
  converted: 'bg-purple-500/10 text-purple-400',
};

const TABS = ['all', 'draft', 'sent', 'accepted', 'declined', 'expired', 'converted'] as const;

export default function CustomerQuotesPage() {
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ customerName: '', quoteDate: new Date().toISOString().split('T')[0], expiryDate: '', notes: '' });
  const [lines, setLines] = useState([{ description: '', quantity: 1, unitPrice: 0, taxRate: 15 }]);

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (tab !== 'all') params.set('status', tab);
    if (search) params.set('search', search);
    const res = await apiFetch(`/api/accounting/customer-quotes?${params}`);
    const json = await res.json();
    const d = json.data || json;
    setQuotes(d.quotes || []);
    setTotal(d.total || 0);
    setLoading(false);
  }, [tab, search]);

  useEffect(() => { load(); }, [load]);

  const handleAction = async (id: string, action: string) => {
    await apiFetch('/api/accounting/customer-quotes-action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action }),
    });
    load();
  };

  const handleCreate = async () => {
    if (!form.customerName || lines.every(l => !l.description)) return;
    setSaving(true);
    await apiFetch('/api/accounting/customer-quotes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, lines: lines.filter(l => l.description) }),
    });
    setSaving(false);
    setShowNew(false);
    setForm({ customerName: '', quoteDate: new Date().toISOString().split('T')[0], expiryDate: '', notes: '' });
    setLines([{ description: '', quantity: 1, unitPrice: 0, taxRate: 15 }]);
    load();
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-500/10"><FileText className="h-6 w-6 text-blue-500" /></div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Customer Quotes</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">{total} quotes</p>
              </div>
            </div>
            <button onClick={() => setShowNew(!showNew)} className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm">
              <Plus className="h-4 w-4" /> New Quote
            </button>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {/* Tabs + Search */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex gap-1">
              {TABS.map(t => (
                <button key={t} onClick={() => setTab(t)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg capitalize ${tab === t ? 'bg-blue-600 text-white' : 'text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-secondary)]'}`}>
                  {t}
                </button>
              ))}
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ff-text-tertiary)]" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search quotes..."
                className="ff-input pl-9 text-sm w-64" />
            </div>
          </div>

          {/* New Quote Form */}
          {showNew && (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4 space-y-3">
              <div className="grid grid-cols-4 gap-3">
                <input value={form.customerName} onChange={e => setForm(p => ({ ...p, customerName: e.target.value }))}
                  placeholder="Customer name *" className="ff-input text-sm" />
                <input type="date" value={form.quoteDate} onChange={e => setForm(p => ({ ...p, quoteDate: e.target.value }))}
                  className="ff-input text-sm" />
                <input type="date" value={form.expiryDate} onChange={e => setForm(p => ({ ...p, expiryDate: e.target.value }))}
                  placeholder="Expiry date" className="ff-input text-sm" />
                <input value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))}
                  placeholder="Notes" className="ff-input text-sm" />
              </div>
              <div className="space-y-2">
                {lines.map((l, i) => (
                  <div key={i} className="grid grid-cols-5 gap-2">
                    <input value={l.description} onChange={e => { const n = [...lines]; n[i] = { ...l, description: e.target.value }; setLines(n); }}
                      placeholder="Description *" className="ff-input text-sm col-span-2" />
                    <input type="number" value={l.quantity} onChange={e => { const n = [...lines]; n[i] = { ...l, quantity: Number(e.target.value) }; setLines(n); }}
                      placeholder="Qty" className="ff-input text-sm" />
                    <input type="number" value={l.unitPrice} onChange={e => { const n = [...lines]; n[i] = { ...l, unitPrice: Number(e.target.value) }; setLines(n); }}
                      placeholder="Unit price" className="ff-input text-sm" />
                    <div className="text-sm text-right text-[var(--ff-text-secondary)] self-center font-mono">
                      {fmt(l.quantity * l.unitPrice)}
                    </div>
                  </div>
                ))}
                <button onClick={() => setLines([...lines, { description: '', quantity: 1, unitPrice: 0, taxRate: 15 }])}
                  className="text-xs text-blue-400 hover:text-blue-300">+ Add line</button>
              </div>
              <div className="flex justify-end gap-2">
                <button onClick={() => setShowNew(false)} className="px-3 py-1.5 text-sm text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)] rounded-lg">Cancel</button>
                <button onClick={handleCreate} disabled={saving}
                  className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-50">
                  {saving ? 'Saving...' : 'Create Quote'}
                </button>
              </div>
            </div>
          )}

          {/* Table */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            {loading ? (
              <div className="p-8 text-center"><Loader2 className="h-6 w-6 animate-spin text-[var(--ff-text-tertiary)] mx-auto" /></div>
            ) : quotes.length === 0 ? (
              <div className="p-8 text-center text-[var(--ff-text-secondary)]">No quotes found</div>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
                    <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Quote #</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Customer</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Date</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Expiry</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Total</th>
                    <th className="px-4 py-3 text-center text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Status</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--ff-border-light)]">
                  {quotes.map(q => (
                    <tr key={q.id} className="hover:bg-[var(--ff-bg-tertiary)] transition-colors">
                      <td className="px-4 py-3 text-sm font-mono text-blue-400">{q.quoteNumber}</td>
                      <td className="px-4 py-3 text-sm text-[var(--ff-text-primary)]">{q.customerName}</td>
                      <td className="px-4 py-3 text-sm text-[var(--ff-text-secondary)]">{q.quoteDate?.split('T')[0]}</td>
                      <td className="px-4 py-3 text-sm text-[var(--ff-text-secondary)]">{q.expiryDate?.split('T')[0] || '—'}</td>
                      <td className="px-4 py-3 text-sm text-right font-mono text-[var(--ff-text-primary)]">{fmt(q.total)}</td>
                      <td className="px-4 py-3 text-center">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_BADGE[q.status] || ''}`}>{q.status}</span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex justify-end gap-1">
                          {q.status === 'draft' && (
                            <button onClick={() => handleAction(q.id, 'send')} title="Send"
                              className="p-1.5 rounded hover:bg-blue-500/10 text-blue-400"><Send className="h-3.5 w-3.5" /></button>
                          )}
                          {q.status === 'sent' && (<>
                            <button onClick={() => handleAction(q.id, 'accept')} title="Accept"
                              className="p-1.5 rounded hover:bg-teal-500/10 text-teal-400"><Check className="h-3.5 w-3.5" /></button>
                            <button onClick={() => handleAction(q.id, 'decline')} title="Decline"
                              className="p-1.5 rounded hover:bg-red-500/10 text-red-400"><X className="h-3.5 w-3.5" /></button>
                          </>)}
                          {q.status === 'accepted' && (
                            <button onClick={() => handleAction(q.id, 'convert')} title="Convert to Invoice"
                              className="p-1.5 rounded hover:bg-purple-500/10 text-purple-400"><ArrowRight className="h-3.5 w-3.5" /></button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
