/**
 * Create Customer Invoice — two-column document editor layout
 */
import { useState, useEffect, useRef } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { FileText, Loader2, Info } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { ApiEnvelopeError, apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { localISODate } from '@/lib/dateUtils';
import { ScanAndFillButton } from '@/components/accounting/ScanAndFillButton';
import { fuzzyMatchClient } from '@/modules/accounting/utils/fuzzyMatch';
import { previewTotals } from '@/modules/accounting/services/ar/invoiceLineAmount';
import { toFunctional } from '@/modules/accounting/services/shared/functionalAmounts';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';
import { InvoiceLineItemsTable, type InvoiceLine } from '@/components/accounting/customer-invoices/InvoiceLineItemsTable';
import { InvoiceHeaderFields, InvoiceNotesCard, type InvoiceCurrency } from '@/components/accounting/customer-invoices/InvoiceHeaderFields';
import { InvoiceSummaryCard } from '@/components/accounting/customer-invoices/InvoiceSummaryCard';
import { invoiceDateProblem, isoOrEmpty, useInvoiceDateValidity, type InvoiceHeaderForm } from '@/components/accounting/customer-invoices/invoiceHeaderForm';
import { useInvoiceLineCodingOptions } from '@/components/accounting/customer-invoices/useInvoiceLineCodingOptions';
import { useContactDefaults } from '@/components/accounting/customer-invoices/useContactDefaults';
import { effectiveTaxRate, inclusiveTypedTotal, lineTotalForMode, storedUnitPrice, type TaxMode } from '@/components/accounting/customer-invoices/taxMode';

interface Client { id: string; name: string }
type LineItem = InvoiceLine;
const UNCODED = { glAccountId: '', projectId: '', cc2Id: '', buId: '' };

export default function NewCustomerInvoicePage() {
  const router = useRouter();
  const [scanned, setScanned] = useState<Client | null>(null); // the client a scan matched, so the picker need not look it up
  const [currencies, setCurrencies] = useState<InvoiceCurrency[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [saveAndNew, setSaveAndNew] = useState(false);
  const [error, setError] = useState('');
  const [scanBanner, setScanBanner] = useState<string | null>(null);
  const today = localISODate();

  const dates = useInvoiceDateValidity();
  const [resetKey, setResetKey] = useState(0);
  const [form, setForm] = useState<InvoiceHeaderForm>({ clientId: '', invoiceDate: today, dueDate: '', billingPeriodStart: today, billingPeriodEnd: today, taxRate: 15, notes: '', currencyCode: 'ZAR', exchangeRate: 1, projectId: '' });
  const [lines, setLines] = useState<LineItem[]>([{ key: '1', description: '', quantity: 1, unitPrice: 0, incomeType: 'other', discount: 0, ...UNCODED }]);
  const [taxMode, setTaxMode] = useState<TaxMode>('exclusive');
  const contact = useContactDefaults({ clientId: form.clientId, invoiceDate: form.invoiceDate, setForm, setLines, setTaxMode });
  const pickTaxMode = (mode: TaxMode) => { contact.touch('taxMode'); setTaxMode(mode); };

  useEffect(() => {
    apiFetch('/api/accounting/currencies', { credentials: 'include' }).then(async r => { await assertOk(r, 'Could not load currencies - try again'); return r.json(); }).then(json => {
      const d = json.data || json; setCurrencies(Array.isArray(d) ? d : []);
    }).catch(err => setError(apiErrorMessage(err, 'Could not load currencies - try again')));
  }, []);

  const updateLine = (key: string, field: string, value: string | number) =>
    setLines(prev => prev.map(l => l.key === key ? { ...l, [field]: value } : l));
  // A new line starts on the invoice's project: a visible default the user can change, not a posting fallback.
  const addLine = () => setLines(prev => [...prev, { key: String(Date.now()), description: '', quantity: 1, unitPrice: 0, incomeType: 'other', discount: contact.lineDiscount, ...UNCODED, projectId: form.projectId }]);
  const codingOptions = useInvoiceLineCodingOptions();
  // A line nobody has typed into yet (the initial one) follows the header project; a worked line keeps its own.
  const pickProject = (v: string) => {
    setLines(prev => prev.map(l => (!l.description && !l.unitPrice && l.projectId === form.projectId ? { ...l, projectId: v } : l)));
    setForm(p => ({ ...p, projectId: v }));
  };
  const removeLine = (key: string) => setLines(prev => prev.length > 1 ? prev.filter(l => l.key !== key) : prev);

  // Priced as the server stores it (invoiceLineAmount.ts); a half-typed field previews as 0, not a crash.
  const taxRate = effectiveTaxRate(taxMode, form.taxRate);
  const lineTotal = (l: LineItem) => lineTotalForMode(taxMode, taxRate, l);
  const { subtotal, tax, total } = previewTotals(lines.map(lineTotal), taxRate);
  const isFx = form.currencyCode !== 'ZAR';
  // A preview only: the stored figure is public.fx_functional's, and toFunctional is its exact twin.
  const zarTotal = Number.isFinite(total) && Number.isFinite(form.exchangeRate) ? toFunctional(total, form.exchangeRate) : 0;

  // The picker searches for itself; the full list is only needed here, to match a scanned name, so it is fetched on demand.
  // Bumped by every scan, every client the user picks and every form reset: a lookup answers only if none of them happened since.
  const lookupSeq = useRef(0);
  async function matchScannedClient(name: string, seq: number) {
    try {
      const res = await apiFetch('/api/accounting/customers', { credentials: 'include' });
      await assertOk(res, 'Could not load clients - try again');
      const json = await res.json();
      if (lookupSeq.current !== seq) return;
      const d = json.data || json;
      const clients: Client[] = Array.isArray(d) ? d : d.clients || [];
      const match = fuzzyMatchClient(name, clients);
      const hit = match ? clients.find(c => String(c.id) === String(match.id)) : undefined;
      if (hit) { setForm(f => ({ ...f, clientId: String(hit.id) })); setScanned({ id: String(hit.id), name: hit.name }); }
    } catch (err) { if (lookupSeq.current === seq) setError(apiErrorMessage(err, 'Could not load clients - try again')); }
  }

  function handleExtracted(data: ExtractedDocument) {
    // A scan is OCR output: only a real YYYY-MM-DD goes in (anything else would make DateField's minDate throw); else the field is left empty.
    const updates: Partial<InvoiceHeaderForm> = {};
    if (data.date) updates.invoiceDate = isoOrEmpty(data.date);
    if (data.dueDate) { updates.dueDate = isoOrEmpty(data.dueDate); contact.touch('dueDate'); }
    if (data.vatRate !== null) updates.taxRate = data.vatRate;
    // A scan reads the rate and ex-VAT prices off the document, so the form goes back to taking them as they are.
    if (data.vatRate !== null || (taxMode === 'inclusive' && data.lineItems.length > 0)) pickTaxMode('exclusive');
    setForm(f => ({ ...f, ...updates }));
    dates.clear(); setResetKey(k => k + 1);
    const seq = ++lookupSeq.current;
    if (data.customerName) void matchScannedClient(data.customerName, seq);
    if (data.lineItems.length > 0) {
      setLines(data.lineItems.map(li => ({ key: String(Date.now() + Math.random()), description: li.description, quantity: li.quantity ?? 1, unitPrice: li.unitPrice ?? 0, incomeType: 'other', discount: 0, ...UNCODED, projectId: form.projectId })));
    }
    setScanBanner(`Auto-filled (${Math.round(data.confidence * 100)}% confidence). Review all fields.`);
  }

  const handleSubmit = async (andNew = false) => {
    if (!form.clientId) return setError('Select a client');
    const validLines = lines.map(l => ({ ...l, unitPrice: storedUnitPrice(taxMode, l.unitPrice, taxRate) })).filter(l => l.description && l.unitPrice > 0);
    if (validLines.length === 0) return setError('Add at least one line item');
    const dateProblem = invoiceDateProblem(form, dates.refused);
    if (dateProblem) return setError(dateProblem);
    if (isFx && form.exchangeRate <= 0) return setError('Exchange rate must be greater than 0');
    setSaveAndNew(andNew);
    setSubmitting(true); setError('');
    try {
      const res = await apiFetch('/api/accounting/customer-invoices-create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, taxRate, items: validLines }) });
      await assertOk(res, 'Could not create the invoice - try again');
      const json = await res.json() as { data?: { id?: string }; id?: string };
      const d = json.data || json;
      if (andNew) {
        const today = localISODate();
        setForm({ clientId: '', invoiceDate: today, dueDate: '', billingPeriodStart: today, billingPeriodEnd: today, taxRate: 15, notes: '', currencyCode: 'ZAR', exchangeRate: 1, projectId: '' });
        setLines([{ key: '1', description: '', quantity: 1, unitPrice: 0, incomeType: 'other', discount: 0, ...UNCODED }]);
        setTaxMode('exclusive'); contact.reset();
        dates.clear(); setResetKey(k => k + 1); lookupSeq.current++;
        try { await router.push('/accounting/customer-invoices/new'); } catch (e) { log.warn('navigation failed', { error: e }, 'customer-invoices-new'); }
      } else {
        if (!d.id) throw new ApiEnvelopeError('The invoice could not be opened - check the invoice list before creating it again');
        try { await router.push(`/accounting/customer-invoices/${d.id}`); } catch (e) { log.warn('navigation failed', { error: e }, 'customer-invoices-new'); }
      }
    } catch (e) { setError(apiErrorMessage(e, 'Could not create the invoice - try again')); }
    finally { setSubmitting(false); }
  };

  return (
    <AppLayout>
      <Head><title>New invoice · Sales · IsaFlow</title></Head>
      <div className="min-h-screen bg-slate-50 dark:bg-[var(--ff-bg-primary)]">
        <PageHeader
          icon={FileText}
          title="Customer Invoice"
          breadcrumb={[{ label: 'Invoices', href: '/accounting/customer-invoices' }, { label: 'New invoice' }]}
          actions={<ScanAndFillButton onExtracted={handleExtracted} label="Scan Invoice" />}
          className="mb-0"
        />

        <div className="p-4 sm:p-6 xl:p-8">
          <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6 items-start">
            <div className="min-w-0 space-y-5">
              {scanBanner && (
                <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-xl border border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-400 text-sm flex items-center gap-2">
                  <Info className="h-4 w-4 flex-shrink-0" />{scanBanner}
                  <button onClick={() => setScanBanner(null)} className="ml-auto text-xs font-medium opacity-70 hover:opacity-100">Dismiss</button>
                </div>
              )}
              {(error || contact.error) && <div role="alert" className="p-3 bg-red-50 dark:bg-red-900/20 rounded-xl border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm">{error || contact.error}</div>}

              <InvoiceHeaderFields form={form} currencies={currencies} options={codingOptions}
                onChange={patch => { if ('clientId' in patch) lookupSeq.current++; if ('taxRate' in patch) contact.touch('taxMode'); setForm(p => ({ ...p, ...patch })); }}
                onProjectChange={pickProject} onDateValidity={dates.report} refused={dates.refused} resetKey={resetKey} clientLabel={scanned?.id === form.clientId ? scanned.name : undefined}
                taxMode={taxMode} onTaxModeChange={pickTaxMode} hints={contact.hints} onDueDateEdited={() => contact.touch('dueDate')} />

              <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
                <InvoiceLineItemsTable lines={lines} currencyCode={form.currencyCode} lineTotal={lineTotal}
                  onUpdate={updateLine} onAdd={addLine} onRemove={removeLine} options={codingOptions} showIncomeType pricesIncludeVat={taxMode === 'inclusive'}
                  discountHint={lines.some(l => l.discount === contact.lineDiscount) ? contact.hints.discount : undefined} />
              </div>

              <InvoiceNotesCard value={form.notes} onChange={notes => setForm(p => ({ ...p, notes }))} placeholder="Add any notes or payment instructions…" />
            </div>

            <div className="lg:sticky lg:top-6 space-y-4">
              <InvoiceSummaryCard subtotal={subtotal} tax={tax} total={total} taxRate={taxRate} currencyCode={form.currencyCode}
                fx={isFx ? { zarTotal, rate: form.exchangeRate } : undefined} {...(taxMode === 'inclusive' ? { typedTotal: inclusiveTypedTotal(lines) } : {})}>
                <button onClick={() => handleSubmit(false)} disabled={submitting} className="w-full mt-6 py-3 bg-brand-600 hover:bg-brand-700 text-white font-semibold rounded-xl transition-colors shadow-lg shadow-amber-500/20 disabled:opacity-50 flex items-center justify-center gap-2 text-sm">
                  {submitting && !saveAndNew ? <><Loader2 className="h-4 w-4 animate-spin" />Creating…</> : <><FileText className="h-4 w-4" />Create Invoice</>}
                </button>
                <button onClick={() => handleSubmit(true)} disabled={submitting} className="w-full mt-2 py-2.5 border border-amber-500 text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20 font-semibold rounded-xl transition-colors disabled:opacity-50 flex items-center justify-center gap-2 text-sm">
                  {submitting && saveAndNew ? <><Loader2 className="h-4 w-4 animate-spin" />Creating…</> : <><FileText className="h-4 w-4" />Save &amp; New</>}
                </button>
              </InvoiceSummaryCard>
              <p className="text-xs text-slate-500 dark:text-slate-400 text-center px-2">Invoice will be saved as a draft. You can email it from the invoice detail page.</p>
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
