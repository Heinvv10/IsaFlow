/**
 * Customer Receipt Allocation
 * Sage Parity: Transactions > Allocate Receipts
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { ArrowLeftRight, Loader2, AlertCircle, Check } from 'lucide-react';
import { ExportCSVButton } from '@/components/shared/ExportCSVButton';
import { apiFetch } from '@/lib/apiFetch';

const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

interface Payment { id: string; paymentNumber: string; clientName: string; clientId: string; date: string; amount: number; allocatedAmount: number; }
interface Invoice { id: string; invoiceNumber: string; date: string; total: number; outstanding: number; }

export default function CustomerAllocationsPage() {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [selected, setSelected] = useState<Payment | null>(null);
  const [allocs, setAllocs] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [loadingInv, setLoadingInv] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  const loadPayments = useCallback(async () => {
    setLoading(true);
    const res = await apiFetch('/api/accounting/customer-payments?unallocated=true', { credentials: 'include' });
    const json = await res.json();
    const d = json.data; setPayments(Array.isArray(d) ? d : d?.items || d?.payments || []);
    setLoading(false);
  }, []);

  useEffect(() => { loadPayments(); }, [loadPayments]);

  const selectPayment = async (p: Payment) => {
    setSelected(p); setAllocs({}); setMsg(''); setLoadingInv(true);
    const res = await apiFetch(`/api/accounting/customer-invoices?client_id=${p.clientId}&status=approved`, { credentials: 'include' });
    const json = await res.json();
    setInvoices(json.data?.items || json.data || []);
    setLoadingInv(false);
  };

  const toggleAlloc = (inv: Invoice) => {
    setAllocs(prev => {
      const next = { ...prev };
      if (next[inv.id] !== undefined) { delete next[inv.id]; } else { next[inv.id] = inv.outstanding; }
      return next;
    });
  };

  const totalAlloc = Object.values(allocs).reduce((s, a) => s + a, 0);
  const unallocTotal = payments.reduce((s, p) => s + (p.amount - p.allocatedAmount), 0);

  const doAllocate = async () => {
    if (!selected || totalAlloc <= 0) return;
    setSaving(true);
    const allocations = Object.entries(allocs).filter(([, a]) => a > 0).map(([invoiceId, amount]) => ({ invoiceId, amount }));
    const res = await apiFetch('/api/accounting/customer-allocations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'include', body: JSON.stringify({ paymentId: selected.id, allocations }),
    });
    if (res.ok) { setMsg('Allocated successfully'); setSelected(null); setAllocs({}); await loadPayments(); }
    else { setMsg('Allocation failed'); }
    setSaving(false);
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-500/10"><ArrowLeftRight className="h-6 w-6 text-blue-500" /></div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Allocate Receipts</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Match customer receipts to outstanding invoices</p>
              </div>
            </div>
            <ExportCSVButton endpoint="/api/accounting/customer-allocations-export" filenamePrefix="customer-allocations" label="Export CSV" />
          </div>
        </div>

        <div className="p-6 space-y-4">
          {!loading && payments.length > 0 && (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
              <p className="text-xs text-[var(--ff-text-tertiary)] uppercase">Total Unallocated</p>
              <p className="text-xl font-bold text-amber-400 font-mono">{fmt(unallocTotal)}</p>
              <p className="text-xs text-[var(--ff-text-tertiary)]">{payments.length} receipt(s)</p>
            </div>
          )}
          {msg && <div className="flex items-center gap-2 p-3 rounded-lg bg-teal-500/10 text-teal-400 text-sm"><Check className="h-4 w-4" />{msg}</div>}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Unallocated Receipts */}
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
              <div className="px-4 py-3 border-b border-[var(--ff-border-light)] text-sm font-medium text-[var(--ff-text-secondary)]">Unallocated Receipts</div>
              {loading ? (
                <div className="p-8 text-center"><Loader2 className="h-6 w-6 animate-spin text-[var(--ff-text-tertiary)] mx-auto" /></div>
              ) : payments.length === 0 ? (
                <div className="p-8 text-center text-[var(--ff-text-tertiary)]">All receipts allocated</div>
              ) : (
                <div className="divide-y divide-[var(--ff-border-light)] max-h-[60vh] overflow-y-auto">
                  {payments.map(p => (
                    <button key={p.id} onClick={() => selectPayment(p)}
                      className={`w-full text-left px-4 py-3 hover:bg-[var(--ff-bg-tertiary)] transition-colors ${selected?.id === p.id ? 'bg-blue-500/10 border-l-2 border-blue-500' : ''}`}>
                      <div className="flex justify-between">
                        <span className="text-sm font-medium text-[var(--ff-text-primary)]">{p.paymentNumber}</span>
                        <span className="text-sm font-mono text-amber-400">{fmt(p.amount - p.allocatedAmount)}</span>
                      </div>
                      <div className="text-xs text-[var(--ff-text-tertiary)]">{p.clientName} &middot; {p.date?.split('T')[0]}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Outstanding Invoices */}
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
              <div className="px-4 py-3 border-b border-[var(--ff-border-light)] text-sm font-medium text-[var(--ff-text-secondary)]">
                {selected ? `Invoices for ${selected.clientName}` : 'Select a receipt'}
              </div>
              {!selected ? (
                <div className="p-8 text-center text-[var(--ff-text-tertiary)]"><AlertCircle className="h-6 w-6 mx-auto mb-2" />Select a receipt to allocate</div>
              ) : loadingInv ? (
                <div className="p-8 text-center"><Loader2 className="h-6 w-6 animate-spin text-[var(--ff-text-tertiary)] mx-auto" /></div>
              ) : invoices.length === 0 ? (
                <div className="p-8 text-center text-[var(--ff-text-tertiary)]">No outstanding invoices</div>
              ) : (
                <>
                  <div className="divide-y divide-[var(--ff-border-light)] max-h-[50vh] overflow-y-auto">
                    {invoices.map(inv => (
                      <label key={inv.id} className="flex items-center gap-3 px-4 py-3 hover:bg-[var(--ff-bg-tertiary)] cursor-pointer">
                        <input type="checkbox" checked={allocs[inv.id] !== undefined} onChange={() => toggleAlloc(inv)}
                          className="rounded border-[var(--ff-border-light)]" />
                        <div className="flex-1">
                          <div className="flex justify-between">
                            <span className="text-sm text-[var(--ff-text-primary)]">{inv.invoiceNumber}</span>
                            <span className="text-sm font-mono text-[var(--ff-text-primary)]">{fmt(inv.outstanding)}</span>
                          </div>
                          <p className="text-xs text-[var(--ff-text-tertiary)]">{inv.date?.split('T')[0]} &middot; Total: {fmt(inv.total)}</p>
                        </div>
                        {allocs[inv.id] !== undefined && (
                          <input type="number" value={allocs[inv.id]} step="0.01" min="0" max={inv.outstanding}
                            onChange={e => setAllocs(prev => ({ ...prev, [inv.id]: Number(e.target.value) }))}
                            onClick={e => e.stopPropagation()}
                            className="w-28 px-2 py-1 text-right bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] rounded text-sm font-mono text-[var(--ff-text-primary)]" />
                        )}
                      </label>
                    ))}
                  </div>
                  {totalAlloc > 0 && (
                    <div className="px-4 py-3 border-t border-[var(--ff-border-light)] flex items-center justify-between">
                      <span className="text-sm text-[var(--ff-text-secondary)]">Allocating: <strong className="text-[var(--ff-text-primary)]">{fmt(totalAlloc)}</strong></span>
                      <button onClick={doAllocate} disabled={saving}
                        className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium">
                        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Allocate
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
