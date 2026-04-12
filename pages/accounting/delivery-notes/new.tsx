/**
 * New Delivery Note Page — redesigned with elevated design system
 */
import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { Truck, Loader2, ArrowLeft } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import {
  DeliveryNoteLineEditor,
  emptyLine,
  type LineItem,
} from '@/components/accounting/deliveryNotes/DeliveryNoteLineEditor';

interface CustomerOption {
  id: string; name?: string; company_name?: string; companyName?: string;
}
interface SalesOrderOption { id: string; orderNumber: string }

const inp = 'w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 transition-colors';
const lbl = 'block text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5';
const card = 'bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm';

export default function NewDeliveryNotePage() {
  const router = useRouter();
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [salesOrders, setSalesOrders] = useState<SalesOrderOption[]>([]);
  const [loadingCustomers, setLoadingCustomers] = useState(true);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [customerId, setCustomerId] = useState('');
  const [salesOrderId, setSalesOrderId] = useState('');
  const [deliveryDate, setDeliveryDate] = useState(new Date().toISOString().split('T')[0]!);
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineItem[]>([emptyLine()]);

  const { sales_order_id, customer_id } = router.query;

  useEffect(() => {
    setLoadingCustomers(true);
    apiFetch('/api/accounting/customers')
      .then(r => r.json())
      .then((json: { data?: CustomerOption[] } | CustomerOption[]) => {
        const list: CustomerOption[] = Array.isArray(json)
          ? json
          : Array.isArray((json as { data?: CustomerOption[] }).data)
            ? ((json as { data: CustomerOption[] }).data)
            : [];
        setCustomers(list.map(c => ({
          id: String(c.id),
          name: String(c.name ?? c.company_name ?? c.companyName ?? ''),
        })));
      })
      .catch(() => setError('Failed to load customers'))
      .finally(() => setLoadingCustomers(false));
  }, []);

  useEffect(() => {
    if (typeof customer_id === 'string' && customer_id) setCustomerId(customer_id);
    if (typeof sales_order_id === 'string' && sales_order_id) setSalesOrderId(sales_order_id);
  }, [customer_id, sales_order_id]);

  useEffect(() => {
    if (!customerId) { setSalesOrders([]); setSalesOrderId(''); return; }
    setLoadingOrders(true);
    apiFetch('/api/accounting/customer-sales-orders?status=confirmed')
      .then(r => r.json())
      .then((json: { data?: { orders?: SalesOrderOption[] } }) => { setSalesOrders(json?.data?.orders ?? []); })
      .catch(() => setSalesOrders([]))
      .finally(() => setLoadingOrders(false));
  }, [customerId]);

  const handleSave = async (dispatchAfter: boolean) => {
    setError('');
    if (!customerId) { setError('Please select a customer'); return; }
    const validLines = lines.filter(l => l.description.trim());
    if (validLines.length === 0) { setError('At least one line item with a description is required'); return; }
    setSaving(true);
    try {
      const res = await apiFetch('/api/accounting/delivery-notes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_id: customerId,
          sales_order_id: salesOrderId || undefined,
          delivery_date: deliveryDate,
          delivery_address: deliveryAddress || undefined,
          notes: notes || undefined,
          lines: validLines,
        }),
      });
      const json = (await res.json()) as { data?: { id?: string }; error?: { message?: string } };
      if (!res.ok) { setError(json?.error?.message ?? 'Failed to create delivery note'); return; }
      const noteId = json?.data?.id ?? '';
      if (dispatchAfter && noteId) {
        await apiFetch('/api/accounting/delivery-notes', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: noteId, status: 'dispatched' }),
        });
      }
      await router.push('/accounting/delivery-notes');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save delivery note');
    } finally { setSaving(false); }
  };

  const validLineCount = lines.filter(l => l.description.trim()).length;

  return (
    <AppLayout>
      <div className="min-h-screen bg-slate-50 dark:bg-[var(--ff-bg-primary)]">
        <div className="relative overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 px-6 py-7">
          <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)', backgroundSize: '24px 24px' }} />
          <div className="absolute -top-12 right-8 w-72 h-72 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />
          <div className="relative z-10">
            <Link href="/accounting/delivery-notes" className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 mb-4 transition-colors">
              <ArrowLeft className="h-3.5 w-3.5" /> Back to Delivery Notes
            </Link>
            <div>
              <p className="text-amber-400 text-xs font-semibold uppercase tracking-widest mb-0.5">New Document</p>
              <h1 className="text-xl font-bold text-white">Delivery Note</h1>
            </div>
          </div>
        </div>

        <div className="p-6 xl:p-8">
          <div className="max-w-6xl mx-auto flex gap-6 items-start">
            <div className="flex-1 min-w-0 space-y-5">
              {error && <div className="p-3 bg-red-50 dark:bg-red-900/20 rounded-xl border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm">{error}</div>}

              <div className={`${card} p-5`}>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                  <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">1</span>
                  Delivery Details
                </h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className={lbl}>Customer *</label>
                    {loadingCustomers ? (
                      <div className={`${inp} flex items-center gap-2 text-slate-400`}><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading...</div>
                    ) : (
                      <select name="customerId" value={customerId} onChange={e => { setCustomerId(e.target.value); setSalesOrderId(''); }} className={inp}>
                        <option value="">Select customer…</option>
                        {customers.map(c => <option key={c.id} value={c.id}>{String(c.name ?? c.company_name ?? c.companyName ?? '')}</option>)}
                      </select>
                    )}
                  </div>
                  <div>
                    <label className={lbl}>Delivery Date *</label>
                    <input type="date" name="deliveryDate" value={deliveryDate} onChange={e => setDeliveryDate(e.target.value)} className={inp} />
                  </div>
                  <div>
                    <label className={lbl}>Linked Sales Order (optional)</label>
                    {loadingOrders ? (
                      <div className={`${inp} flex items-center gap-2 text-slate-400`}><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading...</div>
                    ) : (
                      <select name="salesOrderId" value={salesOrderId} onChange={e => setSalesOrderId(e.target.value)} disabled={!customerId} className={`${inp} disabled:opacity-50`}>
                        <option value="">None</option>
                        {salesOrders.map(so => <option key={so.id} value={so.id}>{so.orderNumber}</option>)}
                      </select>
                    )}
                  </div>
                  <div>
                    <label className={lbl}>Delivery Address</label>
                    <input name="deliveryAddress" value={deliveryAddress} onChange={e => setDeliveryAddress(e.target.value)} placeholder="Delivery address…" className={inp} />
                  </div>
                </div>
                <div className="mt-4">
                  <label className={lbl}>Notes</label>
                  <textarea name="notes" value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Additional notes…" className={`${inp} resize-none`} />
                </div>
              </div>

              <div className={`${card} overflow-hidden`}>
                <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                    <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">2</span>
                    Line Items
                  </h3>
                </div>
                <div className="p-5">
                  <DeliveryNoteLineEditor lines={lines} onChange={setLines} />
                </div>
              </div>
            </div>

            <div className="w-72 shrink-0">
              <div className="sticky top-6">
                <div className={`${card} p-5`}>
                  <div className="flex items-center gap-2 mb-5">
                    <Truck className="w-4 h-4 text-amber-500" />
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Delivery Summary</h3>
                  </div>
                  <div className="space-y-3">
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500 dark:text-slate-400">Customer</span>
                      <span className="text-slate-900 dark:text-slate-100 font-medium text-right max-w-[140px] truncate">
                        {customerId ? (customers.find(c => c.id === customerId)?.name ?? '—') : '—'}
                      </span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500 dark:text-slate-400">Delivery Date</span>
                      <span className="font-mono text-slate-900 dark:text-slate-100">{deliveryDate || '—'}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500 dark:text-slate-400">Line Items</span>
                      <span className="font-mono font-bold text-lg text-amber-500">{validLineCount}</span>
                    </div>
                    {salesOrderId && (
                      <div className="flex justify-between text-sm">
                        <span className="text-slate-500 dark:text-slate-400">Sales Order</span>
                        <span className="font-mono text-slate-900 dark:text-slate-100 text-xs">
                          {salesOrders.find(so => so.id === salesOrderId)?.orderNumber ?? '—'}
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="h-px bg-slate-100 dark:bg-slate-800 my-4" />
                  <button onClick={() => void handleSave(false)} disabled={saving} className="w-full py-2.5 mb-2 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 font-semibold rounded-xl transition-colors border border-slate-200 dark:border-slate-700 disabled:opacity-50 text-sm">
                    {saving ? <Loader2 className="h-4 w-4 animate-spin mx-auto" /> : 'Save as Draft'}
                  </button>
                  <button onClick={() => void handleSave(true)} disabled={saving} className="w-full py-3 bg-amber-500 hover:bg-amber-400 text-white font-semibold rounded-xl transition-colors shadow-lg shadow-amber-500/20 disabled:opacity-50 flex items-center justify-center gap-2 text-sm">
                    {saving ? <><Loader2 className="h-4 w-4 animate-spin" />Saving…</> : <><Truck className="h-4 w-4" />Save &amp; Dispatch</>}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
