/**
 * Customer Sales Orders List Page
 */
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { ClipboardList, Plus, Search, Loader2, Trash2, Edit, X, FileText } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface SalesOrder {
  id: string; orderNumber: string; customerName: string;
  orderDate: string; deliveryDate: string | null;
  status: string; totalAmount: number;
}
interface CustomerOption { id: string; name: string }

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);
const inp = 'w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 transition-colors';
const lbl = 'block text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5';

const STATUS: Record<string, { label: string; cls: string }> = {
  draft:             { label: 'Draft',              cls: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300' },
  confirmed:         { label: 'Confirmed',          cls: 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' },
  partially_invoiced:{ label: 'Part. Invoiced',     cls: 'bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400' },
  invoiced:          { label: 'Invoiced',           cls: 'bg-purple-50 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400' },
  cancelled:         { label: 'Cancelled',          cls: 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400' },
};
const TABS = ['all', 'draft', 'confirmed', 'invoiced'] as const;

interface ModalProps { customers: CustomerOption[]; onClose: () => void; onCreated: () => void }
function CreateOrderModal({ customers, onClose, onCreated }: ModalProps) {
  const [form, setForm] = useState({
    customer_id: '', order_date: new Date().toISOString().split('T')[0],
    delivery_date: '', reference: '', notes: '', internal_notes: '',
  });
  const [lines, setLines] = useState([{ description: '', quantity: 1, unit_price: 0, tax_rate: 15 }]);
  const [saving, setSaving] = useState(false);
  const subtotal = lines.reduce((s, l) => s + l.quantity * l.unit_price, 0);

  const handleCreate = async () => {
    if (lines.every(l => !l.description)) return;
    setSaving(true);
    await apiFetch('/api/accounting/customer-sales-orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, items: lines.filter(l => l.description) }),
    });
    setSaving(false); onCreated(); onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-10 pb-8 px-4 bg-slate-950/80 backdrop-blur-sm overflow-y-auto" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-2xl bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden">
        <div className="px-6 py-5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-amber-500/10 flex items-center justify-center"><ClipboardList className="w-4 h-4 text-amber-500" /></div>
            <div><h2 className="text-base font-semibold text-slate-900 dark:text-white">New Sales Order</h2><p className="text-xs text-slate-500 dark:text-slate-400">Fill in the order details below</p></div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 transition-colors"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-6 space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className={lbl}>Customer *</label>
              <select value={form.customer_id} onChange={e => setForm(p => ({ ...p, customer_id: e.target.value }))} className={inp}>
                <option value="">Select a customer…</option>
                {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div><label className={lbl}>Order Date</label><input type="date" value={form.order_date} onChange={e => setForm(p => ({ ...p, order_date: e.target.value }))} className={inp} /></div>
            <div><label className={lbl}>Delivery Date</label><input type="date" value={form.delivery_date} onChange={e => setForm(p => ({ ...p, delivery_date: e.target.value }))} className={inp} /></div>
            <div><label className={lbl}>Reference</label><input value={form.reference} onChange={e => setForm(p => ({ ...p, reference: e.target.value }))} placeholder="Optional" className={inp} /></div>
            <div><label className={lbl}>Notes</label><input value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} placeholder="Optional" className={inp} /></div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className={lbl}>Line Items</label>
              <button onClick={() => setLines(l => [...l, { description: '', quantity: 1, unit_price: 0, tax_rate: 15 }])} className="text-xs text-amber-500 hover:text-amber-400 flex items-center gap-1 font-semibold transition-colors"><Plus className="w-3 h-3" />Add line</button>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800/60"><tr>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 dark:text-slate-400">Description</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-slate-500 dark:text-slate-400 w-20">Qty</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-slate-500 dark:text-slate-400 w-28">Unit Price</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-slate-500 dark:text-slate-400 w-24">Total</th>
                  <th className="w-8" />
                </tr></thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {lines.map((l, i) => (
                    <tr key={i} className="group">
                      <td className="px-2 py-2"><input value={l.description} onChange={e => { const n = [...lines]; n[i] = { ...l, description: e.target.value }; setLines(n); }} placeholder="Item description" className={inp} /></td>
                      <td className="px-2 py-2"><input type="number" value={l.quantity} min={1} onChange={e => { const n = [...lines]; n[i] = { ...l, quantity: Number(e.target.value) }; setLines(n); }} className={`${inp} text-right`} /></td>
                      <td className="px-2 py-2"><input type="number" value={l.unit_price} min={0} step={0.01} onChange={e => { const n = [...lines]; n[i] = { ...l, unit_price: Number(e.target.value) }; setLines(n); }} className={`${inp} text-right`} /></td>
                      <td className="px-3 py-2 text-right font-mono text-xs font-semibold text-slate-700 dark:text-slate-300">{fmt(l.quantity * l.unit_price)}</td>
                      <td className="px-2 py-2"><button onClick={() => lines.length > 1 && setLines(lines.filter((_, j) => j !== i))} className="p-1 rounded text-slate-300 dark:text-slate-600 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"><Trash2 className="w-3.5 h-3.5" /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {subtotal > 0 && (
              <div className="mt-3 flex justify-end gap-4 text-sm px-1">
                <span className="text-slate-500 dark:text-slate-400">Subtotal <span className="font-mono text-slate-700 dark:text-slate-200">{fmt(subtotal)}</span></span>
                <span className="text-slate-500 dark:text-slate-400">VAT 15% <span className="font-mono text-slate-700 dark:text-slate-200">{fmt(subtotal * 0.15)}</span></span>
                <span className="font-bold text-amber-500 font-mono">{fmt(subtotal * 1.15)}</span>
              </div>
            )}
          </div>
        </div>
        <div className="px-6 py-4 border-t border-slate-100 dark:border-slate-800 flex justify-end gap-2 bg-slate-50/50 dark:bg-slate-800/20">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors">Cancel</button>
          <button onClick={handleCreate} disabled={saving || !form.customer_id || lines.every(l => !l.description)} className="px-5 py-2 text-sm font-semibold bg-amber-500 hover:bg-amber-400 text-white rounded-lg transition-colors disabled:opacity-40 flex items-center gap-2">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
            {saving ? 'Creating…' : 'Create Sales Order'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function CustomerSalesOrdersPage() {
  const router = useRouter();
  const [orders, setOrders] = useState<SalesOrder[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams();
      if (tab !== 'all') params.set('status', tab);
      if (search) params.set('search', search);
      const res = await apiFetch(`/api/accounting/customer-sales-orders?${params}`);
      const json = await res.json();
      const d = json.data || json;
      setOrders(d.orders || []); setTotal(d.total || 0);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally { setLoading(false); }
  }, [tab, search]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    apiFetch('/api/accounting/customers').then(r => r.json()).then((json: { data?: CustomerOption[] }) => {
      const list = Array.isArray(json.data) ? json.data : [];
      setCustomers(list.map((c: CustomerOption) => ({ id: String(c.id), name: String(c.name) })));
    }).catch(() => {/* non-fatal */});
  }, []);

  const handleDelete = async (id: string) => {
    if (!window.confirm('Delete this draft sales order?')) return;
    setDeleting(id);
    await apiFetch('/api/accounting/customer-sales-orders', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    setDeleting(null); void load();
  };

  const s = (o: SalesOrder) => STATUS[o.status] ?? { label: o.status, cls: '' };

  return (
    <AppLayout>
      <div className="min-h-screen bg-slate-50 dark:bg-[var(--ff-bg-primary)]">
        <div className="relative overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 px-6 py-8">
          <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)', backgroundSize: '24px 24px' }} />
          <div className="absolute -top-12 right-8 w-72 h-72 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />
          <div className="relative z-10 flex items-center justify-between">
            <div>
              <p className="text-amber-400 text-xs font-semibold uppercase tracking-widest mb-1">Customers</p>
              <h1 className="text-2xl font-bold text-white">Customer Sales Orders</h1>
              <p className="text-slate-400 text-sm mt-0.5">{total} {total === 1 ? 'order' : 'orders'}</p>
            </div>
            <button onClick={() => setShowNew(true)} className="flex items-center gap-2 px-4 py-2.5 bg-amber-500 hover:bg-amber-400 text-white rounded-xl text-sm font-semibold transition-colors shadow-lg shadow-amber-500/25">
              <Plus className="w-4 h-4" /> New Sales Order
            </button>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">{error}</div>}
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex gap-1 p-1 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800">
              {TABS.map(t => (
                <button key={t} onClick={() => setTab(t)} className={`px-3 py-1.5 text-xs font-medium rounded-lg capitalize transition-colors ${tab === t ? 'bg-amber-500 text-white shadow-sm' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}>
                  {t === 'all' ? 'All' : STATUS[t]?.label ?? t}
                </button>
              ))}
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search sales orders…" className="pl-9 pr-4 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 text-slate-900 dark:text-slate-100 transition-colors w-56" />
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
            {loading ? (
              <div className="p-16 flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div>
            ) : orders.length === 0 ? (
              <div className="p-16 text-center">
                <div className="w-14 h-14 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center mx-auto mb-4"><ClipboardList className="w-7 h-7 text-slate-400" /></div>
                <h3 className="text-base font-semibold text-slate-900 dark:text-white">No sales orders found</h3>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Create your first sales order to get started</p>
                <button onClick={() => setShowNew(true)} className="mt-5 px-4 py-2 bg-amber-500 hover:bg-amber-400 text-white text-sm font-semibold rounded-lg transition-colors">New Sales Order</button>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    {['Order #', 'Customer', 'Date', 'Delivery Date', 'Total', 'Status', ''].map((h, i) => (
                      <th key={i} className={`px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider ${i === 4 ? 'text-right' : i === 6 ? 'text-right' : 'text-left'}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {orders.map(o => (
                    <tr key={o.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                      <td className="px-5 py-3.5 font-mono text-amber-500 font-semibold">{o.orderNumber}</td>
                      <td className="px-5 py-3.5 text-slate-900 dark:text-slate-100 font-medium">{o.customerName}</td>
                      <td className="px-5 py-3.5 text-slate-500 dark:text-slate-400 text-xs">{o.orderDate?.split('T')[0]}</td>
                      <td className="px-5 py-3.5 text-slate-500 dark:text-slate-400 text-xs">{o.deliveryDate?.split('T')[0] || '—'}</td>
                      <td className="px-5 py-3.5 text-right font-mono font-semibold text-slate-900 dark:text-white">{fmt(o.totalAmount)}</td>
                      <td className="px-5 py-3.5"><span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${s(o).cls}`}>{s(o).label}</span></td>
                      <td className="px-4 py-3.5">
                        <div className="flex justify-end gap-1.5">
                          {o.status === 'draft' && (<>
                            <button onClick={() => router.push(`/accounting/customer-sales-orders/${o.id}`)} title="Edit" className="p-1.5 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-900/20 text-slate-400 hover:text-blue-500 transition-colors"><Edit className="h-3.5 w-3.5" /></button>
                            <button onClick={() => void handleDelete(o.id)} disabled={deleting === o.id} title="Delete" className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 text-slate-400 hover:text-red-500 transition-colors disabled:opacity-50">
                              {deleting === o.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                            </button>
                          </>)}
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
      {showNew && <CreateOrderModal customers={customers} onClose={() => setShowNew(false)} onCreated={load} />}
    </AppLayout>
  );
}
