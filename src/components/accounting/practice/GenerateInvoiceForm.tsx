/**
 * Generate Invoice: pick a practice client, tick its unbilled approved time,
 * and create a DRAFT customer invoice through POST /api/accounting/practice/wip/invoice
 * (the same server path as the WIP board, which locks, numbers and marks the
 * entries billed). The preview prices with the shared invoiceTotals, the
 * figure the server stores.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { localISODate } from '@/lib/dateUtils';
import { formatMoney } from '@/lib/money/formatMoney';
import { GatedDateField, useDateGate } from '@/components/forms/GatedDateField';
import { useVatRegistration } from '@/hooks/useVatRegistration';
import { previewTotals } from '@/modules/accounting/services/ar/invoiceLineAmount';
import type { WipClientRow, GenerateWipInvoiceInput, WipInvoiceResult } from '@/modules/accounting/services/practice/practiceWipService';
import type { PracticeClient } from '@/modules/accounting/services/practice/practiceClientService';
import { WipEntryPickTable } from './WipEntryPickTable';

type GroupBy = NonNullable<GenerateWipInvoiceInput['groupBy']>;
type ClientOption = Pick<PracticeClient, 'id' | 'legalName' | 'tradingName' | 'linkCustomerId'>;

// Standard VAT rate: 15% from 1 April 2018, Value-Added Tax Act 89 of 1991 s 7(1). The user can change it per invoice.
const STANDARD_VAT_RATE = '15';
const RING = 'focus:outline-none focus:ring-2 focus:ring-teal-500/40';
const INPUT_CLS = `w-full rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-tertiary)] px-3 py-2 text-sm text-[var(--ff-text-primary)] ${RING}`;
const LABEL_CLS = 'block text-xs font-medium text-[var(--ff-text-secondary)] mb-1';
const GROUPINGS: [GroupBy, string][] = [['detailed', 'Detailed (one line per entry)'], ['by_work_item', 'By work item'], ['by_category', 'By category']];

function ErrBanner({ msg }: { msg: string }) {
  return <div role="alert" className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-500 text-sm"><AlertCircle className="h-4 w-4 shrink-0" />{msg}</div>;
}

/** What stops the form from posting, or null. */
export function validateGenerateInvoice(v: { clientId: string; selectedCount: number; invoiceDate: string; dueDate: string; taxRate: string }): string | null {
  if (!v.clientId) return 'Choose a client.';
  if (v.selectedCount === 0) return 'Select at least one time entry.';
  if (!v.invoiceDate) return 'Enter the invoice date.';
  if (v.dueDate && v.dueDate < v.invoiceDate) return 'Due date cannot be before the invoice date.';
  const rate = Number(v.taxRate);
  if (v.taxRate.trim() === '' || !Number.isFinite(rate) || rate < 0 || rate > 100) return 'VAT rate must be between 0 and 100.';
  return null;
}

export function GenerateInvoiceForm() {
  const vat = useVatRegistration();
  const dateGate = useDateGate();
  const [clients, setClients] = useState<ClientOption[] | null>(null);
  const [clientsError, setClientsError] = useState<string | null>(null);
  const [clientId, setClientId] = useState('');
  const [wip, setWip] = useState<WipClientRow | null>(null);
  const [wipLoading, setWipLoading] = useState(false);
  const [wipError, setWipError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [invoiceDate, setInvoiceDate] = useState(localISODate());
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [groupBy, setGroupBy] = useState<GroupBy>('detailed');
  const [taxRate, setTaxRate] = useState(STANDARD_VAT_RATE);
  const [rateTouched, setRateTouched] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<WipInvoiceResult | null>(null);

  // The company's VAT status sets the default rate once it is known; a rate the user typed stays.
  useEffect(() => {
    if (vat.known && !rateTouched) setTaxRate(vat.isRegistered ? STANDARD_VAT_RATE : '0');
  }, [vat.known, vat.isRegistered, rateTouched]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await apiFetch('/api/accounting/practice/clients?status=active&limit=500');
        await assertOk(res, 'Could not load clients - try again');
        const json = (await res.json()) as { data?: { clients?: ClientOption[] } };
        setClients(json.data?.clients ?? []);
      } catch (err) { setClients([]); setClientsError(apiErrorMessage(err, 'Could not load clients - try again')); }
    })();
  }, []);

  const wipRequest = useRef(0);
  const loadWip = useCallback(async (id: string) => {
    const mine = ++wipRequest.current;
    setWip(null); setSelected(new Set()); setWipError(null);
    if (!id) { setWipLoading(false); return; }
    setWipLoading(true);
    try {
      const res = await apiFetch(`/api/accounting/practice/wip?practiceClientId=${encodeURIComponent(id)}`);
      await assertOk(res, 'Could not load the unbilled time - try again');
      const json = (await res.json()) as { data?: WipClientRow[] };
      if (mine !== wipRequest.current) return; // a newer client pick superseded this response
      const row = json.data?.[0] ?? null;
      setWip(row);
      setSelected(new Set(row?.entries.map((e) => e.id) ?? []));
    } catch (err) {
      if (mine === wipRequest.current) setWipError(apiErrorMessage(err, 'Could not load the unbilled time - try again'));
    } finally { if (mine === wipRequest.current) setWipLoading(false); }
  }, []);

  function pickClient(id: string) {
    setClientId(id); setFormError(null); setResult(null);
    void loadWip(id);
  }

  function toggle(id: string) {
    setSelected((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }
  function toggleAll() {
    const all = wip?.entries ?? [];
    setSelected((p) => (p.size < all.length ? new Set(all.map((e) => e.id)) : new Set()));
  }

  const client = clients?.find((c) => c.id === clientId) ?? null;
  const entries = wip?.entries ?? [];
  const picked = entries.filter((e) => selected.has(e.id));
  const pickedHours = picked.reduce((s, e) => s + Number(e.hours), 0);
  const totals = previewTotals(picked.map((e) => Number(e.lineTotal ?? 0)), Number(taxRate));
  const unlinked = client != null && !client.linkCustomerId;

  async function submit() {
    const problem = validateGenerateInvoice({ clientId, selectedCount: picked.length, invoiceDate, dueDate, taxRate });
    if (problem) { setFormError(problem); return; }
    if (dateGate.blocked) { setFormError('Fix the date marked in red.'); return; }
    setFormError(null); setSubmitting(true);
    try {
      const input: GenerateWipInvoiceInput = {
        practiceClientId: clientId, timeEntryIds: picked.map((e) => e.id), invoiceDate,
        taxRate: Number(taxRate), groupBy,
        ...(dueDate ? { dueDate } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}),
      };
      const res = await apiFetch('/api/accounting/practice/wip/invoice', { method: 'POST', body: JSON.stringify(input) });
      await assertOk(res, 'Could not generate the invoice - try again');
      const json = (await res.json()) as { data: WipInvoiceResult };
      setResult(json.data);
      setNotes(''); setDueDate('');
      await loadWip(clientId);
    } catch (err) { setFormError(apiErrorMessage(err, 'Could not generate the invoice - try again')); }
    finally { setSubmitting(false); }
  }

  const skipped = result?.skippedEntryCount ?? 0;
  return (
    <div className="space-y-5">
      {result && (
        <div role="status" className="p-4 rounded-lg bg-teal-500/10 border border-teal-500/20 text-sm text-[var(--ff-text-primary)] space-y-2">
          <p className="flex items-center gap-2 font-medium"><CheckCircle2 className="h-4 w-4 text-teal-500" />Draft invoice {result.invoiceNumber} created ({formatMoney(result.totalAmount)}).</p>
          {skipped > 0 && <p>{skipped} selected entr{skipped === 1 ? 'y was' : 'ies were'} no longer billable and left out.</p>}
          <div className="flex gap-4">
            <Link href={`/accounting/customer-invoices/${result.invoiceId}`} className="underline underline-offset-2">View draft invoice</Link>
            <button type="button" onClick={() => setResult(null)} className="underline underline-offset-2">Generate another</button>
          </div>
        </div>
      )}
      {clientsError && <ErrBanner msg={clientsError} />}
      <div className="max-w-md">
        <label htmlFor="gi-client" className={LABEL_CLS}>Client</label>
        <select id="gi-client" value={clientId} onChange={(e) => pickClient(e.target.value)} disabled={clients == null} className={INPUT_CLS}>
          <option value="">{clients == null ? 'Loading clients...' : 'Choose a client'}</option>
          {(clients ?? []).map((c) => <option key={c.id} value={c.id}>{c.legalName}{c.tradingName ? ` (${c.tradingName})` : ''}</option>)}
        </select>
      </div>
      {unlinked && (
        <div role="alert" className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-sm text-[var(--ff-text-primary)]">
          This client has no linked customer, so it cannot be invoiced yet.{' '}
          <Link href={`/accounting/practice/clients/${clientId}`} className="underline underline-offset-2">Set the linked customer</Link>
        </div>
      )}
      {wipError && <ErrBanner msg={wipError} />}
      {wipLoading && <div className="flex items-center gap-2 text-sm text-[var(--ff-text-tertiary)]"><Loader2 className="h-4 w-4 animate-spin" />Loading unbilled time...</div>}
      {clientId && !wipLoading && !wipError && entries.length === 0 && (
        <p className="py-8 text-center text-sm text-[var(--ff-text-tertiary)]">
          No unbilled approved time for this client. <Link href="/accounting/practice/approvals" className="underline underline-offset-2">Go to Approvals</Link>
        </p>
      )}
      {entries.length > 0 && (
        <>
          <WipEntryPickTable entries={entries} selected={selected} onToggle={toggle} onToggleAll={toggleAll} />
          <p className="text-xs text-[var(--ff-text-tertiary)]">{picked.length} of {entries.length} entries selected, {pickedHours.toFixed(2)}h</p>
          <div className="grid gap-4 md:grid-cols-2 max-w-3xl">
            <GatedDateField gate={dateGate} gateKey="gi-invoice-date" label="Invoice Date" value={invoiceDate || null} onValue={setInvoiceDate} />
            <div>
              <GatedDateField gate={dateGate} gateKey="gi-due-date" label="Due Date (optional)" value={dueDate || null} onValue={setDueDate} />
              <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">Leave blank to use the customer&apos;s payment terms.</p>
            </div>
            <div className="md:col-span-2">
              <label htmlFor="gi-notes" className={LABEL_CLS}>Description (optional)</label>
              <textarea id="gi-notes" rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} className={INPUT_CLS} />
            </div>
            <fieldset>
              <legend className={LABEL_CLS}>Grouping</legend>
              {GROUPINGS.map(([v, l]) => (
                <label key={v} className="flex items-center gap-2 cursor-pointer text-sm text-[var(--ff-text-primary)]">
                  <input type="radio" name="gi-groupBy" value={v} checked={groupBy === v} onChange={() => setGroupBy(v)} className="accent-teal-500" />{l}
                </label>
              ))}
            </fieldset>
            <div>
              <label htmlFor="gi-rate" className={LABEL_CLS}>VAT Rate (%)</label>
              <input id="gi-rate" type="number" min={0} max={100} step={0.01} value={taxRate} onChange={(e) => { setRateTouched(true); setTaxRate(e.target.value); }} className={INPUT_CLS} />
            </div>
          </div>
          <dl data-testid="gi-totals" className="max-w-xs ml-auto text-sm space-y-1">
            <div className="flex justify-between"><dt>Subtotal</dt><dd className="tabular-nums" data-testid="gi-subtotal">{formatMoney(totals.subtotal)}</dd></div>
            <div className="flex justify-between"><dt>VAT</dt><dd className="tabular-nums" data-testid="gi-vat">{formatMoney(totals.tax)}</dd></div>
            <div className="flex justify-between font-semibold"><dt>Total</dt><dd className="tabular-nums" data-testid="gi-total">{formatMoney(totals.total)}</dd></div>
          </dl>
        </>
      )}
      {formError && <ErrBanner msg={formError} />}
      {clientId && entries.length > 0 && (
        <div className="flex justify-end">
          <button type="button" onClick={() => void submit()} disabled={submitting || unlinked}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium">
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}{submitting ? 'Generating...' : 'Generate draft invoice'}
          </button>
        </div>
      )}
    </div>
  );
}
