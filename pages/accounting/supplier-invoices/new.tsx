/**
 * Create Supplier Invoice Page
 * PRD-060 Phase 2: Capture invoice with line items
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, Receipt, Plus, Trash2, Loader2 } from 'lucide-react';

interface LineItem {
  key: string;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  glAccountId: string;
}

interface Supplier { id: number; name: string }
interface GLAccount { id: string; accountCode: string; accountName: string }

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(amount);
}

export default function NewSupplierInvoicePage() {
  const router = useRouter();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [glAccounts, setGLAccounts] = useState<GLAccount[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  const [form, setForm] = useState({
    invoiceNumber: '',
    supplierId: '',
    invoiceDate: new Date().toISOString().split('T')[0],
    dueDate: '',
    paymentTerms: 'net30',
    reference: '',
    notes: '',
    taxRate: 15,
  });

  const [lines, setLines] = useState<LineItem[]>([
    { key: crypto.randomUUID(), description: '', quantity: 1, unitPrice: 0, taxRate: 15, glAccountId: '' },
  ]);

  useEffect(() => {
    Promise.all([
      fetch('/api/suppliers').then(r => r.json()),
      fetch('/api/accounting/chart-of-accounts').then(r => r.json()),
    ]).then(([suppRes, accRes]) => {
      const suppData = suppRes.data || suppRes;
      setSuppliers(Array.isArray(suppData) ? suppData : suppData.suppliers || []);
      const accData = accRes.data || accRes;
      setGLAccounts(Array.isArray(accData) ? accData.filter((a: GLAccount) => a.accountCode >= '5000') : []);
    });
  }, []);

  const addLine = () => {
    setLines(prev => [...prev, {
      key: crypto.randomUUID(), description: '', quantity: 1, unitPrice: 0,
      taxRate: form.taxRate, glAccountId: '',
    }]);
  };

  const updateLine = (key: string, field: keyof LineItem, value: string | number) => {
    setLines(prev => prev.map(l => l.key === key ? { ...l, [field]: value } : l));
  };

  const removeLine = (key: string) => {
    if (lines.length <= 1) return;
    setLines(prev => prev.filter(l => l.key !== key));
  };

  const subtotal = lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0);
  const totalTax = lines.reduce((sum, l) => sum + (l.quantity * l.unitPrice * l.taxRate / 100), 0);
  const total = subtotal + totalTax;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/accounting/supplier-invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          invoiceNumber: form.invoiceNumber,
          supplierId: form.supplierId,
          invoiceDate: form.invoiceDate,
          dueDate: form.dueDate || undefined,
          paymentTerms: form.paymentTerms || undefined,
          reference: form.reference || undefined,
          notes: form.notes || undefined,
          taxRate: form.taxRate,
          items: lines.map(l => ({
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            taxRate: l.taxRate,
            glAccountId: l.glAccountId || undefined,
          })),
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error?.message || 'Failed to create invoice');
      }

      const json = await res.json();
      const invoice = json.data || json;
      router.push(`/accounting/supplier-invoices/${invoice.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create invoice');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Link href="/accounting/supplier-invoices" className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-emerald-600 mb-3">
            <ArrowLeft className="h-4 w-4" /> Back to Supplier Invoices
          </Link>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-emerald-500/10">
              <Receipt className="h-6 w-6 text-emerald-500" />
            </div>
            <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">New Supplier Invoice</h1>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6 max-w-5xl">
          {error && (
            <div className="p-3 bg-red-500/10 rounded-lg text-red-400 text-sm">{error}</div>
          )}

          {/* Invoice Details */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6">
            <h3 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Invoice Details</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Invoice Number *</label>
                <input type="text" required value={form.invoiceNumber}
                  onChange={e => setForm(f => ({ ...f, invoiceNumber: e.target.value }))}
                  className="ff-input w-full" placeholder="INV-001" />
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Supplier *</label>
                <select required value={form.supplierId}
                  onChange={e => setForm(f => ({ ...f, supplierId: e.target.value }))}
                  className="ff-select w-full">
                  <option value="">Select supplier...</option>
                  {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Invoice Date *</label>
                <input type="date" required value={form.invoiceDate}
                  onChange={e => setForm(f => ({ ...f, invoiceDate: e.target.value }))}
                  className="ff-input w-full" />
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Payment Terms</label>
                <select value={form.paymentTerms}
                  onChange={e => setForm(f => ({ ...f, paymentTerms: e.target.value }))}
                  className="ff-select w-full">
                  <option value="">None</option>
                  <option value="immediate">Immediate</option>
                  <option value="net30">Net 30</option>
                  <option value="net60">Net 60</option>
                  <option value="net90">Net 90</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Reference</label>
                <input type="text" value={form.reference}
                  onChange={e => setForm(f => ({ ...f, reference: e.target.value }))}
                  className="ff-input w-full" placeholder="PO ref or delivery note" />
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">VAT Rate (%)</label>
                <input type="number" step="0.01" value={form.taxRate}
                  onChange={e => setForm(f => ({ ...f, taxRate: Number(e.target.value) }))}
                  className="ff-input w-full" />
              </div>
            </div>
          </div>

          {/* Line Items */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-[var(--ff-text-primary)]">Line Items</h3>
              <button type="button" onClick={addLine}
                className="inline-flex items-center gap-1 text-sm text-emerald-600 hover:text-emerald-700 font-medium">
                <Plus className="h-4 w-4" /> Add Line
              </button>
            </div>
            <div className="space-y-3">
              {lines.map((line, idx) => (
                <div key={line.key} className="grid grid-cols-12 gap-2 items-end">
                  <div className="col-span-4">
                    {idx === 0 && <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Description *</label>}
                    <input type="text" required value={line.description}
                      onChange={e => updateLine(line.key, 'description', e.target.value)}
                      className="ff-input w-full text-sm" placeholder="Item description" />
                  </div>
                  <div className="col-span-1">
                    {idx === 0 && <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Qty</label>}
                    <input type="number" step="0.01" min="0.01" required value={line.quantity}
                      onChange={e => updateLine(line.key, 'quantity', Number(e.target.value))}
                      className="ff-input w-full text-sm text-right" />
                  </div>
                  <div className="col-span-2">
                    {idx === 0 && <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Unit Price</label>}
                    <input type="number" step="0.01" min="0" required value={line.unitPrice}
                      onChange={e => updateLine(line.key, 'unitPrice', Number(e.target.value))}
                      className="ff-input w-full text-sm text-right" />
                  </div>
                  <div className="col-span-2">
                    {idx === 0 && <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">GL Account</label>}
                    <select value={line.glAccountId}
                      onChange={e => updateLine(line.key, 'glAccountId', e.target.value)}
                      className="ff-select w-full text-sm">
                      <option value="">Default (5100)</option>
                      {glAccounts.map(a => (
                        <option key={a.id} value={a.id}>{a.accountCode} - {a.accountName}</option>
                      ))}
                    </select>
                  </div>
                  <div className="col-span-2">
                    {idx === 0 && <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Line Total</label>}
                    <div className="ff-input w-full text-sm text-right bg-[var(--ff-bg-tertiary)] font-mono">
                      {formatCurrency(line.quantity * line.unitPrice)}
                    </div>
                  </div>
                  <div className="col-span-1 flex justify-center">
                    {lines.length > 1 && (
                      <button type="button" onClick={() => removeLine(line.key)}
                        className="p-1 text-red-400 hover:text-red-300">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Totals */}
            <div className="mt-4 pt-4 border-t border-[var(--ff-border-light)] flex justify-end">
              <div className="w-64 space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-[var(--ff-text-secondary)]">Subtotal</span>
                  <span className="font-mono text-[var(--ff-text-primary)]">{formatCurrency(subtotal)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-[var(--ff-text-secondary)]">VAT</span>
                  <span className="font-mono text-[var(--ff-text-primary)]">{formatCurrency(totalTax)}</span>
                </div>
                <div className="flex justify-between text-base font-bold border-t border-[var(--ff-border-medium)] pt-2">
                  <span className="text-[var(--ff-text-primary)]">Total</span>
                  <span className="font-mono text-emerald-500">{formatCurrency(total)}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Notes */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6">
            <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Notes</label>
            <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              className="ff-input w-full" rows={3} placeholder="Optional notes..." />
          </div>

          {/* Submit */}
          <div className="flex justify-end gap-3">
            <Link href="/accounting/supplier-invoices"
              className="px-4 py-2 border border-[var(--ff-border-medium)] rounded-lg text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)] text-sm font-medium">
              Cancel
            </Link>
            <button type="submit" disabled={isSubmitting}
              className="inline-flex items-center gap-2 px-6 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 text-sm font-medium disabled:opacity-50">
              {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
              Create Invoice
            </button>
          </div>
        </form>
      </div>
    </AppLayout>
  );
}
