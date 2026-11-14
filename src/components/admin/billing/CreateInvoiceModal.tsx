/**
 * Admin "Create Invoice" dialog. The admin enters the subtotal; VAT (15%) and the total are the server's
 * (createInvoice computes them, the API refuses a client-sent tax or total). The preview here uses the same
 * function, invoiceAmountsFromSubtotal, so what is shown is what is stored. A blank due date or notes is left
 * out of the request, never sent as null.
 */
import { useState } from 'react';
import { AlertCircle, Check, Loader2, X } from 'lucide-react';
import { apiFetch, apiErrorMessage, assertOk } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';
import { DateField } from '@/components/ui/DateField';
import { invoiceAmountsFromSubtotal, MAX_INVOICE_SUBTOTAL_CENTS } from '@/modules/admin/services/invoiceAmounts';
import { EMPTY_FORM, type InvForm } from './invoiceModel';

interface Props {
  onClose: () => void;
  onCreated: () => void;
}

const INPUT = 'w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-teal-500';
const LABEL = 'block text-xs font-medium text-ink-muted mb-1';
const FAILURE = 'Could not create the invoice - try again';
const TOO_LARGE = `Subtotal may be at most ${formatCurrency(MAX_INVOICE_SUBTOTAL_CENTS / 100)}`;

/** Rands typed by the admin -> whole cents, or null when it is not a non-negative amount. */
function toCents(rands: string): number | null {
  const n = Number(rands.trim());
  if (rands.trim() === '' || !Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export function CreateInvoiceModal({ onClose, onCreated }: Props) {
  const [form, setForm] = useState<InvForm>(EMPTY_FORM);
  const [dueDateValid, setDueDateValid] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const cents = toCents(form.subtotal);
  // Only an amount the server would take gets a preview; anything else shows a dash (a huge one used to throw).
  const preview = cents === null || cents > MAX_INVOICE_SUBTOTAL_CENTS ? null : invoiceAmountsFromSubtotal(cents);

  async function create() {
    setError('');
    if (!form.company_id.trim()) { setError('Company ID is required'); return; }
    if (cents === null) { setError('Subtotal is required'); return; }
    if (cents > MAX_INVOICE_SUBTOTAL_CENTS) { setError(TOO_LARGE); return; }
    if (!dueDateValid) { setError('Due date is not a date - correct it or clear it'); return; }
    setSaving(true);
    try {
      const notes = form.notes.trim();
      const res = await apiFetch('/api/admin/billing/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Request': 'true' },
        body: JSON.stringify({
          company_id: form.company_id.trim(),
          subtotal_cents: cents,
          ...(form.due_date ? { due_date: form.due_date } : {}),
          ...(notes ? { notes } : {}),
        }),
      });
      await assertOk(res, FAILURE);
      onCreated();
    } catch (err) {
      setError(apiErrorMessage(err, FAILURE));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="invoice-modal-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700">
          <h3 id="invoice-modal-title" className="text-sm font-semibold text-gray-900 dark:text-white">Create Invoice</h3>
          <button onClick={onClose} aria-label="Close" className="text-gray-600 dark:text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-4">
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-xs">
              <AlertCircle className="w-4 h-4 flex-shrink-0" /> {error}
            </div>
          )}
          <div>
            <label htmlFor="invoice-company-id" className={LABEL}>Company ID</label>
            <input id="invoice-company-id" type="text" value={form.company_id} className={INPUT}
              onChange={(e) => setForm((f) => ({ ...f, company_id: e.target.value }))} />
          </div>
          <div>
            <label htmlFor="invoice-subtotal" className={LABEL}>Subtotal (R)</label>
            <input id="invoice-subtotal" type="number" min="0" step="0.01" value={form.subtotal} className={INPUT}
              onChange={(e) => setForm((f) => ({ ...f, subtotal: e.target.value }))} />
            {cents !== null && cents > MAX_INVOICE_SUBTOTAL_CENTS && <p role="alert" className="mt-1 text-xs text-red-500">{TOO_LARGE}</p>}
          </div>
          <dl className="grid grid-cols-2 gap-1 text-sm">
            <dt className="text-ink-muted">VAT (15%)</dt>
            <dd data-testid="invoice-vat-preview" className="text-right tabular-nums text-gray-900 dark:text-white">{preview ? formatCurrency(preview.tax_cents / 100) : '—'}</dd>
            <dt className="text-ink-muted">Total</dt>
            <dd data-testid="invoice-total-preview" className="text-right tabular-nums font-semibold text-gray-900 dark:text-white">{preview ? formatCurrency(preview.total_cents / 100) : '—'}</dd>
          </dl>
          <DateField label="Due Date (optional)" value={form.due_date || null}
            onChange={(iso, v) => { setDueDateValid(v.valid); setForm((f) => ({ ...f, due_date: iso ?? '' })); }} />
          <div>
            <label htmlFor="invoice-notes" className={LABEL}>Notes (optional)</label>
            <textarea id="invoice-notes" rows={3} value={form.notes} className={INPUT}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
          </div>
        </div>
        <div className="px-5 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors">Cancel</button>
          <button onClick={() => void create()} disabled={saving}
            className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Create
          </button>
        </div>
      </div>
    </div>
  );
}
