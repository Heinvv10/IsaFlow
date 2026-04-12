/**
 * Create Customer Invoice (standalone)
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, FileText, Plus, Trash2, Loader2, Info, SlidersHorizontal } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { ScanAndFillButton } from '@/components/accounting/ScanAndFillButton';
import { fuzzyMatchClient } from '@/modules/accounting/utils/fuzzyMatch';
import { formatCurrencyAmount } from '@/modules/accounting/services/multiCurrencyService';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';

interface Client { id: string; name: string }
interface Currency { code: string; name: string; symbol: string }
interface LineItem { key: string; description: string; quantity: number; unitPrice: number; incomeType: string; discount: number }

export default function NewCustomerInvoicePage() {
  const router = useRouter();
  const [clients, setClients] = useState<Client[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [scanBanner, setScanBanner] = useState<string | null>(null);
  const today = new Date().toISOString().split('T')[0];

  const [form, setForm] = useState({
    clientId: '', invoiceDate: today, dueDate: '',
    billingPeriodStart: today, billingPeriodEnd: today,
    taxRate: 15, notes: '',
    currencyCode: 'ZAR', exchangeRate: 1,
  });
  const [lines, setLines] = useState<LineItem[]>([{ key: '1', description: '', quantity: 1, unitPrice: 0, incomeType: 'other', discount: 0 }]);
  const [showDiscount, setShowDiscount] = useState(false);

  useEffect(() => {
    apiFetch('/api/accounting/customers', { credentials: 'include' })
      .then(r => r.json())
      .then(json => {
        const d = json.data || json;
        setClients(Array.isArray(d) ? d : d.clients || []);
      })
      .catch(() => { /* reference data load failure — non-critical */ });

    apiFetch('/api/accounting/currencies', { credentials: 'include' })
      .then(r => r.json())
      .then(json => {
        const d = json.data || json;
        setCurrencies(Array.isArray(d) ? d : []);
      })
      .catch(() => { /* currency list load failure — non-critical */ });
  }, []);

  const updateLine = (key: string, field: string, value: string | number) => {
    setLines(prev => prev.map(l => l.key === key ? { ...l, [field]: value } : l));
  };
  const addLine = () => setLines(prev => [...prev, { key: String(Date.now()), description: '', quantity: 1, unitPrice: 0, incomeType: 'other', discount: 0 }]);
  const removeLine = (key: string) => setLines(prev => prev.length > 1 ? prev.filter(l => l.key !== key) : prev);

  const lineTotal = (l: LineItem) => l.quantity * l.unitPrice * (1 - (l.discount || 0) / 100);
  const subtotal = lines.reduce((s, l) => s + lineTotal(l), 0);
  const tax = subtotal * (form.taxRate / 100);
  const total = subtotal + tax;
  const isForeignCurrency = form.currencyCode !== 'ZAR';
  const functionalTotal = Math.round(total * form.exchangeRate * 100) / 100;

  function handleExtracted(data: ExtractedDocument) {
    const updates: Partial<typeof form> = {};
    if (data.date) updates.invoiceDate = data.date;
    if (data.dueDate) updates.dueDate = data.dueDate;
    if (data.vatRate !== null) updates.taxRate = data.vatRate;

    setForm(f => ({ ...f, ...updates }));

    if (data.customerName && clients.length > 0) {
      const match = fuzzyMatchClient(data.customerName, clients);
      if (match) setForm(f => ({ ...f, clientId: String(match.id) }));
    }

    if (data.lineItems.length > 0) {
      setLines(data.lineItems.map(li => ({
        key: String(Date.now() + Math.random()),
        description: li.description,
        quantity: li.quantity ?? 1,
        unitPrice: li.unitPrice ?? 0,
        incomeType: 'other',
        discount: 0,
      })));
    }

    setScanBanner(`Auto-filled (${Math.round(data.confidence * 100)}% confidence). Review all fields.`);
  }

  const handleSubmit = async () => {
    if (!form.clientId) return setError('Select a client');
    const validLines = lines.filter(l => l.description && l.unitPrice > 0);
    if (validLines.length === 0) return setError('Add at least one line item');
    if (isForeignCurrency && form.exchangeRate <= 0) return setError('Exchange rate must be greater than 0');
    setSubmitting(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/customer-invoices-create', {
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
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-500/10"><FileText className="h-6 w-6 text-blue-500" /></div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">New Customer Invoice</h1>
            </div>
            <ScanAndFillButton onExtracted={handleExtracted} label="Scan Invoice" />
          </div>
        </div>

        <div className="p-6 max-w-4xl space-y-6">
          {scanBanner && (
            <div className="p-3 bg-blue-500/10 rounded-lg text-blue-400 text-sm flex items-center gap-2">
              <Info className="h-4 w-4 flex-shrink-0" />{scanBanner}
              <button type="button" onClick={() => setScanBanner(null)} className="ml-auto text-blue-500 hover:text-blue-300 text-xs">Dismiss</button>
            </div>
          )}
          {error && <div className="p-3 bg-red-500/10 rounded-lg text-red-400 text-sm">{error}</div>}

          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-[var(--ff-text-secondary)] mb-1">Client *</label>
                <select name="clientId" value={form.clientId} onChange={e => setForm(p => ({ ...p, clientId: e.target.value }))} className="ff-select w-full text-sm">
                  <option value="">Select client...</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-[var(--ff-text-secondary)] mb-1">VAT Rate %</label>
                <input type="number" name="taxRate" value={form.taxRate} onChange={e => setForm(p => ({ ...p, taxRate: Number(e.target.value) }))} className="ff-input w-full text-sm" />
              </div>
            </div>

            {/* Currency row */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-[var(--ff-text-secondary)] mb-1">Currency</label>
                <select
                  name="currencyCode"
                  value={form.currencyCode}
                  onChange={e => setForm(p => ({ ...p, currencyCode: e.target.value, exchangeRate: e.target.value === 'ZAR' ? 1 : p.exchangeRate }))}
                  className="ff-select w-full text-sm"
                >
                  <option value="ZAR">ZAR — South African Rand</option>
                  {currencies.filter(c => c.code !== 'ZAR').map(c => (
                    <option key={c.code} value={c.code}>{c.code} — {c.name}</option>
                  ))}
                </select>
              </div>
              {isForeignCurrency && (
                <div>
                  <label className="block text-xs text-[var(--ff-text-secondary)] mb-1">
                    Exchange Rate <span className="text-[var(--ff-text-tertiary)]">({form.currencyCode} to ZAR)</span>
                  </label>
                  <input
                    type="number"
                    name="exchangeRate"
                    min={0.000001}
                    step={0.000001}
                    value={form.exchangeRate}
                    onChange={e => setForm(p => ({ ...p, exchangeRate: Number(e.target.value) }))}
                    className="ff-input w-full text-sm"
                    placeholder="e.g. 18.5"
                  />
                </div>
              )}
            </div>

            <div className="grid grid-cols-4 gap-4">
              <div>
                <label className="block text-xs text-[var(--ff-text-secondary)] mb-1">Invoice Date</label>
                <input type="date" name="invoiceDate" value={form.invoiceDate} onChange={e => setForm(p => ({ ...p, invoiceDate: e.target.value }))} className="ff-input w-full text-sm" />
              </div>
              <div>
                <label className="block text-xs text-[var(--ff-text-secondary)] mb-1">Due Date</label>
                <input type="date" name="dueDate" value={form.dueDate} onChange={e => setForm(p => ({ ...p, dueDate: e.target.value }))} className="ff-input w-full text-sm" />
              </div>
              <div>
                <label className="block text-xs text-[var(--ff-text-secondary)] mb-1">Period Start</label>
                <input type="date" name="billingPeriodStart" value={form.billingPeriodStart} onChange={e => setForm(p => ({ ...p, billingPeriodStart: e.target.value }))} className="ff-input w-full text-sm" />
              </div>
              <div>
                <label className="block text-xs text-[var(--ff-text-secondary)] mb-1">Period End</label>
                <input type="date" name="billingPeriodEnd" value={form.billingPeriodEnd} onChange={e => setForm(p => ({ ...p, billingPeriodEnd: e.target.value }))} className="ff-input w-full text-sm" />
              </div>
            </div>
            <div>
              <label className="block text-xs text-[var(--ff-text-secondary)] mb-1">Notes</label>
              <textarea name="notes" value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} rows={2} className="ff-input w-full text-sm" />
            </div>
          </div>

          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            <div className="px-4 py-3 border-b border-[var(--ff-border-light)] flex items-center justify-between">
              <h3 className="text-sm font-semibold text-[var(--ff-text-primary)]">Line Items</h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowDiscount(v => !v)}
                  className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded border transition-colors ${showDiscount ? 'border-teal-500/60 text-teal-400 bg-teal-500/10' : 'border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] hover:border-teal-500/40 hover:text-teal-400'}`}
                  title="Toggle discount column"
                >
                  <SlidersHorizontal className="h-3 w-3" />
                  {showDiscount ? 'Hide Disc.' : 'Disc. %'}
                </button>
                <button onClick={addLine} className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1"><Plus className="h-3 w-3" />Add Line</button>
              </div>
            </div>
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
                  <th className="px-3 py-2 text-left text-xs text-[var(--ff-text-secondary)]">Description</th>
                  <th className="px-3 py-2 text-center text-xs text-[var(--ff-text-secondary)]">Type</th>
                  <th className="px-3 py-2 text-right text-xs text-[var(--ff-text-secondary)]">Qty</th>
                  <th className="px-3 py-2 text-right text-xs text-[var(--ff-text-secondary)]">Unit Price ({form.currencyCode})</th>
                  {showDiscount && (
                    <th className="px-3 py-2 text-right text-xs text-[var(--ff-text-secondary)] w-20">Disc. %</th>
                  )}
                  <th className="px-3 py-2 text-right text-xs text-[var(--ff-text-secondary)]">Total ({form.currencyCode})</th>
                  <th className="px-3 py-2 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {lines.map(l => (
                  <tr key={l.key} className="border-b border-[var(--ff-border-light)]">
                    <td className="px-3 py-2"><input name="description" value={l.description} onChange={e => updateLine(l.key, 'description', e.target.value)} placeholder="Description *" className="ff-input w-full text-sm" /></td>
                    <td className="px-3 py-2"><select name="incomeType" value={l.incomeType} onChange={e => updateLine(l.key, 'incomeType', e.target.value)} className="ff-select text-sm">
                      <option value="activation">Activation</option><option value="bonus">Bonus</option><option value="adjustment">Adjustment</option><option value="other">Other</option>
                    </select></td>
                    <td className="px-3 py-2 w-20"><input type="number" name="quantity" value={l.quantity} onChange={e => updateLine(l.key, 'quantity', Number(e.target.value))} className="ff-input w-full text-sm text-right" /></td>
                    <td className="px-3 py-2 w-28"><input type="number" name="unitPrice" value={l.unitPrice} onChange={e => updateLine(l.key, 'unitPrice', Number(e.target.value))} className="ff-input w-full text-sm text-right" /></td>
                    {showDiscount && (
                      <td className="px-3 py-2 w-20">
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step={0.1}
                          value={l.discount || ''}
                          onChange={e => updateLine(l.key, 'discount', e.target.value === '' ? 0 : Number(e.target.value))}
                          placeholder="0"
                          className="ff-input w-full text-sm text-right"
                        />
                      </td>
                    )}
                    <td className="px-3 py-2 text-right font-mono text-sm">
                      {formatCurrencyAmount(lineTotal(l), form.currencyCode)}
                      {showDiscount && l.discount > 0 && (
                        <span className="block text-xs text-teal-500 dark:text-teal-400">
                          -{l.discount}%
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2"><button onClick={() => removeLine(l.key)} className="text-red-400 hover:text-red-300"><Trash2 className="h-3.5 w-3.5" /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between">
            <div className="text-sm space-y-1">
              <p className="text-[var(--ff-text-secondary)]">
                Subtotal: <span className="font-mono">{formatCurrencyAmount(subtotal, form.currencyCode)}</span>
              </p>
              <p className="text-[var(--ff-text-secondary)]">
                VAT ({form.taxRate}%): <span className="font-mono">{formatCurrencyAmount(tax, form.currencyCode)}</span>
              </p>
              <p className="text-[var(--ff-text-primary)] font-bold">
                Total: <span className="font-mono text-blue-400">{formatCurrencyAmount(total, form.currencyCode)}</span>
              </p>
              {isForeignCurrency && (
                <p className="text-[var(--ff-text-secondary)] text-xs border-t border-[var(--ff-border-light)] pt-1 mt-1">
                  ZAR equivalent: <span className="font-mono text-amber-400">{formatCurrencyAmount(functionalTotal, 'ZAR')}</span>
                  <span className="ml-1 opacity-60">(@ {form.exchangeRate} {form.currencyCode}/ZAR)</span>
                </p>
              )}
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
