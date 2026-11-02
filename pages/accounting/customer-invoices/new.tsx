/**
 * Create Customer Invoice — two-column document editor layout. The form is kept on this device until it is created
 * (PR S: never a server draft, as create is wallet-metered), leaving with a change unsaved asks first, and Approve &
 * email creates, approves and opens the email form (sending stays the user's click).
 */
import { useState, useEffect, useRef } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { FileText, Info } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { ApiEnvelopeError, apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { InvoiceEmailModal } from '@/components/invoices/InvoiceEmailModal';
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
import { editedLine, useContactDefaults } from '@/components/accounting/customer-invoices/useContactDefaults';
import { effectiveTaxRate, inclusiveTypedTotal, lineTotalForMode, linesForModeChange, pricesToNothing, pricesToNothingMessage, storedUnitPrice, vatTypeWarning, type TaxMode } from '@/components/accounting/customer-invoices/taxMode';
import { useInvoiceAutosave } from '@/components/accounting/customer-invoices/useInvoiceAutosave';
import { droppedLineProblem } from '@/components/accounting/customer-invoices/invoicePutBody';
import { useInvoiceDraftOwner, type LocalDraftData } from '@/components/accounting/customer-invoices/useLocalInvoiceDraft';
import { InvoiceAutosaveStatus } from '@/components/accounting/customer-invoices/InvoiceAutosaveStatus';
import { KeptDraftOffer, NewInvoiceActions } from '@/components/accounting/customer-invoices/NewInvoiceParts';
import { stashApproveRefusal, useApproveAndEmail, type SavedInvoice } from '@/components/accounting/customer-invoices/useApproveAndEmail';

interface Client { id: string; name: string }
type LineItem = InvoiceLine;
const UNCODED = { glAccountId: '', projectId: '', cc2Id: '', buId: '' };
const BLANK_LINE = { description: '', quantity: 1, unitPrice: 0, incomeType: 'other', discount: 0, discountFromDefault: true, ...UNCODED };

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
  const [lines, setLines] = useState<LineItem[]>([{ key: '1', ...BLANK_LINE }]);
  const [taxMode, setTaxMode] = useState<TaxMode>('exclusive');
  const contact = useContactDefaults({ clientId: form.clientId, invoiceDate: form.invoiceDate, setForm, setLines, setTaxMode });
  const pickTaxMode = (mode: TaxMode) => { contact.touch('taxMode'); setLines(ls => linesForModeChange(ls, taxMode, mode, form.taxRate)); setTaxMode(mode); };

  useEffect(() => {
    apiFetch('/api/accounting/currencies', { credentials: 'include' }).then(async r => { await assertOk(r, 'Could not load currencies - try again'); return r.json(); }).then(json => {
      const d = json.data || json; setCurrencies(Array.isArray(d) ? d : []);
    }).catch(err => setError(apiErrorMessage(err, 'Could not load currencies - try again')));
  }, []);

  const updateLine = (key: string, field: string, value: string | number) =>
    setLines(prev => prev.map(l => l.key === key ? editedLine(l, field, value, contact.pending) : l));
  // A new line starts on the invoice's project: a visible default the user can change, not a posting fallback.
  const addLine = () => setLines(prev => [...prev, { key: String(Date.now()), ...BLANK_LINE, discount: contact.lineDiscount, projectId: form.projectId }]);
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
  // Create and Approve & email wait for a scan's lookup: it must not land on a created invoice's form (or the next one).
  const [scanLookups, setScanLookups] = useState(0);
  async function matchScannedClient(name: string, seq: number) {
    setScanLookups(n => n + 1);
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
    finally { setScanLookups(n => n - 1); }
  }

  const [rateEditing, setRateEditing] = useState(false);
  // A kept draft comes back whole: its mode with its prices, and nothing the customer's defaults may then overwrite.
  const restoreDraft = (d: LocalDraftData) => {
    if (inert) return;
    contact.touch('dueDate'); contact.touch('taxMode'); lookupSeq.current++;
    setForm(d.form); setLines(d.lines); setTaxMode(d.taxMode); dates.clear(); setResetKey(k => k + 1);
  };
  const owner = useInvoiceDraftOwner();
  const draft = useInvoiceAutosave({ mode: 'local', ...owner, snapshot: { form, lines, taxMode }, paused: rateEditing, onRestore: restoreDraft });

  function handleExtracted(data: ExtractedDocument) {
    if (inert) return; // a scan landing while the invoice is created or approved, or after, changes nothing
    // A scan is OCR output: only a real YYYY-MM-DD goes in (anything else would make DateField's minDate throw); else the field is left empty.
    const updates: Partial<InvoiceHeaderForm> = {};
    if (data.date) updates.invoiceDate = isoOrEmpty(data.date);
    if (data.dueDate) { updates.dueDate = isoOrEmpty(data.dueDate); contact.touch('dueDate'); }
    if (data.vatRate !== null) updates.taxRate = data.vatRate;
    // A scan reads the rate and ex-VAT prices off the document, so the form goes back to taking them as they are; with
    // no lines on the scan, the gross prices already typed stay gross.
    const keepsTypedGross = taxMode === 'inclusive' && data.lineItems.length === 0;
    if (!keepsTypedGross && (data.vatRate !== null || taxMode === 'inclusive')) pickTaxMode('exclusive');
    setForm(f => ({ ...f, ...updates }));
    dates.clear(); setResetKey(k => k + 1);
    const seq = ++lookupSeq.current;
    if (data.customerName) void matchScannedClient(data.customerName, seq);
    if (data.lineItems.length > 0) {
      setLines(data.lineItems.map(li => ({ key: String(Date.now() + Math.random()), description: li.description, quantity: li.quantity ?? 1, unitPrice: li.unitPrice ?? 0, incomeType: 'other', discount: 0, ...UNCODED, projectId: form.projectId })));
    }
    setScanBanner(`Auto-filled (${Math.round(data.confidence * 100)}% confidence). Review all fields.`);
  }

  // Created by Approve & email, the form is done whatever the approval answers: the page stays inert (behind the email
  // form, or while the draft's edit page opens), so no key or click creates a second invoice (a number burnt, a wallet
  // charge). The ref holds from the moment of the create, before the next render.
  const [done, setDone] = useState(false);
  const doneNow = useRef(false);
  /** Creates the draft (the page shows any refusal); the device's copy goes once the server has it. */
  const createInvoice = async (): Promise<SavedInvoice | null> => {
    if (doneNow.current) return null;
    if (!form.clientId) { setError('Select a client'); return null; }
    const tooSmall = lines.find(l => l.description && pricesToNothing(taxMode, l.unitPrice, taxRate));
    if (tooSmall) { setError(pricesToNothingMessage(tooSmall.description)); return null; }
    // Every line on screen counts in the total: one the body would drop is refused, never left out quietly.
    const dropped = droppedLineProblem(lines, false);
    if (dropped) { setError(dropped); return null; }
    const validLines = lines.map(({ discountFromDefault: _fromDefault, ...l }) => ({ ...l, unitPrice: storedUnitPrice(taxMode, l.unitPrice, taxRate) })).filter(l => l.description && l.unitPrice > 0);
    if (validLines.length === 0) { setError('Add at least one line item'); return null; }
    const dateProblem = invoiceDateProblem(form, dates.refused);
    if (dateProblem) { setError(dateProblem); return null; }
    if (isFx && form.exchangeRate <= 0) { setError('Exchange rate must be greater than 0'); return null; }
    setError('');
    try {
      const res = await apiFetch('/api/accounting/customer-invoices-create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, taxRate, items: validLines }) });
      await assertOk(res, 'Could not create the invoice - try again');
      const json = await res.json() as { data?: { id?: string; invoiceNumber?: string }; id?: string; invoiceNumber?: string };
      const d = json.data || json;
      if (!d.id) throw new ApiEnvelopeError('The invoice could not be opened - check the invoice list before creating it again');
      draft.clear();
      return { id: d.id, invoiceNumber: d.invoiceNumber ?? '' };
    } catch (e) { setError(apiErrorMessage(e, 'Could not create the invoice - try again')); return null; }
  };

  const resetForm = () => {
    const today = localISODate();
    setForm({ clientId: '', invoiceDate: today, dueDate: '', billingPeriodStart: today, billingPeriodEnd: today, taxRate: 15, notes: '', currencyCode: 'ZAR', exchangeRate: 1, projectId: '' });
    setLines([{ key: '1', ...BLANK_LINE }]);
    setTaxMode('exclusive'); contact.reset();
    dates.clear(); setResetKey(k => k + 1); lookupSeq.current++;
  };

  const handleSubmit = async (andNew = false) => {
    setSaveAndNew(andNew);
    setSubmitting(true);
    try {
      const made = await createInvoice();
      if (!made) return;
      lookupSeq.current++; // nothing still out lands on the created invoice's form
      if (andNew) {
        resetForm();
        try { await router.push('/accounting/customer-invoices/new'); } catch (e) { log.warn('navigation failed', { error: e }, 'customer-invoices-new'); }
      } else {
        try { await router.push(`/accounting/customer-invoices/${made.id}`); } catch (e) { log.warn('navigation failed', { error: e }, 'customer-invoices-new'); }
      }
    } finally { setSubmitting(false); }
  };

  // A refused approval leaves the created draft: its edit page says why.
  const approve = useApproveAndEmail({
    save: async () => {
      const made = await createInvoice();
      if (made) { doneNow.current = true; setDone(true); lookupSeq.current++; }
      return made;
    },
    bodyNow: draft.current,
    onRefused: (id, message) => {
      stashApproveRefusal(id, message);
      void (async () => {
        let opened = false;
        try { opened = (await router.push(`/accounting/customer-invoices/edit/${id}`)) === true; } catch (e) { log.warn('navigation failed', { error: e }, 'customer-invoices-new'); }
        if (!opened) setError(`${message} The invoice was created as a draft: open it from the invoice list to change it.`);
      })();
    },
  });
  const inert = submitting || approve.busy || done;
  const busy = inert || contact.pending || scanLookups > 0;

  // /new opened again on this page (a link, a shortcut) after Approve & email: a fresh invoice, not the done one.
  const events = router.events as typeof router.events | undefined;
  useEffect(() => {
    const onRouteDone = (url: string) => {
      if (!doneNow.current || url.split(/[?#]/)[0] !== '/accounting/customer-invoices/new') return;
      doneNow.current = false; setDone(false); approve.dismiss(); resetForm(); draft.clear(); setError('');
    };
    events?.on('routeChangeComplete', onRouteDone);
    return () => events?.off('routeChangeComplete', onRouteDone);
  });

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
              {draft.offer && <KeptDraftOffer savedAt={draft.offer.savedAt} disabled={inert} onRestore={draft.restore} onDiscard={draft.discard} />}
              {(error || contact.error) && <div role="alert" className="p-3 bg-red-50 dark:bg-red-900/20 rounded-xl border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm">{error || contact.error}</div>}

              <fieldset disabled={inert} className="min-w-0 space-y-5">
              <InvoiceHeaderFields form={form} currencies={currencies} options={codingOptions}
                onChange={patch => { if ('clientId' in patch) lookupSeq.current++; if ('taxRate' in patch) contact.touch('taxMode'); setForm(p => ({ ...p, ...patch })); }}
                onProjectChange={pickProject} onDateValidity={dates.report} refused={dates.refused} resetKey={resetKey} clientLabel={scanned?.id === form.clientId ? scanned.name : undefined}
                taxMode={taxMode} onTaxModeChange={pickTaxMode} hints={contact.hints} vatWarning={vatTypeWarning(contact.vatType, taxRate)} onDueDateEdited={() => contact.touch('dueDate')} onRateEditing={setRateEditing} />

              <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
                <InvoiceLineItemsTable lines={lines} currencyCode={form.currencyCode} lineTotal={lineTotal}
                  onUpdate={updateLine} onAdd={addLine} onRemove={removeLine} options={codingOptions} showIncomeType pricesIncludeVat={taxMode === 'inclusive'}
                  discountHint={lines.some(l => l.discountFromDefault && l.discount > 0) ? contact.hints.discount : undefined} />
              </div>

              <InvoiceNotesCard value={form.notes} onChange={notes => setForm(p => ({ ...p, notes }))} placeholder="Add any notes or payment instructions…" />
              </fieldset>
              <p className="rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-4 py-3 text-sm text-[var(--ff-text-secondary)]">Save the draft to preview the PDF.</p>
            </div>

            <div className="lg:sticky lg:top-6 space-y-4">
              <InvoiceSummaryCard subtotal={subtotal} tax={tax} total={total} taxRate={taxRate} currencyCode={form.currencyCode}
                fx={isFx ? { zarTotal, rate: form.exchangeRate } : undefined} {...(taxMode === 'inclusive' ? { typedTotal: inclusiveTypedTotal(lines) } : {})}>
                <InvoiceAutosaveStatus where="device" state={draft.state} savedAt={draft.savedAt} error={draft.error} />
                <NewInvoiceActions busy={busy} submitting={submitting} saveAndNew={saveAndNew} approving={approve.busy}
                  onCreate={() => { void handleSubmit(false); }} onSaveAndNew={() => { void handleSubmit(true); }} onApprove={approve.start} />
              </InvoiceSummaryCard>
              <p className="text-xs text-slate-500 dark:text-slate-400 text-center px-2">Create saves a draft. Approve &amp; email approves it and opens the email form; nothing is sent until you click Send.</p>
            </div>
          </div>
        </div>
        {approve.modal && <InvoiceEmailModal {...approve.modal} />}
      </div>
    </AppLayout>
  );
}
