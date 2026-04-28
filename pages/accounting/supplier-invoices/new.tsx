/**
 * Create Supplier Invoice Page
 * PRD-060 Phase 2: Capture invoice with line items + 3-way match (PO + GRN)
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, Info } from 'lucide-react';
import { ScanAndFillButton } from '@/components/accounting/ScanAndFillButton';
import { fuzzyMatchSupplier } from '@/modules/accounting/utils/fuzzyMatch';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';
import { apiFetch } from '@/lib/apiFetch';
import { PoGrnSelector } from '@/components/accounting/suppliers/PoGrnSelector';
import type { PoLineItem } from '@/components/accounting/suppliers/PoGrnSelector';
import { BillLineItemsTable } from '@/components/accounting/suppliers/BillLineItemsTable';
import type { BillLineItem, GLAccount } from '@/components/accounting/suppliers/BillLineItemsTable';
import { InvoiceNumberField } from '@/components/accounting/suppliers/InvoiceNumberField';
import { SupplierInvoiceSummaryCard } from '@/components/accounting/suppliers/SupplierInvoiceSummaryCard';

interface Supplier { id: number; name: string }

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
    useSequence: true,
    supplierId: '',
    invoiceDate: new Date().toISOString().split('T')[0],
    dueDate: '',
    paymentTerms: 'net30',
    reference: '',
    notes: '',
    taxRate: 15,
    purchaseOrderId: '',
    grnId: '',
    copyLinesFromPo: false,
  });
  const [sequencePreview, setSequencePreview] = useState<string>('');

  const [lines, setLines] = useState<BillLineItem[]>([
    { key: crypto.randomUUID(), description: '', quantity: 1, unitPrice: 0, taxRate: 15, glAccountId: '' },
  ]);

  useEffect(() => {
    void Promise.all([
      apiFetch('/api/accounting/suppliers-list').then(r => r.json()),
      apiFetch('/api/accounting/chart-of-accounts').then(r => r.json()),
      apiFetch('/api/accounting/company-settings?type=document-numbers').then(r => r.json()),
    ]).then(([suppRes, accRes, settingsRes]) => {
      const suppData = suppRes.data ?? suppRes;
      setSuppliers(Array.isArray(suppData) ? suppData : (suppData.suppliers ?? []));
      const accData = accRes.data ?? accRes;
      setGLAccounts(Array.isArray(accData) ? accData.filter((a: GLAccount) => a.accountCode >= '5000') : []);
      type DocNum = { documentType: string; prefix: string; nextNumber: number; padding: number };
      const docNums = (settingsRes.data ?? settingsRes) as DocNum[];
      const siv = Array.isArray(docNums) ? docNums.find(d => d.documentType === 'supplier_invoice') : undefined;
      if (siv) {
        const padded = String(siv.nextNumber).padStart(siv.padding, '0');
        setSequencePreview(`${siv.prefix}${padded}`);
      } else {
        setError('Could not load SIV sequence from Document Number settings — type a custom number or check Settings → Document Numbers.');
        setForm(f => ({ ...f, useSequence: false }));
      }
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Failed to load form data';
      setError(`${msg}. Disable "Use SIV sequence" to enter a custom number, or retry.`);
      setForm(f => ({ ...f, useSequence: false }));
    });
  }, []);

  function handlePoLineItems(items: PoLineItem[]) {
    if (items.length === 0) return;
    setLines(items.map(item => ({
      key: crypto.randomUUID(),
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      taxRate: item.taxRate,
      glAccountId: '',
    })));
  }

  const addLine = () => setLines(prev => [
    ...prev,
    { key: crypto.randomUUID(), description: '', quantity: 1, unitPrice: 0, taxRate: form.taxRate, glAccountId: '' },
  ]);

  const updateLine = (key: string, field: keyof BillLineItem, value: string | number) =>
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
          invoiceNumber: form.useSequence ? '' : form.invoiceNumber,
          useSequence: form.useSequence,
          supplierId: form.supplierId,
          purchaseOrderId: form.purchaseOrderId || undefined,
          grnId: form.grnId || undefined,
          invoiceDate: form.invoiceDate, dueDate: form.dueDate || undefined,
          paymentTerms: form.paymentTerms || undefined,
          reference: form.reference || undefined,
          notes: form.notes || undefined, taxRate: form.taxRate,
          items: lines.map(l => ({
            description: l.description, quantity: l.quantity,
            unitPrice: l.unitPrice, taxRate: l.taxRate,
            glAccountId: l.glAccountId || undefined,
          })),
        }),
      });
      if (!res.ok) {
        const err = await res.json() as { error?: { message?: string } };
        throw new Error(err.error?.message ?? 'Failed to create invoice');
      }
      const json = await res.json() as { data?: { id: string }; id?: string };
      const invoice = json.data ?? json;
      await router.push(`/accounting/supplier-invoices/${(invoice as { id: string }).id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create invoice');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-slate-50 dark:bg-[var(--ff-bg-primary)]">
        <div className="relative overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 px-6 py-7">
          <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)', backgroundSize: '24px 24px' }} />
          <div className="relative z-10">
            <Link href="/accounting/supplier-invoices" className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 mb-4 transition-colors"><ArrowLeft className="h-3.5 w-3.5" /> Back to Supplier Invoices</Link>
            <div className="flex items-center justify-between">
              <div><p className="text-amber-400 text-xs font-semibold uppercase tracking-widest mb-0.5">New Document</p><h1 className="text-xl font-bold text-white">Supplier Invoice</h1></div>
              <ScanAndFillButton onExtracted={handleExtracted} label="Scan Invoice" />
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 xl:p-8">
          <div className="max-w-6xl mx-auto flex gap-6 items-start">
            {/* Left column */}
            <div className="flex-1 min-w-0 space-y-5">
              {scanBanner && <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-xl border border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-400 text-sm flex items-center gap-2"><Info className="h-4 w-4 flex-shrink-0" />{scanBanner}<button type="button" onClick={() => setScanBanner(null)} className="ml-auto text-xs font-medium opacity-70 hover:opacity-100">Dismiss</button></div>}
              {error && <div className="p-3 bg-red-50 dark:bg-red-900/20 rounded-xl border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm">{error}</div>}

              {/* Section 1 — Invoice Details */}
              <div className={`${card} p-5`}>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                  <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">1</span>
                  Invoice Details
                </h3>
                <div className="grid grid-cols-2 gap-4">
                  <InvoiceNumberField
                    useSequence={form.useSequence}
                    invoiceNumber={form.invoiceNumber}
                    sequencePreview={sequencePreview}
                    onUseSequenceChange={v => setForm(f => ({ ...f, useSequence: v }))}
                    onInvoiceNumberChange={v => setForm(f => ({ ...f, invoiceNumber: v }))}
                  />
                  <div>
                    <label className={lbl}>Supplier *</label>
                    <select required value={form.supplierId}
                      onChange={e => setForm(f => ({
                        ...f, supplierId: e.target.value,
                        purchaseOrderId: '', grnId: '', copyLinesFromPo: false,
                      }))}
                      className={inp}>
                      <option value="">Select supplier…</option>
                      {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>
                  <div><label className={lbl}>Invoice Date *</label><input type="date" required value={form.invoiceDate} onChange={e => setForm(f => ({ ...f, invoiceDate: e.target.value }))} className={inp} /></div>
                  <div><label className={lbl}>Due Date</label><input type="date" value={form.dueDate} onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))} className={inp} /></div>
                  <div>
                    <label className={lbl}>Payment Terms</label>
                    <select value={form.paymentTerms} onChange={e => setForm(f => ({ ...f, paymentTerms: e.target.value }))} className={inp}>
                      <option value="">None</option><option value="immediate">Immediate</option><option value="net30">Net 30</option><option value="net60">Net 60</option><option value="net90">Net 90</option>
                    </select>
                  </div>
                  <div><label className={lbl}>Reference</label><input type="text" value={form.reference} onChange={e => setForm(f => ({ ...f, reference: e.target.value }))} className={inp} placeholder="Free-text ref or delivery note" /></div>
                </div>

                {/* 3-Way match — PO + GRN selectors */}
                <PoGrnSelector
                  supplierId={form.supplierId}
                  selectedPoId={form.purchaseOrderId}
                  selectedGrnId={form.grnId}
                  copyLines={form.copyLinesFromPo}
                  onPoChange={poId => setForm(f => ({ ...f, purchaseOrderId: poId }))}
                  onGrnChange={grnId => setForm(f => ({ ...f, grnId: grnId }))}
                  onCopyLinesChange={copy => setForm(f => ({ ...f, copyLinesFromPo: copy }))}
                  onPoLineItems={handlePoLineItems}
                />
              </div>

              {/* Section 2 — Line Items */}
              <BillLineItemsTable
                lines={lines}
                glAccounts={glAccounts}
                onAdd={addLine}
                onUpdate={updateLine}
                onRemove={removeLine}
              />

              {/* Section 3 — Notes */}
              <div className={`${card} p-5`}>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                  <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">3</span>
                  Notes
                </h3>
                <div>
                  <label className={lbl}>VAT Rate (%)</label>
                  <input type="number" step="0.01" value={form.taxRate}
                    onChange={e => setForm(f => ({ ...f, taxRate: Number(e.target.value) }))}
                    className={`${inp} w-32 mb-4`} />
                </div>
                <textarea value={form.notes}
                  onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  className={`${inp} resize-none`} rows={3} placeholder="Optional notes…" />
              </div>
            </div>

            <SupplierInvoiceSummaryCard
              subtotal={subtotal}
              totalTax={totalTax}
              total={total}
              taxRate={form.taxRate}
              isSubmitting={isSubmitting}
            />
          </div>
        </form>
      </div>
    </AppLayout>
  );
}
