/**
 * Edit Customer Invoice — only allowed while status === 'draft'.
 * Mirrors the new.tsx layout but loads the existing invoice and submits PUT. Autosaves the draft (PR S: the same PUT,
 * never create), asks before leaving with a change unsaved, previews the stored draft's PDF, and offers Approve & email.
 */
import { useState, useEffect, useRef } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, FileText, Loader2, AlertCircle, Send } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { InvoiceEmailModal } from '@/components/invoices/InvoiceEmailModal';
import { log } from '@/lib/logger';
import { previewTotals } from '@/modules/accounting/services/ar/invoiceLineAmount';
import { InvoiceLineItemsTable } from '@/components/accounting/customer-invoices/InvoiceLineItemsTable';
import { InvoiceHeaderFields, InvoiceNotesCard, type InvoiceCurrency } from '@/components/accounting/customer-invoices/InvoiceHeaderFields';
import { InvoiceSummaryCard } from '@/components/accounting/customer-invoices/InvoiceSummaryCard';
import { formatCurrencyAmount } from '@/modules/accounting/services/core/multiCurrencyService';
import { useInvoiceDateValidity, type InvoiceHeaderForm } from '@/components/accounting/customer-invoices/invoiceHeaderForm';
import { useInvoiceLineCodingOptions } from '@/components/accounting/customer-invoices/useInvoiceLineCodingOptions';
import { useCustomerLookup } from '@/components/accounting/customer-invoices/useCustomerLookup';
import { effectiveTaxRate, inclusiveTypedTotal, lineTotalForMode, linesForModeChange, vatTypeWarning, type TaxMode } from '@/components/accounting/customer-invoices/taxMode';
import { autosaveProblem, invoicePutBody, saveProblem, type EditLine, type StoredDates } from '@/components/accounting/customer-invoices/invoicePutBody';
import { useInvoiceAutosave } from '@/components/accounting/customer-invoices/useInvoiceAutosave';
import { InvoiceAutosaveStatus } from '@/components/accounting/customer-invoices/InvoiceAutosaveStatus';
import { InvoicePdfPreview } from '@/components/accounting/customer-invoices/InvoicePdfPreview';
import { invoiceSavesSettled } from '@/lib/pendingInvoiceSaves';
import { linesFromStoredItems, type InvoiceDetail } from '@/components/accounting/customer-invoices/editInvoiceLoad';
import { stashApproveRefusal, takeApproveRefusal, useApproveAndEmail } from '@/components/accounting/customer-invoices/useApproveAndEmail';

// CC2 / BU are edited here; CC1 follows its CC2 (invoicePutBody re-sends it only while the CC2 is the one it loaded with).
type LineItem = EditLine;
const UNCODED = { glAccountId: '', projectId: '', cc2Id: '', buId: '' };
const CUSTOMER_FAILED = "Could not load the customer's VAT type - check the VAT on this invoice by hand";
export default function EditCustomerInvoicePage() {
  const router = useRouter();
  const { invoiceId } = router.query;
  const [currencies, setCurrencies] = useState<InvoiceCurrency[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');

  const dates = useInvoiceDateValidity();
  const clearDates = dates.clear;
  const [form, setForm] = useState<InvoiceHeaderForm>({ clientId: '', invoiceDate: '', dueDate: '', billingPeriodStart: '', billingPeriodEnd: '', taxRate: 15, notes: '', currencyCode: 'ZAR', exchangeRate: 1, projectId: '' });
  const [lines, setLines] = useState<LineItem[]>([]);
  const [taxMode, setTaxMode] = useState<TaxMode>('exclusive'); // a stored price is ex-VAT, so it loads as one
  // Read only to warn: a stored invoice is not refilled, so Save waits for a customer changed here, not for the one it loaded with.
  const [loadedClient, setLoadedClient] = useState('');
  const customer = useCustomerLookup(form.clientId, CUSTOMER_FAILED);
  const [rateEditing, setRateEditing] = useState(false);
  const [approved, setApproved] = useState(false);
  // Which invoice the form holds, and which of its dates were stored (the server keeps one the body leaves out).
  const [loadedFor, setLoadedFor] = useState('');
  const [storedDates, setStoredDates] = useState<StoredDates>({});
  // The approval gate's 409 (APPROVAL_REQUIRED / PENDING / STALE) stays through saves: saving does not answer it, an
  // approver does. A ref: read in the moment a save lands, not in a later render.
  const errorStays = useRef(false);
  const setErrorStays = (v: boolean) => { errorStays.current = v; };
  // The total as stored: priced by older rules (a converted quote, WIP) it can differ from what the lines give now.
  const [storedTotal, setStoredTotal] = useState<number | null>(null);
  const [reloads, setReloads] = useState(0); // a STALE_VIEW refusal reloads what is stored

  useEffect(() => {
    if (!invoiceId) return;
    const id = String(invoiceId);
    setLoading(true); setInvoiceNumber(''); setError(''); setErrorStays(false); setApproved(false); // another invoice opened in place starts again
    let gone = false; // another invoice opened (or a reload) since: this load's answer is not shown
    void invoiceSavesSettled(id).then(() => Promise.all([ // a save of this invoice still out (sent as a page closed) lands first
      apiFetch('/api/accounting/currencies', { credentials: 'include' }).then(async r => { await assertOk(r, 'Could not load currencies - try again'); return r.json(); }),
      apiFetch(`/api/accounting/customer-invoices-detail?id=${id}`, { credentials: 'include' }).then(async r => { await assertOk(r, 'Could not load the invoice - try again'); return r.json(); }),
    ])).then(([curRes, invRes]) => {
      if (gone) return;
      const curData = curRes.data || curRes; setCurrencies(Array.isArray(curData) ? curData : []);
      const invoice: InvoiceDetail = invRes.data || invRes;
      if (!invoice || !invoice.id) { setError('Invoice not found'); setLoading(false); return; }
      if (invoice.status !== 'draft') {
        setError(`This invoice is "${invoice.status}" and can no longer be edited. Only draft invoices are editable.`);
        setLoading(false);
        return;
      }
      setInvoiceNumber(invoice.invoice_number);
      setLoadedFor(id);
      setStoredTotal(invoice.total_amount === undefined || invoice.total_amount === null ? null : Number(invoice.total_amount));
      setStoredDates({ dueDate: Boolean(invoice.due_date), billingPeriodStart: Boolean(invoice.billing_period_start), billingPeriodEnd: Boolean(invoice.billing_period_end) });
      const refusal = takeApproveRefusal(id); // Approve & email on the new page landed here: say why
      if (refusal) { setError(refusal.message); setErrorStays(refusal.status === 409); }
      // No VAT at rate 0 prices exactly as Excluding VAT at rate 0, and says what the invoice is. The form keeps the
      // standard rate behind it, as the new page does, so leaving No VAT does not leave a rate of 0.
      const storedRate = Number(invoice.tax_rate ?? 15);
      setTaxMode(storedRate === 0 ? 'none' : 'exclusive'); // this invoice's own mode, not the one opened before it
      clearDates();
      const clientId = String(invoice.client_id || invoice.customer_id || '');
      setLoadedClient(clientId);
      setForm({
        clientId,
        invoiceDate: String(invoice.invoice_date || '').slice(0, 10),
        dueDate: invoice.due_date ? String(invoice.due_date).slice(0, 10) : '',
        billingPeriodStart: invoice.billing_period_start ? String(invoice.billing_period_start).slice(0, 10) : '',
        billingPeriodEnd: invoice.billing_period_end ? String(invoice.billing_period_end).slice(0, 10) : '',
        taxRate: storedRate === 0 ? 15 : storedRate,
        notes: invoice.notes || '',
        currencyCode: invoice.currency_code || 'ZAR',
        exchangeRate: Number(invoice.exchange_rate ?? 1),
        projectId: invoice.project_id ?? '',
      });
      setLines(linesFromStoredItems(invoice.items || [], invoice.project_id ?? ''));
      setLoading(false);
    }).catch((err: unknown) => {
      if (gone) return;
      setError(apiErrorMessage(err, 'Could not load the invoice - try again'));
      setLoading(false);
    });
    return () => { gone = true; };
  }, [invoiceId, clearDates, reloads]);

  const updateLine = (key: string, field: keyof LineItem, value: string | number) =>
    setLines(prev => prev.map(l => l.key === key ? { ...l, [field]: value } : l));
  // A new line starts on the invoice's project: a visible default the user can change, not a posting fallback.
  const addLine = () => setLines(prev => [...prev, { key: String(Date.now()), description: '', quantity: 1, unitPrice: 0, discount: 0, ...UNCODED, projectId: form.projectId }]);
  const codingOptions = useInvoiceLineCodingOptions([form.projectId, ...lines.map(l => l.projectId)]);
  const removeLine = (key: string) => setLines(prev => prev.length > 1 ? prev.filter(l => l.key !== key) : prev);

  // Priced as the server stores it (invoiceLineAmount.ts); a half-typed field previews as 0, not a crash.
  const taxRate = effectiveTaxRate(taxMode, form.taxRate);
  const lineTotal = (l: LineItem) => lineTotalForMode(taxMode, taxRate, l);
  const pickTaxMode = (mode: TaxMode) => { setLines(ls => linesForModeChange(ls, taxMode, mode, form.taxRate)); setTaxMode(mode); };
  const { subtotal, tax, total } = previewTotals(lines.map(lineTotal), taxRate);

  // One render's form, lines and mode, together: the Save button, autosave and Approve & email all send this body.
  const id = String(invoiceId ?? '');
  const draft = { form, lines, taxMode };
  // Approve & email first: autosave waits while it runs (the form is disabled then too). Its save reads `autosave`
  // only when clicked, after this render has made it.
  // A stored total the lines no longer price to (a quote converted at 0%, a WIP draft rounded per line): never re-saved
  // unasked (that reprices, drops WIP links, stales an approval and makes the clicker an author). Both figures show,
  // and Approve & email refuses until the user saves or approves the stored figure from the invoice page.
  const stalePriced = storedTotal !== null && Math.round(storedTotal * 100) !== Math.round(total * 100);
  const money = (n: number) => formatCurrencyAmount(n, form.currencyCode);
  const approve = useApproveAndEmail({
    save: async () => {
      if (stalePriced && storedTotal !== null && !autosave.unsaved()) {
        setError(`Save to reprice at ${money(total)}, or approve ${money(storedTotal)} from the invoice page`);
        return null;
      }
      return (await saveDraft(false)) ? { id, invoiceNumber } : null;
    },
    onRefused: (_id, message, status, reason) => {
      if (reason === 'STALE_VIEW') { stashApproveRefusal(id, message); setReloads(n => n + 1); return; } // show what is stored, and why
      setError(message); setErrorStays(status === 409);
    },
    onApproved: () => setApproved(true),
    bodyNow: () => autosave.currentBody(),
    shown: { total, currencyCode: form.currencyCode, exchangeRate: form.exchangeRate },
  });
  const dismissApprove = approve.dismiss;
  useEffect(() => { dismissApprove(); }, [invoiceId, dismissApprove]); // another invoice opened in place: not this one's email form
  // A date the server has taken (loaded, or saved on this visit) is kept by it if the body leaves it out.
  const keepStoredDates = (json: string) => {
    // A refusal on screen (a Save, an approval) is answered by this save, in the moment it lands: a refusal that comes
    // after it (Approve & email's approval, just after its save) stays. Not the gate's sticky 409.
    if (!errorStays.current) setError('');
    setStoredTotal(null); // the server just priced this body itself
    const b = JSON.parse(json) as Partial<Record<keyof StoredDates, string>>;
    setStoredDates((d) => ({ dueDate: d.dueDate || Boolean(b.dueDate), billingPeriodStart: d.billingPeriodStart || Boolean(b.billingPeriodStart), billingPeriodEnd: d.billingPeriodEnd || Boolean(b.billingPeriodEnd) }));
  };
  const autosave = useInvoiceAutosave({
    mode: 'server', invoiceId: id, loadKey: reloads, body: !loading && invoiceNumber && loadedFor === id ? invoicePutBody(id, draft) : null,
    problem: autosaveProblem(draft, dates.refused, storedDates), paused: rateEditing || approve.busy, done: approved, onSaved: keepStoredDates,
  });

  const saveDraft = async (always: boolean): Promise<boolean> => {
    setErrorStays(false);
    const problem = saveProblem(draft, dates.refused, storedDates);
    if (problem) { setError(problem); return false; }
    setError('');
    const saved = await autosave.saveNow(always);
    if (!saved.ok) setError(saved.message);
    return saved.ok;
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    let saved = false;
    try { saved = await saveDraft(true); } finally { setSubmitting(false); }
    if (!saved) return;
    try { await router.push(`/accounting/customer-invoices/${id}`); } catch (e) { log.warn('navigation failed', { error: e }, 'customer-invoices-edit-invoiceId'); }
  };

  if (loading) return <AppLayout><Head><title>Edit invoice · Sales · IsaFlow</title></Head><div className="flex items-center justify-center min-h-[60vh]"><Loader2 className="h-8 w-8 animate-spin text-amber-500" /></div></AppLayout>;

  if (error && !invoiceNumber) {
    return (
      <AppLayout>
        <Head><title>Edit invoice · Sales · IsaFlow</title></Head>
        <div className="min-h-[60vh] flex flex-col items-center justify-center gap-4 px-6">
          <AlertCircle className="h-10 w-10 text-red-400" />
          <p className="text-center text-sm text-slate-600 dark:text-slate-300 max-w-md">{error}</p>
          <Link
            href={`/accounting/customer-invoices/${String(invoiceId)}`}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-sm hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            <ArrowLeft className="h-4 w-4" /> Back to Invoice
          </Link>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <Head><title>{`Edit ${invoiceNumber} · Sales · IsaFlow`}</title></Head>
      <div className="min-h-screen bg-slate-50 dark:bg-[var(--ff-bg-primary)]">
        <PageHeader
          icon={FileText}
          title={invoiceNumber}
          breadcrumb={[{ label: 'Invoices', href: '/accounting/customer-invoices' }, { label: 'Invoice', href: `/accounting/customer-invoices/${String(invoiceId)}` }, { label: 'Edit draft' }]}
          className="mb-0"
        />

        <div className="p-4 sm:p-6 xl:p-8">
          <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6 items-start">
            <div className="min-w-0 space-y-5">
              {(error || customer.error) && <div role="alert" className="p-3 bg-red-50 dark:bg-red-900/20 rounded-xl border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm flex items-center gap-2"><AlertCircle className="h-4 w-4" />{error || customer.error}</div>}

              <fieldset disabled={approve.busy || approved} className="min-w-0 space-y-5">
              <InvoiceHeaderFields form={form} onChange={patch => setForm(p => ({ ...p, ...patch }))} currencies={currencies} options={codingOptions}
                onProjectChange={v => setForm(p => ({ ...p, projectId: v }))} onDateValidity={dates.report} refused={dates.refused} taxMode={taxMode} onTaxModeChange={pickTaxMode} vatWarning={vatTypeWarning(customer.defaults?.vatType, taxRate)} onRateEditing={setRateEditing} />

              <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
                <InvoiceLineItemsTable lines={lines} currencyCode={form.currencyCode} lineTotal={lineTotal}
                  onUpdate={updateLine} onAdd={addLine} onRemove={removeLine} options={codingOptions} pricesIncludeVat={taxMode === 'inclusive'} />
              </div>

              <InvoiceNotesCard value={form.notes} onChange={notes => setForm(p => ({ ...p, notes }))} placeholder="Notes or payment instructions…" />
              </fieldset>
              {id && <InvoicePdfPreview invoiceId={id} version={autosave.savedCount} />}
            </div>

            <div className="lg:sticky lg:top-6 space-y-4">
              <InvoiceSummaryCard subtotal={subtotal} tax={tax} total={total} taxRate={taxRate} currencyCode={form.currencyCode} {...(taxMode === 'inclusive' ? { typedTotal: inclusiveTypedTotal(lines) } : {})}>
                {stalePriced && storedTotal !== null && <p className="mt-3 text-xs text-amber-800 dark:text-amber-300">Stored total {money(storedTotal)}; these lines price to {money(total)}. Saving reprices the invoice.</p>}
                <InvoiceAutosaveStatus where="server" state={autosave.state} savedAt={autosave.savedAt} error={autosave.error} held={autosave.held} />
                <button onClick={handleSubmit} disabled={submitting || approve.busy || approved || (customer.pending && form.clientId !== loadedClient)} className="w-full mt-6 py-3 bg-brand-600 hover:bg-brand-700 text-white font-semibold rounded-xl transition-colors shadow-lg disabled:opacity-50 flex items-center justify-center gap-2 text-sm">
                  {submitting ? <><Loader2 className="h-4 w-4 animate-spin" />Saving…</> : <><FileText className="h-4 w-4" />Save Changes</>}
                </button>
                <button onClick={approve.start} disabled={submitting || approve.busy || approved || (customer.pending && form.clientId !== loadedClient)} className="w-full mt-2 py-2.5 border border-amber-500 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20 font-semibold rounded-xl transition-colors disabled:opacity-50 flex items-center justify-center gap-2 text-sm">
                  {approve.busy ? <><Loader2 className="h-4 w-4 animate-spin" />Approving…</> : <><Send className="h-4 w-4" />Approve &amp; email</>}
                </button>
                <Link href={`/accounting/customer-invoices/${String(invoiceId)}`} className="block w-full mt-2 py-2.5 text-center border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 font-semibold rounded-xl transition-colors text-sm">Cancel</Link>
              </InvoiceSummaryCard>
            </div>
          </div>
        </div>
        {approve.modal && <InvoiceEmailModal {...approve.modal} />}
      </div>
    </AppLayout>
  );
}
