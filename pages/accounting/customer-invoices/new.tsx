/**
 * Create Customer Invoice — one-column document editor: the line grid with its settings row (Amounts are, currency) and
 * its totals under it, a VAT type per line (formVat), and the actions in a bar at the bottom of the viewport. The form is kept on this device until it is created
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
import { formLineNet, formTotals, formVatByType, fromKeptDraft, lineVatTypes, lineVatWarning, typeForRate } from '@/components/accounting/customer-invoices/formVat';
import { useTaxModeSwitch } from '@/components/accounting/customer-invoices/useTaxModeSwitch';
import { toFunctional } from '@/modules/accounting/services/shared/functionalAmounts';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';
import { InvoiceLineItemsTable, type InvoiceLine } from '@/components/accounting/customer-invoices/InvoiceLineItemsTable';
import { InvoiceHeaderFields, InvoiceNotesCard, type InvoiceCurrency } from '@/components/accounting/customer-invoices/InvoiceHeaderFields';
import { InvoiceTotals } from '@/components/accounting/customer-invoices/InvoiceTotals';
import { InvoiceSettingsRow } from '@/components/accounting/customer-invoices/InvoiceSettingsRow';
import { isoOrEmpty, useInvoiceDateValidity, type InvoiceHeaderForm } from '@/components/accounting/customer-invoices/invoiceHeaderForm';
import { useInvoiceLineCodingOptions } from '@/components/accounting/customer-invoices/useInvoiceLineCodingOptions';
import { editedLine, useContactDefaults } from '@/components/accounting/customer-invoices/useContactDefaults';
import { inclusiveTypedTotal, type TaxMode } from '@/components/accounting/customer-invoices/taxMode';
import { useInvoiceAutosave } from '@/components/accounting/customer-invoices/useInvoiceAutosave';
import { createBody } from '@/components/accounting/customer-invoices/newInvoiceBody';
import { InvoicePdfPreview } from '@/components/accounting/customer-invoices/InvoicePdfPreview';
import { useInvoiceDraftOwner, type LocalDraftData } from '@/components/accounting/customer-invoices/useLocalInvoiceDraft';
import { InvoiceAutosaveStatus } from '@/components/accounting/customer-invoices/InvoiceAutosaveStatus';
import { InvoiceActionBar, KeptDraftOffer, NewInvoiceActions } from '@/components/accounting/customer-invoices/NewInvoiceParts';
import { stashApproveRefusal, useApproveAndEmail, type SavedInvoice } from '@/components/accounting/customer-invoices/useApproveAndEmail';
import { useScannedClientMatch } from '@/components/accounting/customer-invoices/useScannedClientMatch';

type LineItem = InvoiceLine;
const UNCODED = { glAccountId: '', projectId: '', cc2Id: '', buId: '' };
const BLANK_LINE = { description: '', quantity: 1, unitPrice: 0, incomeType: 'other', discount: 0, discountFromDefault: true, ...UNCODED, accountFromDefault: true };

export default function NewCustomerInvoicePage() {
  const router = useRouter();
  const [currencies, setCurrencies] = useState<InvoiceCurrency[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [saveAndNew, setSaveAndNew] = useState(false);
  const [error, setError] = useState('');
  const [scanBanner, setScanBanner] = useState<string | null>(null);
  const today = localISODate();

  const dates = useInvoiceDateValidity();
  const [resetKey, setResetKey] = useState(0);
  const [form, setForm] = useState<InvoiceHeaderForm>({ clientId: '', invoiceDate: today, dueDate: '', billingPeriodStart: today, billingPeriodEnd: today, notes: '', currencyCode: 'ZAR', exchangeRate: 1, projectId: '' });
  const [lines, setLines] = useState<LineItem[]>([{ key: '1', ...BLANK_LINE }]);
  const { scanned, lookupSeq, scanLookup, setScanLookup, matchScannedClient } = useScannedClientMatch(setForm, setError);
  const [taxMode, setTaxMode] = useState<TaxMode>('exclusive');
  const contact = useContactDefaults({ clientId: form.clientId, invoiceDate: form.invoiceDate, setForm, setLines });
  // Each line's VAT type: its own, else the customer's default chain (formVat), read at render so it follows the customer.
  const types = lineVatTypes(lines, contact.vatType);
  // taxModeSwitch: each line at its own type's rate; refused (prices and mode kept) when a line would come to another figure.
  const modeSwitch = useTaxModeSwitch({ lines, setLines, taxMode, setTaxMode, types, date: form.invoiceDate, currencyCode: form.currencyCode });
  const { vatMode } = modeSwitch;

  useEffect(() => {
    apiFetch('/api/accounting/currencies', { credentials: 'include' }).then(async r => { await assertOk(r, 'Could not load currencies - try again'); return r.json(); }).then(json => {
      const d = json.data || json; setCurrencies(Array.isArray(d) ? d : []);
    }).catch(err => setError(apiErrorMessage(err, 'Could not load currencies - try again')));
  }, []);

  const updateLine = (key: string, field: string, value: string | number) =>
    setLines(prev => prev.map(l => l.key === key ? editedLine(l, field, value, contact.pending) : l));
  // A new line starts on the invoice's project: a visible default the user can change, not a posting fallback.
  const addLine = () => setLines(prev => [...prev, { key: String(Date.now()), ...BLANK_LINE, discount: contact.lineDiscount, glAccountId: contact.lineAccount, projectId: form.projectId }]);
  const codingOptions = useInvoiceLineCodingOptions();
  // A line nobody has typed into yet (the initial one) follows the header project; a worked line keeps its own.
  const pickProject = (v: string) => {
    setLines(prev => prev.map(l => (!l.description && !l.unitPrice && l.projectId === form.projectId ? { ...l, projectId: v } : l)));
    setForm(p => ({ ...p, projectId: v }));
  };
  const removeLine = (key: string) => setLines(prev => prev.length > 1 ? prev.filter(l => l.key !== key) : prev);

  // Priced as the server stores it (formVat: per-line VAT); a half-typed field previews as 0, not a crash. A company not
  // registered for VAT prices and sends no VAT, as the server forces it.
  const lineTotal = (l: LineItem) => formLineNet(l, types[lines.indexOf(l)] ?? null, vatMode, form.invoiceDate);
  const { subtotal, tax, total } = formTotals(lines, types, vatMode, form.invoiceDate);
  const isFx = form.currencyCode !== 'ZAR';
  // A preview only: the stored figure is public.fx_functional's, and toFunctional is its exact twin.
  const zarTotal = Number.isFinite(total) && Number.isFinite(form.exchangeRate) ? toFunctional(total, form.exchangeRate) : 0;
  // What Create would send, from this render: the preview renders exactly it (invoice-pdf-preview).
  const built = createBody(form, lines, vatMode, types, dates.refused);

  // A kept draft comes back whole: its mode with its prices (one kept before per-line VAT typed as it priced then), and
  // nothing the customer's defaults may then overwrite.
  const restoreDraft = (kept: LocalDraftData) => {
    if (inert) return;
    const d = fromKeptDraft(kept);
    contact.touch('dueDate'); lookupSeq.current++;
    setForm(d.form); setLines(d.lines); setTaxMode(d.taxMode); dates.clear(); setResetKey(k => k + 1);
  };
  const owner = useInvoiceDraftOwner();
  const draft = useInvoiceAutosave({ mode: 'local', ...owner, snapshot: { form, lines, taxMode }, paused: false, onRestore: restoreDraft });

  function handleExtracted(data: ExtractedDocument) {
    if (inert) return; // a scan landing while the invoice is created or approved, or after, changes nothing
    // A scan is OCR output: only a real YYYY-MM-DD goes in (anything else would make DateField's minDate throw); else the field is left empty.
    const updates: Partial<InvoiceHeaderForm> = {};
    if (data.date) updates.invoiceDate = isoOrEmpty(data.date);
    if (data.dueDate) { updates.dueDate = isoOrEmpty(data.dueDate); contact.touch('dueDate'); }
    // The scan's rate types its lines (0 zero-rated, the standard rate standard, any other none yet: the line asks).
    const scannedType = data.vatRate !== null ? { vatType: typeForRate(data.vatRate, updates.invoiceDate || form.invoiceDate) } : {};
    // A scan reads the rate and ex-VAT prices off the document, so the form goes back to taking them as they are; with
    // no lines on the scan, the gross prices already typed stay gross.
    const keepsTypedGross = taxMode === 'inclusive' && data.lineItems.length === 0;
    // Nothing to convert (taken from the gate fixer's round 8): inclusive only changes here when the scan's lines replace the typed ones.
    if (!keepsTypedGross && (data.vatRate !== null || taxMode === 'inclusive')) setTaxMode('exclusive');
    if (data.vatRate !== null && data.lineItems.length === 0) setLines(prev => prev.map(l => ({ ...l, ...scannedType })));
    setForm(f => ({ ...f, ...updates }));
    dates.clear(); setResetKey(k => k + 1);
    const seq = ++lookupSeq.current;
    if (data.customerName) void matchScannedClient(data.customerName, seq);
    if (data.lineItems.length > 0) {
      setLines(data.lineItems.map(li => ({ key: String(Date.now() + Math.random()), description: li.description, quantity: li.quantity ?? 1, unitPrice: li.unitPrice ?? 0, incomeType: 'other', discount: 0, ...UNCODED, projectId: form.projectId, ...scannedType })));
    }
    setScanBanner(`Auto-filled (${Math.round(data.confidence * 100)}% confidence). Review all fields.`);
  }

  /**
   * Creates the draft (the page shows any refusal); the device's copy goes once the server has it. Once created
   * (Create, or Approve & email whatever the approval answers) the page is done: inert until it is left or reset, so no
   * key, click, or Cancel on a leave question creates a second invoice (a number burnt, a wallet charge). The ref holds
   * from the moment of the create, before the next render. Save & New resets the form instead.
   */
  const [done, setDone] = useState(false);
  const doneNow = useRef(false);
  const markDone = () => { doneNow.current = true; setDone(true); lookupSeq.current++; };
  const createInvoice = async (): Promise<SavedInvoice | null> => {
    if (doneNow.current) return null;
    if ('problem' in built) { setError(built.problem); return null; }
    setError('');
    try {
      const res = await apiFetch('/api/accounting/customer-invoices-create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(built.body) });
      await assertOk(res, 'Could not create the invoice - try again');
      const json = await res.json() as { data?: { id?: string; invoiceNumber?: string; shownDigest?: string }; id?: string; invoiceNumber?: string; shownDigest?: string };
      const d = json.data || json;
      if (!d.id) throw new ApiEnvelopeError('The invoice could not be opened - check the invoice list before creating it again');
      draft.clear();
      return { id: d.id, invoiceNumber: d.invoiceNumber ?? '', approvalContentDigest: d.shownDigest };
    } catch (e) { setError(apiErrorMessage(e, 'Could not create the invoice - try again')); return null; }
  };

  const resetForm = () => {
    const today = localISODate();
    setForm({ clientId: '', invoiceDate: today, dueDate: '', billingPeriodStart: today, billingPeriodEnd: today, notes: '', currencyCode: 'ZAR', exchangeRate: 1, projectId: '' });
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
      if (andNew) resetForm(); else markDone();
      const next = andNew ? '/accounting/customer-invoices/new' : `/accounting/customer-invoices/${made.id}`;
      try { await router.push(next); } catch (e) { log.warn('navigation failed', { error: e }, 'customer-invoices-new'); }
    } finally { setSubmitting(false); }
  };

  // A refused approval leaves the created draft: its edit page says why.
  const created = useRef<SavedInvoice | null>(null);
  const approve = useApproveAndEmail({
    save: async () => {
      const made = await createInvoice();
      if (made) { markDone(); created.current = made; }
      return made;
    },
    bodyNow: draft.current,
    shown: { total, currencyCode: form.currencyCode, exchangeRate: form.exchangeRate },
    onRefused: (id, message, status, reason) => {
      // A STALE_VIEW is answered by the edit page's next save; only the gate's 409 stays on screen there.
      stashApproveRefusal(id, message, reason === 'STALE_VIEW' ? undefined : status);
      void (async () => {
        let opened = false;
        try { opened = (await router.push(`/accounting/customer-invoices/edit/${id}`)) === true; } catch (e) { log.warn('navigation failed', { error: e }, 'customer-invoices-new'); }
        const which = created.current?.id === id && created.current.invoiceNumber ? `Invoice ${created.current.invoiceNumber}` : 'The invoice';
        if (!opened) setError(`${message} ${which} was created as a draft: open it from the invoice list (Sales, Invoices) to change it.`);
      })();
    },
  });
  const inert = submitting || approve.busy || done;
  const busy = inert || contact.pending || scanLookup !== null;

  // /new opened again on this page (a link, a shortcut) after Approve & email: a fresh invoice, not the done one.
  const events = router.events as typeof router.events | undefined;
  useEffect(() => {
    const onRouteDone = (url: string) => {
      // Done, or left without its changes ("Leave without them" on a link back to /new): a blank form.
      if ((!doneNow.current && !draft.leftWithout()) || url.split(/[?#]/)[0] !== '/accounting/customer-invoices/new') return;
      doneNow.current = false; setDone(false); approve.dismiss(); resetForm(); draft.clear(); setError('');
    };
    events?.on('routeChangeComplete', onRouteDone);
    return () => events?.off('routeChangeComplete', onRouteDone);
  });

  return (
    <AppLayout>
      <Head><title>New invoice · Sales · IsaFlow</title></Head>
      <div className="min-h-screen flex flex-col bg-slate-50 dark:bg-[var(--ff-bg-primary)]">
        <PageHeader
          icon={FileText}
          title="Customer Invoice"
          breadcrumb={[{ label: 'Invoices', href: '/accounting/customer-invoices' }, { label: 'New invoice' }]}
          actions={<ScanAndFillButton onExtracted={handleExtracted} label="Scan Invoice" />}
          className="mb-0"
        />

        <div className="flex-1 p-4 sm:p-6 xl:p-8">
          <div className="max-w-screen-2xl mx-auto min-w-0 space-y-5">
              {scanBanner && (
                <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-xl border border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-400 text-sm flex items-center gap-2">
                  <Info className="h-4 w-4 flex-shrink-0" />{scanBanner}
                  <button onClick={() => setScanBanner(null)} className="ml-auto text-xs font-medium opacity-70 hover:opacity-100">Dismiss</button>
                </div>
              )}
              {draft.offer && <KeptDraftOffer savedAt={draft.offer.savedAt} disabled={inert} onRestore={draft.restore} onDiscard={draft.discard} />}
              {(error || contact.error) && <div role="alert" className="p-3 bg-red-50 dark:bg-red-900/20 rounded-xl border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm">{error || contact.error}</div>}

              <fieldset disabled={inert} className="min-w-0 space-y-5">
              <InvoiceHeaderFields form={form} options={codingOptions}
                onChange={patch => { if ('clientId' in patch) { lookupSeq.current++; setScanLookup(null); } setForm(p => ({ ...p, ...patch })); }}
                onProjectChange={pickProject} onDateValidity={dates.report} refused={dates.refused} resetKey={resetKey} clientLabel={scanned?.id === form.clientId ? scanned.name : undefined}
                hints={contact.hints} onDueDateEdited={() => contact.touch('dueDate')} />

              <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
                <InvoiceLineItemsTable settings={<InvoiceSettingsRow form={form} currencies={currencies} onChange={patch => setForm(p => ({ ...p, ...patch }))} registered={modeSwitch.registered}
                  taxMode={vatMode} taxModes={modeSwitch.modes} taxModeProblem={modeSwitch.problem} onTaxModeChange={modeSwitch.pick} />}
                  lines={lines} currencyCode={form.currencyCode} lineTotal={lineTotal}
                  onUpdate={updateLine} onAdd={addLine} onRemove={removeLine} options={codingOptions} showIncomeType pricesIncludeVat={taxMode === 'inclusive'}
                  discountHint={lines.some(l => l.discountFromDefault && l.discount > 0) ? contact.hints.discount : undefined} accountHint={contact.hints.account}
                  {...(vatMode === 'none' ? {} : { vatTypes: types, vatDate: form.invoiceDate, vatHint: contact.hints.vat, vatWarning: lineVatWarning(contact.vatType, types) })} />
                <InvoiceTotals subtotal={subtotal} tax={tax} total={total} currencyCode={form.currencyCode} byType={formVatByType(lines, types, vatMode, form.invoiceDate)} date={form.invoiceDate}
                  fx={isFx ? { zarTotal, rate: form.exchangeRate } : undefined} {...(taxMode === 'inclusive' ? { typedTotal: inclusiveTypedTotal(lines) } : {})} />
              </div>

              <InvoiceNotesCard value={form.notes} onChange={notes => setForm(p => ({ ...p, notes }))} placeholder="Add any notes or payment instructions…" />
              </fieldset>
              <InvoicePdfPreview unsaved={'body' in built ? { body: built.body } : { problem: built.problem }} />
          </div>
        </div>
        <InvoiceActionBar status={<>
          <InvoiceAutosaveStatus where="device" state={draft.state} savedAt={draft.savedAt} error={draft.error} />
          {scanLookup !== null && <span role="status" className="text-slate-600 dark:text-slate-400">Finding the scanned customer…</span>}
          <span className="text-slate-600 dark:text-slate-400">Create saves a draft. Approve &amp; email opens the email form; nothing is sent until you click Send.</span>
        </>}>
          <NewInvoiceActions busy={busy} submitting={submitting} saveAndNew={saveAndNew} approving={approve.busy}
            onCreate={() => { void handleSubmit(false); }} onSaveAndNew={() => { void handleSubmit(true); }} onApprove={approve.start} />
        </InvoiceActionBar>
        {approve.modal && <InvoiceEmailModal {...approve.modal} />}
      </div>
    </AppLayout>
  );
}
