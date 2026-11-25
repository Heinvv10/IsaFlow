/**
 * The New Quote modal (pages/accounting/customer-quotes): the customer, dates and notes, the lines with a VAT type per
 * line, "Amounts are" above them and the totals under them. Per-line VAT is the invoice form's (customer-invoices:
 * formVat, InvoiceLineVatSelect, InvoiceSettingsRow without its currency, InvoiceTotals, useTaxModeSwitch), and the
 * body is quoteFormVat's, so what the modal shows is what the server stores (VAT rounded per line).
 */
import { useState } from 'react';
import { FileText, Loader2, Plus, Trash2 } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { DateField } from '@/components/ui';
import { AmountInput } from '@/components/ui/AmountInput';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { localISODate } from '@/lib/dateUtils';
import { formatMoney as fmt } from '@/lib/money/formatMoney';
import { useDateGate } from '@/hooks/useDateGate';
import { formLineNet, formTotals, formVatByType, lineVatTypes, lineVatWarning } from '@/components/accounting/customer-invoices/formVat';
import { useTaxModeSwitch } from '@/components/accounting/customer-invoices/useTaxModeSwitch';
import { InvoiceSettingsRow } from '@/components/accounting/customer-invoices/InvoiceSettingsRow';
import { InvoiceTotals } from '@/components/accounting/customer-invoices/InvoiceTotals';
import { InvoiceLineVatSelect } from '@/components/accounting/customer-invoices/InvoiceLineVatSelect';
import { normaliseVatType, type TaxMode } from '@/components/accounting/customer-invoices/taxMode';
import { quoteBody, storedForm, type QuoteFormHeader, type QuoteFormLine } from './quoteFormVat';

/** A row of the customers list (contactDirectoryService.listCustomers): `default_vat_type` is its lines' VAT default. */
export interface CustomerOption { id: string; name: string; default_vat_type?: string | null }
interface Props { customers: CustomerOption[]; onClose: () => void; onCreated: () => void }

const inp = 'w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 transition-colors';
const lbl = 'block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5';
const th = 'px-3 py-2 text-xs font-semibold text-ink-muted';
let seq = 0;
const blank = (): QuoteFormLine => ({ key: `q${++seq}`, description: '', quantity: 1, unitPrice: 0 });
const ZAR = { currencyCode: 'ZAR', exchangeRate: 1 };

export function CreateQuoteModal({ customers, onClose, onCreated }: Props) {
  const [form, setForm] = useState<QuoteFormHeader>({ clientId: '', customerName: '', quoteDate: localISODate(), expiryDate: '', notes: '' });
  const [lines, setLines] = useState<QuoteFormLine[]>(() => [blank()]);
  const [taxMode, setTaxMode] = useState<TaxMode>('exclusive');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Set once Create is pressed on a form quoteBody holds: from then on its problem is shown LIVE, so fixing the line
  // clears the message at once (and a new problem shows) instead of waiting for the next press.
  const [held, setHeld] = useState(false);
  const dates = useDateGate();
  // The picked customer's default VAT type, from the list already loaded: no lookup to wait for.
  const customerVat = normaliseVatType(customers.find((c) => c.id === form.clientId)?.default_vat_type) || null;
  // Each line's type: its own, else the customer's default chain, read at render so it follows the customer (formVat).
  const types = lineVatTypes(lines, customerVat);
  const modeSwitch = useTaxModeSwitch({ lines, setLines, taxMode, setTaxMode, types, date: form.quoteDate });
  const mode = modeSwitch.vatMode; // 'none' for a company not registered for VAT
  // What is stored is what is shown: an inclusive quote is stored ex-VAT (storedForm), so its totals are read there.
  const stored = storedForm(lines, types, mode, form.quoteDate);
  const { subtotal, tax, total } = formTotals(stored.lines, types, stored.mode, form.quoteDate);
  const built = quoteBody(form, lines, mode, types);
  const update = (key: string, patch: Partial<QuoteFormLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const busy = saving || dates.blocked;

  const handleCreate = async () => {
    if (busy) return;
    if ('problem' in built) { setHeld(true); return; }
    setSaving(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/customer-quotes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(built.body),
      });
      await assertOk(res, 'Could not create the quote - try again');
      onCreated();
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e, 'Could not create the quote - try again'));
    } finally {
      setSaving(false);
    }
  };

  const shown = held && 'problem' in built ? built.problem : error;
  const showVat = mode !== 'none';
  return (
    <Modal open onClose={onClose} title="New Quote" size="xl">
      <Modal.Body className="space-y-5">
        <p className="text-xs text-ink-muted">Fill in the quote details below</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="sm:col-span-3">
            <label htmlFor="quote-customer" className={lbl}>Customer *</label>
            <select id="quote-customer" value={form.clientId} onChange={e => { const s = customers.find(c => c.id === e.target.value); setForm(p => ({ ...p, clientId: e.target.value, customerName: s?.name ?? '' })); }} className={inp}>
              <option value="">Select a customer…</option>
              {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <DateField label="Quote Date" name="quoteDate" required value={form.quoteDate || null} onChange={dates.bind('quoteDate', iso => setForm(p => ({ ...p, quoteDate: iso })), form.quoteDate)} />
          <DateField label="Expiry Date" name="expiryDate" value={form.expiryDate || null} onChange={dates.bind('expiryDate', iso => setForm(p => ({ ...p, expiryDate: iso })), form.expiryDate)} />
          <div><label htmlFor="quote-notes" className={lbl}>Notes</label><input id="quote-notes" value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} placeholder="Optional" className={inp} /></div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-slate-100 dark:border-slate-800">
            <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Line items</span>
            <button type="button" onClick={() => setLines(l => [...l, blank()])} className="text-xs text-amber-700 hover:text-amber-800 dark:text-amber-300 dark:hover:text-amber-200 flex items-center gap-1 font-semibold transition-colors"><Plus className="w-3 h-3" />Add line</button>
          </div>
          <InvoiceSettingsRow form={ZAR} currencies={[]} onChange={() => undefined} currency={false} registered={modeSwitch.registered}
            taxMode={mode} taxModes={modeSwitch.modes} taxModeProblem={modeSwitch.problem} onTaxModeChange={modeSwitch.pick} />
          {showVat && (
            <div role="status" className="px-3 empty:hidden">
              {lineVatWarning(customerVat, types) && <p className="pt-2 text-xs text-amber-700 dark:text-amber-300">{lineVatWarning(customerVat, types)}</p>}
            </div>
          )}
          <div className="overflow-x-auto">
          <table className="block md:table w-full text-sm" aria-label="Quote line items">
            <thead className="hidden md:table-header-group bg-slate-50 dark:bg-slate-800/60"><tr>
              <th className={`${th} text-left`}>Description</th>
              <th className={`${th} text-right w-20`}>Qty</th>
              <th className={`${th} text-right w-28`}>Unit Price{mode === 'inclusive' && <span className="font-normal"> (incl. VAT)</span>}</th>
              {showVat && <th className={`${th} text-left w-40`}>VAT</th>}
              <th className={`${th} text-right w-24`}>Total{mode === 'inclusive' && <span className="font-normal"> (excl. VAT)</span>}</th>
              <th className="w-8"><span className="sr-only">Remove line</span></th>
            </tr></thead>
            <tbody className="block md:table-row-group divide-y divide-slate-100 dark:divide-slate-800">
              {lines.map((l, i) => (
                <tr key={l.key} className="group grid grid-cols-3 gap-2 p-3 md:table-row md:p-0">
                  <td className="col-span-3 md:table-cell px-0 md:px-2 py-0 md:py-2"><input aria-label={`Description, line ${i + 1}`} value={l.description} onChange={e => update(l.key, { description: e.target.value })} placeholder="Item description" className={inp} /></td>
                  <td className="md:table-cell px-0 md:px-2 py-0 md:py-2"><span className="md:hidden block text-xs text-slate-600 dark:text-slate-400 mb-1">Qty</span><AmountInput aria-label={`Quantity, line ${i + 1}`} value={l.quantity} min={0.01} decimals={2} onValueChange={v => update(l.key, { quantity: v })} className={`${inp} text-right`} /></td>
                  <td className="md:table-cell px-0 md:px-2 py-0 md:py-2"><span className="md:hidden block text-xs text-slate-600 dark:text-slate-400 mb-1">Unit price</span><AmountInput aria-label={`Unit price, line ${i + 1}`} value={l.unitPrice} min={0} onValueChange={v => update(l.key, { unitPrice: v })} className={`${inp} text-right`} /></td>
                  {/* Below md the row is a grid: description; qty, unit price, total; then the VAT type on its own row (order-1). */}
                  {showVat && <td className="col-span-3 order-1 md:order-none md:table-cell px-0 md:px-2 py-0 md:py-2"><span className="md:hidden block text-xs text-slate-600 dark:text-slate-400 mb-1">VAT type</span><InvoiceLineVatSelect label={`VAT type, line ${i + 1}`} value={types[i] ?? null} date={form.quoteDate} onChange={t => update(l.key, { vatType: t })} /></td>}
                  <td className="md:table-cell px-0 md:px-3 py-0 md:py-2 text-right tabular-nums text-xs font-semibold text-slate-700 dark:text-slate-300"><span className="md:hidden block text-xs font-normal text-slate-600 dark:text-slate-400 mb-1">Total</span>{fmt(formLineNet(stored.lines[i]!, types[i] ?? null, stored.mode, form.quoteDate))}</td>
                  <td className="col-span-3 order-2 md:order-none flex justify-end md:table-cell px-0 md:px-2 py-0 md:py-2"><button type="button" aria-label={`Remove line ${i + 1}`} onClick={() => lines.length > 1 && setLines(lines.filter((_, j) => j !== i))} className="p-1 min-h-11 min-w-11 md:min-h-0 md:min-w-0 inline-flex items-center justify-center rounded text-slate-700 dark:text-slate-300 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"><Trash2 className="w-3.5 h-3.5" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <InvoiceTotals subtotal={subtotal} tax={tax} total={total} currencyCode="ZAR" byType={formVatByType(stored.lines, types, stored.mode, form.quoteDate)} date={form.quoteDate} />
        </div>

        {shown && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{shown}</p>}
      </Modal.Body>
      <Modal.Footer>
        <button type="button" onClick={onClose} className="px-4 py-2 min-h-11 sm:min-h-0 text-sm text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors">Cancel</button>
        <button type="button" onClick={() => { void handleCreate(); }} disabled={busy || !form.clientId} className="px-5 py-2 text-sm font-semibold bg-brand-600 hover:bg-brand-700 text-white rounded-lg transition-colors disabled:opacity-40 flex items-center gap-2">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
          {saving ? 'Creating…' : 'Create Quote'}
        </button>
      </Modal.Footer>
    </Modal>
  );
}
