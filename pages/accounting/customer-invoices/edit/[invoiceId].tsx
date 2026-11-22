/**
 * Edit Customer Invoice — only allowed while status === 'draft'.
 * Mirrors the new.tsx layout (per-line VAT types, totals under the lines, a sticky action bar) but loads the existing
 * invoice and submits PUT; each loaded line keeps its own VAT type (editInvoiceLoad). Autosaves the draft (PR S: the same PUT,
 * never create), asks before leaving with a change unsaved, previews the stored draft's PDF, and offers Approve & email.
 */
import { useState, useEffect, useRef } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { FileText, Loader2, AlertCircle } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { InvoiceEmailModal } from '@/components/invoices/InvoiceEmailModal';
import { log } from '@/lib/logger';
import { formLineNet, formTotals, formVatByType, lineVatRate, lineVatTypes, lineVatWarning } from '@/components/accounting/customer-invoices/formVat';
import { useTaxModeSwitch } from '@/components/accounting/customer-invoices/useTaxModeSwitch';
import { InvoiceLineItemsTable } from '@/components/accounting/customer-invoices/InvoiceLineItemsTable';
import { InvoiceHeaderFields, InvoiceNotesCard, type InvoiceCurrency } from '@/components/accounting/customer-invoices/InvoiceHeaderFields';
import { fxPreview, InvoiceTotals } from '@/components/accounting/customer-invoices/InvoiceTotals';
import { InvoiceSettingsRow } from '@/components/accounting/customer-invoices/InvoiceSettingsRow';
import { EditInvoiceActions, EditInvoiceUnavailable, InvoiceActionBar } from '@/components/accounting/customer-invoices/NewInvoiceParts';
import { formatCurrencyAmount } from '@/modules/accounting/services/core/multiCurrencyService';
import { sameCents } from '@/modules/accounting/services/shared/functionalAmounts';
import { useInvoiceDateValidity, type InvoiceHeaderForm } from '@/components/accounting/customer-invoices/invoiceHeaderForm';
import { useInvoiceLineCodingOptions } from '@/components/accounting/customer-invoices/useInvoiceLineCodingOptions';
import { useWipLines } from '@/components/accounting/customer-invoices/useWipLines';
import { useCustomerLookup } from '@/components/accounting/customer-invoices/useCustomerLookup';
import { useDueDateFollowsTerms } from '@/components/accounting/customer-invoices/useDueDateFollowsTerms';
import { inclusiveTypedTotal, type TaxMode } from '@/components/accounting/customer-invoices/taxMode';
import { autosaveProblem, invoicePutBody, saveProblem, type EditLine, type StoredDates } from '@/components/accounting/customer-invoices/invoicePutBody';
import { useInvoiceAutosave } from '@/components/accounting/customer-invoices/useInvoiceAutosave';
import { InvoiceAutosaveStatus } from '@/components/accounting/customer-invoices/InvoiceAutosaveStatus';
import { InvoicePdfPreview } from '@/components/accounting/customer-invoices/InvoicePdfPreview';
import { invoiceSavesSettled, takeUnsavedLeave } from '@/lib/pendingInvoiceSaves';
import { linesFromStoredItems, vatAtLoad, type InvoiceDetail } from '@/components/accounting/customer-invoices/editInvoiceLoad';
import { takeApproveRefusal, useApproveAndEmail } from '@/components/accounting/customer-invoices/useApproveAndEmail';

// CC2 / BU are edited here; CC1 follows its CC2 (invoicePutBody re-sends it only while the CC2 is the one it loaded with).
type LineItem = EditLine;
const UNCODED = { glAccountId: '', projectId: '', cc2Id: '', buId: '' };
const STALE_PRICED_HOLD = "this draft's stored total is not what its lines price to; Save Changes reprices it";
const CUSTOMER_FAILED = "Could not load the customer's VAT type - check the VAT on this invoice by hand";
const CUSTOMER_PENDING = "waiting for the customer's details";
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
  const [form, setForm] = useState<InvoiceHeaderForm>({ clientId: '', invoiceDate: '', dueDate: '', billingPeriodStart: '', billingPeriodEnd: '', notes: '', currencyCode: 'ZAR', exchangeRate: 1, projectId: '' });
  const [lines, setLines] = useState<LineItem[]>([]);
  const [taxMode, setTaxMode] = useState<TaxMode>('exclusive'); // a stored price is ex-VAT, so it loads as one
  // A stored invoice is not refilled, so Save waits for a customer changed here (its terms move the due date), and for the
  // one it loaded with only while a line follows it (a line with no VAT type of its own takes the customer's: formVat).
  const [loadedClient, setLoadedClient] = useState('');
  const customer = useCustomerLookup(form.clientId, CUSTOMER_FAILED);
  const waitsForCustomer = customer.pending && (form.clientId !== loadedClient || lines.some((l) => l.vatType === undefined));
  // Such lines are typed by the answer: the body is what the server holds only once this load's customer is read, so
  // the answer arriving is not an edit (no PUT on opening a legacy no-VAT draft of an exempt customer). Until then the
  // form is read-only: an edit made then would be in the first body, taken as the server's, and never autosaved.
  const [customerReadFor, setCustomerReadFor] = useState(0);
  const { load: loadDueTerms, touch: touchDue, hint: dueHint, sendDue } = useDueDateFollowsTerms(form, setForm, customer.defaults); // a terms-sourced due date follows a new date or customer
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
  const [digestsAtLoad, setDigestsAtLoad] = useState<{ shown?: string; draft?: string }>({}); // invoicePdfModel
  const [reloads, setReloads] = useState(0); // a STALE_VIEW refusal reloads what is stored
  const staleRefusal = useRef<string | null>(null); // its sentence, shown once the reload lands
  const staleFor = useRef(''); // the invoice it was about
  // Decided once per load: did the stored total disagree with what the loaded lines price to, and at what pricing?
  // `loadSeq` numbers every load; `loadedKey` is the one whose answer is on screen, set with that answer.
  const loadSeq = useRef(0);
  const [loadedKey, setLoadedKey] = useState(0);
  const [pricedAtLoad, setPricedAtLoad] = useState<{ key: number; pricing: string; stale: boolean } | null>(null);
  useEffect(() => { if (!loading && !customer.pending) setCustomerReadFor(loadedKey); }, [loading, customer.pending, loadedKey]);
  const baselineWaits = customerReadFor !== loadedKey && waitsForCustomer;
  const wip = useWipLines(lines, setLines); // removing a time-entry line: asked, and saved by Save Changes only
  const wipLoaded = wip.loaded;

  useEffect(() => {
    if (!invoiceId) return;
    const id = String(invoiceId);
    setLoading(true); setInvoiceNumber(''); setError(''); setErrorStays(false); setApproved(false); // another invoice opened in place starts again
    let gone = false; // another invoice opened (or a reload) since: this load's answer is not shown
    const thisLoad = ++loadSeq.current;
    // A STALE_VIEW sentence belongs to this load of this invoice only: taken now, whatever the load's outcome.
    const carried = staleFor.current === id ? staleRefusal.current : null;
    staleRefusal.current = null;
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
      setLoadedFor(id); setLoadedKey(thisLoad);
      setStoredTotal(invoice.total_amount === undefined || invoice.total_amount === null ? null : Number(invoice.total_amount));
      setDigestsAtLoad({ shown: invoice.shown_digest, draft: invoice.draft_digest });
      setStoredDates({ dueDate: Boolean(invoice.due_date), billingPeriodStart: Boolean(invoice.billing_period_start), billingPeriodEnd: Boolean(invoice.billing_period_end) });
      // Why this load: a STALE_VIEW here (carried in memory across the reload), or Approve & email on the new page.
      const refusal = carried ? { message: carried, status: null } : takeApproveRefusal(id) ?? takeUnsavedLeave(id, invoice.invoice_number);
      if (refusal) { setError(refusal.message); setErrorStays(refusal.status === 409); }
      // Including VAT as stored, else Excluding; each line keeps its own type (editInvoiceLoad.vatAtLoad / linesFromStoredItems).
      const loadedVat = vatAtLoad(invoice);
      setTaxMode(loadedVat.mode); // this invoice's own mode, not the one opened before it
      clearDates();
      const clientId = String(invoice.client_id || invoice.customer_id || '');
      loadDueTerms({ invoiceDate: String(invoice.invoice_date || '').slice(0, 10), clientId, dueDate: invoice.due_date ? String(invoice.due_date).slice(0, 10) : '', source: invoice.due_date_source ?? null });
      setLoadedClient(clientId);
      setForm({
        clientId,
        invoiceDate: String(invoice.invoice_date || '').slice(0, 10),
        dueDate: invoice.due_date ? String(invoice.due_date).slice(0, 10) : '',
        billingPeriodStart: invoice.billing_period_start ? String(invoice.billing_period_start).slice(0, 10) : '',
        billingPeriodEnd: invoice.billing_period_end ? String(invoice.billing_period_end).slice(0, 10) : '',
        notes: invoice.notes || '',
        currencyCode: invoice.currency_code || 'ZAR',
        exchangeRate: Number(invoice.exchange_rate ?? 1),
        projectId: invoice.project_id ?? '',
      });
      const stored = linesFromStoredItems(invoice.items || [], invoice.project_id ?? '', loadedVat);
      setLines(stored); wipLoaded(stored, Number(invoice.unlinked_time_entries ?? 0));
      setLoading(false);
    }).catch((err: unknown) => {
      if (gone) return;
      setError(apiErrorMessage(err, 'Could not load the invoice - try again'));
      setLoading(false);
    });
    return () => { gone = true; };
  }, [invoiceId, clearDates, reloads, wipLoaded, loadDueTerms]);

  const updateLine = (key: string, field: keyof LineItem, value: string | number) =>
    setLines(prev => prev.map(l => l.key === key ? { ...l, [field]: value } : l));
  // A new line starts on the invoice's project: a visible default the user can change, not a posting fallback.
  const addLine = () => setLines(prev => [...prev, { key: String(Date.now()), description: '', quantity: 1, unitPrice: 0, discount: 0, ...UNCODED, projectId: form.projectId }]);
  const codingOptions = useInvoiceLineCodingOptions([form.projectId, ...lines.map(l => l.projectId)]);

  // Priced as the server stores it (formVat: per-line VAT; no VAT for a company not registered for it); a half-typed field previews as 0.
  const types = lineVatTypes(lines, customer.defaults?.vatType);
  const modeSwitch = useTaxModeSwitch({ lines, setLines, taxMode, setTaxMode, types, date: form.invoiceDate, currencyCode: form.currencyCode });
  const { vatMode } = modeSwitch;
  const lineTotal = (l: LineItem) => formLineNet(l, types[lines.indexOf(l)] ?? null, vatMode, form.invoiceDate);
  const { subtotal, tax, total } = formTotals(lines, types, vatMode, form.invoiceDate);

  // One render's form, lines and mode, together: the Save button, autosave and Approve & email all send this body.
  const id = String(invoiceId ?? '');
  const draft = { form, lines, taxMode: vatMode, customerVat: customer.defaults?.vatType };
  // Approve & email first: autosave waits while it runs (the form is disabled then too). Its save reads `autosave`
  // only when clicked, after this render has made it.
  // A stored total the lines no longer price to (a quote converted at 0%, a WIP draft rounded per line): never re-saved
  // unasked (that reprices, stales an approval and makes the clicker an author). Both figures show,
  // and Approve & email refuses until the user saves or approves the stored figure from the invoice page.
  // Stale-priced: the stored total disagreed with the loaded lines AT LOAD, and nothing that prices them has changed
  // since (a user's own price edit is theirs to save, never "stale"). A save clears it (storedTotal null).
  // Each line's RATE, not its type: a type that follows the customer (a legacy no-VAT line: zero-rated, or exempt once the
  // customer is read) prices the same either way.
  const pricing = JSON.stringify([vatMode, lines.map((l, i) => [l.quantity, l.unitPrice, l.discount, lineVatRate(types[i] ?? null, form.invoiceDate)])]);
  useEffect(() => { // stamped from the render that shows this load's answer, never from an earlier one's data
    if (loading || loadedFor !== id || !invoiceNumber) return;
    setPricedAtLoad(p => (p?.key === loadedKey ? p : { key: loadedKey, pricing, stale: storedTotal !== null && !sameCents(storedTotal, total) }));
  }, [loading, loadedFor, id, invoiceNumber, loadedKey, pricing, storedTotal, total]);
  const stalePriced = storedTotal !== null && pricedAtLoad?.key === loadedKey && pricedAtLoad.stale && pricedAtLoad.pricing === pricing;
  const money = (n: number) => formatCurrencyAmount(n, form.currencyCode);
  // Saved elsewhere since this page read it (an approve or a PUT refused 409 STALE_VIEW): reload, saying why.
  const reloadStale = (message: string) => { staleRefusal.current = message; staleFor.current = id; setReloads(n => n + 1); };
  const approve = useApproveAndEmail({
    save: async () => {
      if (stalePriced && storedTotal !== null) { // only Save Changes reprices it
        setError(`Save to reprice at ${money(total)}, or approve ${money(storedTotal)} from the invoice page`);
        return null;
      }
      if (wip.approveRefusal) { setError(wip.approveRefusal); return null; } // a removed time-entry line: Save Changes
      return (await saveDraft(false)) ? { id, invoiceNumber, approvalContentDigest: autosave.contentDigest() } : null;
    },
    onRefused: (_id, message, status, reason) => {
      if (reason === 'STALE_VIEW') { reloadStale(message); return; } // show what is stored, and why
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
    wip.saved(json);
    const b = JSON.parse(json) as Partial<Record<keyof StoredDates, string>>;
    setStoredDates((d) => ({ dueDate: d.dueDate || Boolean(b.dueDate), billingPeriodStart: d.billingPeriodStart || Boolean(b.billingPeriodStart), billingPeriodEnd: d.billingPeriodEnd || Boolean(b.billingPeriodEnd) }));
  };
  const autosave = useInvoiceAutosave({
    mode: 'server', invoiceId: id, loadKey: reloads, body: !loading && invoiceNumber && loadedFor === id && !baselineWaits ? invoicePutBody(id, draft, { omitDueDate: !sendDue, markClearedDue: storedDates.dueDate }) : null,
    releaseTimeEntryIds: wip.releasing, onStale: reloadStale,
    // Held: a stale-priced draft (an autosaved typo would reprice it and stale an approval); a removed time-entry line;
    // the customer a line or the due date follows, still being read.
    problem: stalePriced ? STALE_PRICED_HOLD : wip.problem ?? (waitsForCustomer ? CUSTOMER_PENDING : autosaveProblem(draft, dates.refused, storedDates)), paused: approve.busy, done: approved, onSaved: keepStoredDates,
    approvalContentDigest: digestsAtLoad.shown, draftDigest: digestsAtLoad.draft,
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
    return <AppLayout><Head><title>Edit invoice · Sales · IsaFlow</title></Head><EditInvoiceUnavailable message={error} invoiceHref={`/accounting/customer-invoices/${String(invoiceId)}`} /></AppLayout>;
  }

  return (
    <AppLayout>
      <Head><title>{`Edit ${invoiceNumber} · Sales · IsaFlow`}</title></Head>
      <div className="min-h-screen flex flex-col bg-slate-50 dark:bg-[var(--ff-bg-primary)]">
        <PageHeader
          icon={FileText}
          title={invoiceNumber}
          breadcrumb={[{ label: 'Invoices', href: '/accounting/customer-invoices' }, { label: 'Invoice', href: `/accounting/customer-invoices/${String(invoiceId)}` }, { label: 'Edit draft' }]}
          className="mb-0"
        />

        <div className="flex-1 p-4 sm:p-6 xl:p-8">
          <div className="max-w-screen-2xl mx-auto min-w-0 space-y-5">
              {(error || customer.error) && <div role="alert" className="p-3 bg-red-50 dark:bg-red-900/20 rounded-xl border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm flex items-center gap-2"><AlertCircle className="h-4 w-4" />{error || customer.error}</div>}

              <fieldset disabled={approve.busy || approved || baselineWaits} className="min-w-0 space-y-5">
              <InvoiceHeaderFields form={form} onChange={patch => setForm(p => ({ ...p, ...patch }))} options={codingOptions}
                onProjectChange={v => setForm(p => ({ ...p, projectId: v }))} onDateValidity={dates.report} refused={dates.refused} hints={{ dueDate: dueHint }} onDueDateEdited={touchDue} />

              <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
                <InvoiceLineItemsTable settings={<InvoiceSettingsRow form={form} currencies={currencies} onChange={patch => setForm(p => ({ ...p, ...patch }))} registered={modeSwitch.registered}
                  taxMode={vatMode} taxModes={modeSwitch.modes} taxModeProblem={modeSwitch.problem} onTaxModeChange={modeSwitch.pick} />}
                  lines={lines} currencyCode={form.currencyCode} lineTotal={lineTotal}
                  onUpdate={updateLine} onAdd={addLine} onRemove={wip.remove} billsTimeEntry={(key) => lines.some(l => l.key === key && Boolean(l.timeEntryId))} options={codingOptions} pricesIncludeVat={taxMode === 'inclusive'}
                  {...(vatMode === 'none' ? {} : { vatTypes: types, vatDate: form.invoiceDate, vatWarning: lineVatWarning(customer.defaults?.vatType, types) })} />
                {wip.note && <p className="px-5 pb-3 text-xs text-amber-800 dark:text-amber-300">{wip.note}</p>}
                <InvoiceTotals subtotal={subtotal} tax={tax} total={total} currencyCode={form.currencyCode} byType={formVatByType(lines, types, vatMode, form.invoiceDate)} date={form.invoiceDate}
                  fx={fxPreview(total, form.currencyCode, form.exchangeRate)} {...(taxMode === 'inclusive' ? { typedTotal: inclusiveTypedTotal(lines) } : {})} />
              </div>

              <InvoiceNotesCard value={form.notes} onChange={notes => setForm(p => ({ ...p, notes }))} placeholder="Notes or payment instructions…" />
              </fieldset>
              {id && <InvoicePdfPreview invoiceId={id} version={autosave.savedCount} />}
          </div>
        </div>
        <InvoiceActionBar status={<>
          {stalePriced && storedTotal !== null && <span className="text-amber-800 dark:text-amber-300">Stored total {money(storedTotal)}; these lines price to {money(total)}. Save Changes reprices the invoice.</span>}
          <InvoiceAutosaveStatus where="server" state={autosave.state} savedAt={autosave.savedAt} error={autosave.error} held={autosave.held} />
        </>}>
          <EditInvoiceActions disabled={submitting || approve.busy || approved || waitsForCustomer} submitting={submitting} approving={approve.busy}
            cancelHref={`/accounting/customer-invoices/${String(invoiceId)}`} onSave={() => { void handleSubmit(); }} onApprove={approve.start} />
        </InvoiceActionBar>
        {approve.modal && <InvoiceEmailModal {...approve.modal} />}
      </div>
    </AppLayout>
  );
}
