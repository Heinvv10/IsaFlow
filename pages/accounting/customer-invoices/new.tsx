/**
 * Create Customer Invoice (standalone)
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, FileText, Plus, Trash2, Loader2 } from 'lucide-react';

const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

interface Client { id: string; company_name: string }
interface LineItem { key: string; description: string; quantity: number; unitPrice: number; incomeType: string }

export default function NewCustomerInvoicePage() {
  const router = useRouter();
  const [clients, setClients] = useState<Client[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const today = new Date().toISOString().split('T')[0];

  const [form, setForm] = useState({ clientId: '', invoiceDate: today, dueDate: '', billingPeriodStart: today, billingPeriodEnd: today, taxRate: 15, notes: '' });
  const [lines, setLines] = useState<LineItem[]>([{ key: '1', description: '', quantity: 1, unitPrice: 0, incomeType: 'other' }]);

  useEffect(() => {
    fetch('/api/clients', { credentials: 'include' }).then(r => r.json()).then(json => {
      const d = json.data || json;
      setClients(Array.isArray(d) ? d : d.clients || []);
    }).catch(() => {});
  }, []);

  const updateLine = (key: string, field: string, value: string | number) => {
    setLines(prev => prev.map(l => l.key === key ? { ...l, [field]: value } : l));
  };
  const addLine = () => setLines(prev => [...prev, { key: String(Date.now()), description: '', quantity: 1, unitPrice: 0, incomeType: 'other' }]);
  const removeLine = (key: string) => setLines(prev => prev.length > 1 ? prev.filter(l => l.key !== key) : prev);

  const subtotal = lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
  const tax = subtotal * (form.taxRate / 100);
  const total = subtotal + tax;

  const handleSubmit = async () => {
    if (!form.clientId) return setError('Select a client');
    const validLines = lines.filter(l => l.description && l.unitPrice > 0);
    if (validLines.length === 0) return setError('Add at least one line item');
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/accounting/customer-invoices-create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, items: validLines }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || 'Failed to create');
      const d = json.data || json;
      router.push(`/accounting/customer-invoices/${d.id}`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed'); setSubmitting(false); }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Link href="/accounting/customer-invoices" className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-blue-400 mb-3">
            <ArrowLeft className="h-4 w-4" /> Back to Invoices
          </Link>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-500/10"><FileText className="h-6 w-6 text-blue-500" /></div>
            <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">New Customer Invoice</h1>
          </div>
        </div>

        <div className="p-6 max-w-4xl space-y-6">
          {error && <div className="p-3 bg-red-500/10 rounded-lg text-red-400 text-sm">{error}</div>}

          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-[var(--ff-text-secondary)] mb-1">Client *</label>
                <select value={form.clientId} onChange={e => setForm(p => ({ ...p, clientId: e.target.value }))} className="ff-select w-full text-sm">
                  <option value="">Select client...</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.company_name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-[var(--ff-text-secondary)] mb-1">VAT Rate %</label>
                <input type="number" value={form.taxRate} onChange={e => setForm(p => ({ ...p, taxRate: Number(e.target.value) }))} className="ff-input w-full text-sm" />
              </div>
            </div>
            <div className="grid grid-cols-4 gap-4">
              <div>
                <label className="block text-xs text-[var(--ff-text-secondary)] mb-1">Invoice Date</label>
                <input type="date" value={form.invoiceDate} onChange={e => setForm(p => ({ ...p, invoiceDate: e.target.value }))} className="ff-input w-full text-sm" />
              </div>
              <div>
                <label className="block text-xs text-[var(--ff-text-secondary)] mb-1">Due Date</label>
                <input type="date" value={form.dueDate} onChange={e => setForm(p => ({ ...p, dueDate: e.target.value }))} className="ff-input w-full text-sm" />
              </div>
              <div>
                <label className="block text-xs text-[var(--ff-text-secondary)] mb-1">Period Start</label>
                <input type="date" value={form.billingPeriodStart} onChange={e => setForm(p => ({ ...p, billingPeriodStart: e.target.value }))} className="ff-input w-full text-sm" />
              </div>
              <div>
                <label className="block text-xs text-[var(--ff-text-secondary)] mb-1">Period End</label>
                <input type="date" value={form.billingPeriodEnd} onChange={e => setForm(p => ({ ...p, billingPeriodEnd: e.target.value }))} className="ff-input w-full text-sm" />
              </div>
            </div>
            <div>
              <label className="block text-xs text-[var(--ff-text-secondary)] mb-1">Notes</label>
              <textarea value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} rows={2} className="ff-input w-full text-sm" />
            </div>
          </div>

          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            <div className="px-4 py-3 border-b border-[var(--ff-border-light)] flex items-center justify-between">
              <h3 className="text-sm font-semibold text-[var(--ff-text-primary)]">Line Items</h3>
              <button onClick={addLine} className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1"><Plus className="h-3 w-3" />Add Line</button>
            </div>
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
                  <th className="px-3 py-2 text-left text-xs text-[var(--ff-text-secondary)]">Description</th>
                  <th className="px-3 py-2 text-center text-xs text-[var(--ff-text-secondary)]">Type</th>
                  <th className="px-3 py-2 text-right text-xs text-[var(--ff-text-secondary)]">Qty</th>
                  <th className="px-3 py-2 text-right text-xs text-[var(--ff-text-secondary)]">Unit Price</th>
                  <th className="px-3 py-2 text-right text-xs text-[var(--ff-text-secondary)]">Total</th>
                  <th className="px-3 py-2 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {lines.map(l => (
                  <tr key={l.key} className="border-b border-[var(--ff-border-light)]">
                    <td className="px-3 py-2"><input value={l.description} onChange={e => updateLine(l.key, 'description', e.target.value)} placeholder="Description *" className="ff-input w-full text-sm" /></td>
                    <td className="px-3 py-2"><select value={l.incomeType} onChange={e => updateLine(l.key, 'incomeType', e.target.value)} className="ff-select text-sm">
                      <option value="activation">Activation</option><option value="bonus">Bonus</option><option value="adjustment">Adjustment</option><option value="other">Other</option>
                    </select></td>
                    <td className="px-3 py-2 w-20"><input type="number" value={l.quantity} onChange={e => updateLine(l.key, 'quantity', Number(e.target.value))} className="ff-input w-full text-sm text-right" /></td>
                    <td className="px-3 py-2 w-28"><input type="number" value={l.unitPrice} onChange={e => updateLine(l.key, 'unitPrice', Number(e.target.value))} className="ff-input w-full text-sm text-right" /></td>
                    <td className="px-3 py-2 text-right font-mono text-sm">{fmt(l.quantity * l.unitPrice)}</td>
                    <td className="px-3 py-2"><button onClick={() => removeLine(l.key)} className="text-red-400 hover:text-red-300"><Trash2 className="h-3.5 w-3.5" /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between">
            <div className="text-sm space-y-1">
              <p className="text-[var(--ff-text-secondary)]">Subtotal: <span className="font-mono">{fmt(subtotal)}</span></p>
              <p className="text-[var(--ff-text-secondary)]">VAT ({form.taxRate}%): <span className="font-mono">{fmt(tax)}</span></p>
              <p className="text-[var(--ff-text-primary)] font-bold">Total: <span className="font-mono text-blue-400">{fmt(total)}</span></p>
            </div>
            <button onClick={handleSubmit} disabled={submitting} className="px-6 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium disabled:opacity-50">
              {submitting ? <><Loader2 className="h-4 w-4 animate-spin inline mr-1" />Creating...</> : 'Create Invoice'}
            </button>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
