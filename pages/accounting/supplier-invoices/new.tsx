/**
 * Create Supplier Invoice Page
 * PRD-060 Phase 2: Capture invoice with line items
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, Receipt, Plus, Trash2, Loader2, Info } from 'lucide-react';
import { ScanAndFillButton } from '@/components/accounting/ScanAndFillButton';
import { fuzzyMatchSupplier } from '@/modules/accounting/utils/fuzzyMatch';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';
import { formatCurrency } from '@/utils/formatters';
import { apiFetch } from '@/lib/apiFetch';

interface LineItem { key: string; description: string; quantity: number; unitPrice: number; taxRate: number; glAccountId: string }
interface Supplier { id: number; name: string }
interface GLAccount { id: string; accountCode: string; accountName: string }

const inp = 'w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 transition-colors';
const lbl = 'block text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5';
const card = 'bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm';

export default function NewSupplierInvoicePage() {
  const router = useRouter();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [glAccounts, setGLAccounts] = useState<GLAccount[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [scanBanner, setScanBanner] = useState<string | null>(null);

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
      apiFetch('/api/accounting/suppliers-list').then(r => r.json()),
      apiFetch('/api/accounting/chart-of-accounts').then(r => r.json()),
    ]).then(([suppRes, accRes]) => {
      const suppData = suppRes.data || suppRes;
      setSuppliers(Array.isArray(suppData) ? suppData : suppData.suppliers || []);
      const accData = accRes.data || accRes;
      setGLAccounts(Array.isArray(accData) ? accData.filter((a: GLAccount) => a.accountCode >= '5000') : []);
    }).catch(() => {/* non-critical */});
  }, []);

  const addLine = () => setLines(prev => [...prev, {
    key: crypto.randomUUID(), description: '', quantity: 1, unitPrice: 0,
    taxRate: form.taxRate, glAccountId: '',
  }]);

  const updateLine = (key: string, field: keyof LineItem, value: string | number) =>
    setLines(prev => prev.map(l => l.key === key ? { ...l, [field]: value } : l));

  const removeLine = (key: string) => {
    if (lines.length <= 1) return;
    setLines(prev => prev.filter(l => l.key !== key));
  };

  const subtotal = lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0);
  const totalTax = lines.reduce((sum, l) => sum + (l.quantity * l.unitPrice * l.taxRate / 100), 0);
  const total = subtotal + totalTax;

  function handleExtracted(data: ExtractedDocument) {
    const updates: Partial<typeof form> = {};
    if (data.referenceNumber) updates.invoiceNumber = data.referenceNumber;
    if (data.date) updates.invoiceDate = data.date;
    if (data.dueDate) updates.dueDate = data.dueDate;
    if (data.purchaseOrderRef) updates.reference = data.purchaseOrderRef;
    if (data.vatRate !== null) updates.taxRate = data.vatRate;
    if (data.paymentTerms) {
      const pt = data.paymentTerms.toLowerCase();
      if (pt.includes('immediate') || pt.includes('cod') || pt.includes('0 day')) updates.paymentTerms = 'immediate';
      else if (pt.includes('30')) updates.paymentTerms = 'net30';
      else if (pt.includes('60')) updates.paymentTerms = 'net60';
      else if (pt.includes('90')) updates.paymentTerms = 'net90';
    }
    setForm(f => ({ ...f, ...updates }));
    if (data.vendorName && suppliers.length > 0) {
      const match = fuzzyMatchSupplier(data.vendorName, suppliers.map(s => ({ id: String(s.id), name: s.name })));
      if (match) setForm(f => ({ ...f, supplierId: String(match.id) }));
    }
    if (data.lineItems.length > 0) {
      setLines(data.lineItems.map(li => ({
        key: crypto.randomUUID(), description: li.description,
        quantity: li.quantity ?? 1, unitPrice: li.unitPrice ?? 0,
        taxRate: data.vatRate ?? form.taxRate, glAccountId: '',
      })));
    }
    setScanBanner(`Auto-filled from document (${Math.round(data.confidence * 100)}% confidence). Review all fields before submitting.`);
  }

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/supplier-invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          invoiceNumber: form.invoiceNumber, supplierId: form.supplierId,
          invoiceDate: form.invoiceDate, dueDate: form.dueDate || undefined,
          paymentTerms: form.paymentTerms || undefined, reference: form.reference || undefined,
          notes: form.notes || undefined, taxRate: form.taxRate,
          items: lines.map(l => ({
            description: l.description, quantity: l.quantity,
            unitPrice: l.unitPrice, taxRate: l.taxRate,
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
      await router.push(`/accounting/supplier-invoices/${invoice.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create invoice');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-slate-50 dark:bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="relative overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 px-6 py-7">
          <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)', backgroundSize: '24px 24px' }} />
          <div className="absolute -top-12 right-8 w-72 h-72 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />
          <div className="relative z-10">
            <Link href="/accounting/supplier-invoices" className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-200 mb-4 transition-colors">
              <ArrowLeft className="h-3.5 w-3.5" /> Back to Supplier Invoices
            </Link>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-amber-400 text-xs font-semibold uppercase tracking-widest mb-0.5">New Document</p>
                <h1 className="text-xl font-bold text-slate-900 dark:text-white">Supplier Invoice</h1>
              </div>
              <ScanAndFillButton onExtracted={handleExtracted} label="Scan Invoice" />
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 xl:p-8">
          <div className="max-w-6xl mx-auto flex gap-6 items-start">
            {/* Left column */}
            <div className="flex-1 min-w-0 space-y-5">
              {scanBanner && (
                <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-xl border border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-400 text-sm flex items-center gap-2">
                  <Info className="h-4 w-4 flex-shrink-0" />{scanBanner}
                  <button type="button" onClick={() => setScanBanner(null)} className="ml-auto text-xs font-medium opacity-70 hover:opacity-100">Dismiss</button>
                </div>
              )}
              {error && (
                <div className="p-3 bg-red-50 dark:bg-red-900/20 rounded-xl border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm">{error}</div>
              )}

              {/* Section 1 — Invoice Details */}
              <div className={`${card} p-5`}>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                  <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">1</span>
                  Invoice Details
                </h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className={lbl}>Invoice Number *</label>
                    <input type="text" name="invoiceNumber" required value={form.invoiceNumber}
                      onChange={e => setForm(f => ({ ...f, invoiceNumber: e.target.value }))}
                      className={inp} placeholder="INV-001" />
                  </div>
                  <div>
                    <label className={lbl}>Supplier *</label>
                    <select name="supplierId" required value={form.supplierId}
                      onChange={e => setForm(f => ({ ...f, supplierId: e.target.value }))}
                      className={inp}>
                      <option value="">Select supplier…</option>
                      {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={lbl}>Invoice Date *</label>
                    <input type="date" name="invoiceDate" required value={form.invoiceDate}
                      onChange={e => setForm(f => ({ ...f, invoiceDate: e.target.value }))}
                      className={inp} />
                  </div>
                  <div>
                    <label className={lbl}>Due Date</label>
                    <input type="date" name="dueDate" value={form.dueDate}
                      onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))}
                      className={inp} />
                  </div>
                  <div>
                    <label className={lbl}>Payment Terms</label>
                    <select name="paymentTerms" value={form.paymentTerms}
                      onChange={e => setForm(f => ({ ...f, paymentTerms: e.target.value }))}
                      className={inp}>
                      <option value="">None</option>
                      <option value="immediate">Immediate</option>
                      <option value="net30">Net 30</option>
                      <option value="net60">Net 60</option>
                      <option value="net90">Net 90</option>
                    </select>
                  </div>
                  <div>
                    <label className={lbl}>Reference</label>
                    <input type="text" name="reference" value={form.reference}
                      onChange={e => setForm(f => ({ ...f, reference: e.target.value }))}
                      className={inp} placeholder="PO ref or delivery note" />
                  </div>
                </div>
              </div>

              {/* Section 2 — Line Items */}
              <div className={`${card} overflow-hidden`}>
                <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                    <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">2</span>
                    Line Items
                  </h3>
                  <button type="button" onClick={addLine}
                    className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-700 text-white font-semibold transition-colors">
                    <Plus className="h-3 w-3" />Add Line
                  </button>
                </div>
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden mx-5 my-4">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 dark:bg-slate-800/60">
                      <tr>
                        <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 dark:text-slate-400">Description</th>
                        <th className="px-3 py-2.5 text-left text-xs font-semibold text-slate-500 dark:text-slate-400 w-36">GL Account</th>
                        <th className="px-3 py-2.5 text-right text-xs font-semibold text-slate-500 dark:text-slate-400 w-20">Qty</th>
                        <th className="px-3 py-2.5 text-right text-xs font-semibold text-slate-500 dark:text-slate-400 w-32">Unit Price</th>
                        <th className="px-4 py-2.5 text-right text-xs font-semibold text-slate-500 dark:text-slate-400 w-32">Total</th>
                        <th className="w-9" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {lines.map(line => (
                        <tr key={line.key} className="group hover:bg-slate-50/50 dark:hover:bg-slate-800/20 transition-colors">
                          <td className="px-3 py-2">
                            <input type="text" required name="description" value={line.description}
                              onChange={e => updateLine(line.key, 'description', e.target.value)}
                              placeholder="Item description" className={inp} />
                          </td>
                          <td className="px-3 py-2">
                            <select name="glAccountId" value={line.glAccountId}
                              onChange={e => updateLine(line.key, 'glAccountId', e.target.value)}
                              className={inp}>
                              <option value="">Default (5100)</option>
                              {glAccounts.map(a => (
                                <option key={a.id} value={a.id}>{a.accountCode} — {a.accountName}</option>
                              ))}
                            </select>
                          </td>
                          <td className="px-3 py-2">
                            <input type="number" step="0.01" min="0.01" required name="quantity" value={line.quantity}
                              onChange={e => updateLine(line.key, 'quantity', Number(e.target.value))}
                              className={`${inp} text-right`} />
                          </td>
                          <td className="px-3 py-2">
                            <input type="number" step="0.01" min="0" required name="unitPrice" value={line.unitPrice}
                              onChange={e => updateLine(line.key, 'unitPrice', Number(e.target.value))}
                              className={`${inp} text-right`} />
                          </td>
                          <td className="px-4 py-2 text-right font-mono text-sm font-semibold text-slate-800 dark:text-slate-200">
                            {formatCurrency(line.quantity * line.unitPrice)}
                          </td>
                          <td className="px-2 py-2">
                            <button type="button" onClick={() => removeLine(line.key)}
                              className="p-1.5 rounded-lg text-slate-700 dark:text-slate-300 dark:text-slate-700 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors opacity-0 group-hover:opacity-100">
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Section 3 — Notes */}
              <div className={`${card} p-5`}>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                  <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">3</span>
                  Notes
                </h3>
                <div>
                  <label className={lbl}>VAT Rate (%)</label>
                  <input type="number" name="taxRate" step="0.01" value={form.taxRate}
                    onChange={e => setForm(f => ({ ...f, taxRate: Number(e.target.value) }))}
                    className={`${inp} w-32 mb-4`} />
                </div>
                <textarea name="notes" value={form.notes}
                  onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  className={`${inp} resize-none`} rows={3} placeholder="Optional notes…" />
              </div>
            </div>

            {/* Right column — sticky summary */}
            <div className="w-72 shrink-0">
              <div className="sticky top-6">
                <div className={`${card} p-5`}>
                  <div className="flex items-center gap-2 mb-5">
                    <Receipt className="w-4 h-4 text-amber-500" />
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Summary</h3>
                  </div>
                  <div className="space-y-3">
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500 dark:text-slate-400">Subtotal</span>
                      <span className="font-mono text-slate-900 dark:text-slate-100">{formatCurrency(subtotal)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500 dark:text-slate-400">VAT ({form.taxRate}%)</span>
                      <span className="font-mono text-slate-900 dark:text-slate-100">{formatCurrency(totalTax)}</span>
                    </div>
                    <div className="h-px bg-slate-100 dark:bg-slate-800" />
                    <div className="flex justify-between">
                      <span className="text-sm font-semibold text-slate-900 dark:text-white">Total</span>
                      <span className="font-mono font-bold text-lg text-amber-500">{formatCurrency(total)}</span>
                    </div>
                  </div>
                  <button type="submit" disabled={isSubmitting}
                    className="w-full mt-6 py-3 bg-teal-600 hover:bg-teal-700 text-white font-semibold rounded-xl transition-colors shadow-lg shadow-amber-500/20 disabled:opacity-50 flex items-center justify-center gap-2 text-sm">
                    {isSubmitting ? <><Loader2 className="h-4 w-4 animate-spin" />Creating…</> : <><Receipt className="h-4 w-4" />Create Invoice</>}
                  </button>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 dark:text-slate-500 text-center px-2 mt-3">
                  Invoice will be saved as a draft. Approve it from the invoice detail page.
                </p>
              </div>
            </div>
          </div>
        </form>
      </div>
    </AppLayout>
  );
}
