/**
 * Edit Customer Invoice — only allowed while status === 'draft'.
 * Mirrors the new.tsx layout but loads the existing invoice and submits PUT.
 */
import { useState, useEffect } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, FileText, Loader2, AlertCircle } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { discountFromAmount, previewTotals } from '@/modules/accounting/services/ar/invoiceLineAmount';
import { InvoiceLineItemsTable, type InvoiceLine } from '@/components/accounting/customer-invoices/InvoiceLineItemsTable';
import { InvoiceHeaderFields, InvoiceNotesCard, type InvoiceCurrency } from '@/components/accounting/customer-invoices/InvoiceHeaderFields';
import { InvoiceSummaryCard } from '@/components/accounting/customer-invoices/InvoiceSummaryCard';
import { invoiceDateProblem, useInvoiceDateValidity, type InvoiceHeaderForm } from '@/components/accounting/customer-invoices/invoiceHeaderForm';
import { useInvoiceLineCodingOptions } from '@/components/accounting/customer-invoices/useInvoiceLineCodingOptions';
import { effectiveTaxRate, inclusiveTypedTotal, lineTotalForMode, linesForModeChange, storedUnitPrice, type TaxMode } from '@/components/accounting/customer-invoices/taxMode';

// CC2 / BU are edited here; CC1 follows its CC2 — re-sent only while the line's CC2 is the one it loaded with,
// otherwise null, so derivation sets it (the project's FNO, else the customer's: dimensionKeepStored).
type LineItem = InvoiceLine & { cc1Id?: string | null; cc2AtLoad?: string };
const UNCODED = { glAccountId: '', projectId: '', cc2Id: '', buId: '' };
type InvoiceItemRow = {
  description?: string; unit_price?: number | string; quantity?: number | string;
  amount?: number | string; tax_rate?: number | string;
  gl_account_id?: string | null; project_id?: string | null; cc1_id?: string | null; cc2_id?: string | null; bu_id?: string | null;
};
type InvoiceDetail = {
  id: string; status: string; invoice_number: string;
  client_id?: string | null; customer_id?: string | null;
  invoice_date: string; due_date?: string | null;
  billing_period_start?: string | null; billing_period_end?: string | null;
  tax_rate: number | string; notes?: string | null;
  currency_code?: string | null; exchange_rate?: number | string | null; project_id?: string | null;
  items?: InvoiceItemRow[];
};

export default function EditCustomerInvoicePage() {
  const router = useRouter();
  const { invoiceId } = router.query;
  const [currencies, setCurrencies] = useState<InvoiceCurrency[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');

  const dates = useInvoiceDateValidity();
  const [form, setForm] = useState<InvoiceHeaderForm>({ clientId: '', invoiceDate: '', dueDate: '', billingPeriodStart: '', billingPeriodEnd: '', taxRate: 15, notes: '', currencyCode: 'ZAR', exchangeRate: 1, projectId: '' });
  const [lines, setLines] = useState<LineItem[]>([]);
  const [taxMode, setTaxMode] = useState<TaxMode>('exclusive'); // a stored price is ex-VAT, so it loads as one

  useEffect(() => {
    if (!invoiceId) return;
    const id = String(invoiceId);
    void Promise.all([
      apiFetch('/api/accounting/currencies', { credentials: 'include' }).then(async r => { await assertOk(r, 'Could not load currencies - try again'); return r.json(); }),
      apiFetch(`/api/accounting/customer-invoices-detail?id=${id}`, { credentials: 'include' }).then(async r => { await assertOk(r, 'Could not load the invoice - try again'); return r.json(); }),
    ]).then(([curRes, invRes]) => {
      const curData = curRes.data || curRes; setCurrencies(Array.isArray(curData) ? curData : []);
      const invoice: InvoiceDetail = invRes.data || invRes;
      if (!invoice || !invoice.id) { setError('Invoice not found'); setLoading(false); return; }
      if (invoice.status !== 'draft') {
        setError(`This invoice is "${invoice.status}" and can no longer be edited. Only draft invoices are editable.`);
        setLoading(false);
        return;
      }
      setInvoiceNumber(invoice.invoice_number);
      setForm({
        clientId: String(invoice.client_id || invoice.customer_id || ''),
        invoiceDate: String(invoice.invoice_date || '').slice(0, 10),
        dueDate: invoice.due_date ? String(invoice.due_date).slice(0, 10) : '',
        billingPeriodStart: invoice.billing_period_start ? String(invoice.billing_period_start).slice(0, 10) : '',
        billingPeriodEnd: invoice.billing_period_end ? String(invoice.billing_period_end).slice(0, 10) : '',
        taxRate: Number(invoice.tax_rate ?? 15),
        notes: invoice.notes || '',
        currencyCode: invoice.currency_code || 'ZAR',
        exchangeRate: Number(invoice.exchange_rate ?? 1),
        projectId: invoice.project_id ?? '',
      });
      const items = invoice.items || [];
      // The schema has no `discount` column — it is folded into `amount`.
      // Reverse-engineer percent discount from amount vs (qty × unitPrice) so a
      // saved-then-reopened invoice round-trips without silently zeroing it —
      // exactly, so an unchanged save re-prices to the stored amount.
      setLines(items.length > 0 ? items.map((it, i) => {
        const qty = Number(it.quantity || 1);
        const unitPrice = Number(it.unit_price || 0);
        const amount = Number(it.amount ?? qty * unitPrice);
        const discount = discountFromAmount(qty, unitPrice, amount);
        return {
          key: String(i),
          description: String(it.description || ''),
          quantity: qty,
          unitPrice,
          discount,
          glAccountId: it.gl_account_id ?? '',
          projectId: it.project_id ?? '',
          cc2Id: it.cc2_id ?? '',
          buId: it.bu_id ?? '',
          cc1Id: it.cc1_id ?? null,
          cc2AtLoad: it.cc2_id ?? '',
        };
      }) : [{ key: '1', description: '', quantity: 1, unitPrice: 0, discount: 0, ...UNCODED, projectId: invoice.project_id ?? '' }]);
      setLoading(false);
    }).catch((err: unknown) => {
      setError(apiErrorMessage(err, 'Could not load the invoice - try again'));
      setLoading(false);
    });
  }, [invoiceId]);

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

  const handleSubmit = async () => {
    if (!form.clientId) return setError('Select a client');
    const validLines = lines.filter(l => l.description && l.unitPrice >= 0 && l.quantity > 0);
    if (validLines.length === 0) return setError('Add at least one line item');
    const dateProblem = invoiceDateProblem(form, dates.refused);
    if (dateProblem) return setError(dateProblem);
    setSubmitting(true); setError('');
    try {
      const res = await apiFetch('/api/accounting/customer-invoices-detail', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: String(invoiceId),
          clientId: form.clientId,
          invoiceDate: form.invoiceDate,
          dueDate: form.dueDate || undefined,
          billingPeriodStart: form.billingPeriodStart || undefined,
          billingPeriodEnd: form.billingPeriodEnd || undefined,
          taxRate,
          notes: form.notes || undefined,
          currencyCode: form.currencyCode,
          exchangeRate: form.exchangeRate,
          projectId: form.projectId || null,
          items: validLines.map(l => ({
            description: l.description, quantity: l.quantity,
            unitPrice: storedUnitPrice(taxMode, l.unitPrice, taxRate), taxRate,
            discount: l.discount || 0,
            glAccountId: l.glAccountId || null,
            projectId: l.projectId || null,
            cc2Id: l.cc2Id || null,
            buId: l.buId || null,
            cc1Id: l.cc2Id === (l.cc2AtLoad ?? '') ? (l.cc1Id ?? null) : null,
          })),
        }),
      });
      await assertOk(res, 'Could not save the invoice - try again');
      try { await router.push(`/accounting/customer-invoices/${String(invoiceId)}`); } catch (e) { log.warn('navigation failed', { error: e }, 'customer-invoices-edit-invoiceId'); }
    } catch (e) { setError(apiErrorMessage(e, 'Could not save the invoice - try again')); }
    finally { setSubmitting(false); }
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
              {error && <div role="alert" className="p-3 bg-red-50 dark:bg-red-900/20 rounded-xl border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm flex items-center gap-2"><AlertCircle className="h-4 w-4" />{error}</div>}

              <InvoiceHeaderFields form={form} onChange={patch => setForm(p => ({ ...p, ...patch }))} currencies={currencies} options={codingOptions}
                onProjectChange={v => setForm(p => ({ ...p, projectId: v }))} onDateValidity={dates.report} refused={dates.refused} taxMode={taxMode} onTaxModeChange={pickTaxMode} />

              <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
                <InvoiceLineItemsTable lines={lines} currencyCode={form.currencyCode} lineTotal={lineTotal}
                  onUpdate={updateLine} onAdd={addLine} onRemove={removeLine} options={codingOptions} pricesIncludeVat={taxMode === 'inclusive'} />
              </div>

              <InvoiceNotesCard value={form.notes} onChange={notes => setForm(p => ({ ...p, notes }))} placeholder="Notes or payment instructions…" />
            </div>

            <div className="lg:sticky lg:top-6 space-y-4">
              <InvoiceSummaryCard subtotal={subtotal} tax={tax} total={total} taxRate={taxRate} currencyCode={form.currencyCode} {...(taxMode === 'inclusive' ? { typedTotal: inclusiveTypedTotal(lines) } : {})}>
                <button onClick={handleSubmit} disabled={submitting} className="w-full mt-6 py-3 bg-brand-600 hover:bg-brand-700 text-white font-semibold rounded-xl transition-colors shadow-lg disabled:opacity-50 flex items-center justify-center gap-2 text-sm">
                  {submitting ? <><Loader2 className="h-4 w-4 animate-spin" />Saving…</> : <><FileText className="h-4 w-4" />Save Changes</>}
                </button>
                <Link href={`/accounting/customer-invoices/${String(invoiceId)}`} className="block w-full mt-2 py-2.5 text-center border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 font-semibold rounded-xl transition-colors text-sm">Cancel</Link>
              </InvoiceSummaryCard>
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
