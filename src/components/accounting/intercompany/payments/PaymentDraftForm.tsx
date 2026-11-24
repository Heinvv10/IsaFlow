/**
 * "Draft a receipt" for a payment message (intercompany F, outcome `draft`): the person picks the bank account, the receipt date and how the
 * payment is spread over the customer's open invoices (the linked invoice first, filled by default); the amounts must add up to exactly the
 * payment (no part payments). Nothing is posted: the draft is confirmed later through the normal receipt Confirm. What the person saw
 * (the amount, the state, the invoices offered) goes with the request, so a change since is a reload, not a guess.
 */
import { useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { DateField } from '@/components/ui';
import { apiErrorMessage, apiJson } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';
import type { PaymentItem, PaymentSuggestions } from '@/modules/accounting/services/intercompany/paymentInboxTypes';

interface Props {
  item: PaymentItem;
  suggestions: PaymentSuggestions;
  onDone: (msg: string) => void;
  onCancel: () => void;
}

const cents = (n: number) => Math.round(n * 100);

export function PaymentDraftForm({ item, suggestions, onDone, onCancel }: Props) {
  const amount = item.amount ?? 0;
  const [bank, setBank] = useState(suggestions.bankAccounts[0]?.id ?? '');
  const [date, setDate] = useState<string | null>(item.paymentDate ?? suggestions.today);
  const [split, setSplit] = useState<Record<string, string>>(() => {
    const first = suggestions.invoices[0];
    return first ? { [first.id]: String(Math.min(amount, first.openAmount)) } : {};
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const picked = useMemo(() => suggestions.invoices
    .map((i) => ({ invoiceId: i.id, amount: Number(split[i.id] ?? 0) }))
    .filter((a) => Number.isFinite(a.amount) && a.amount > 0), [split, suggestions.invoices]);
  const total = picked.reduce((s, a) => s + cents(a.amount), 0);

  async function submit() {
    if (busy) return;
    if (total !== cents(amount)) { setError(`The amounts must add up to exactly ${formatCurrency(amount)}.`); return; }
    if (!date) { setError('Choose a receipt date on or after the payment date, not after today.'); return; }
    setBusy(true);
    setError('');
    try {
      const out = await apiJson(`/api/accounting/intercompany/payments/${item.id}/accept`, {
        method: 'POST',
        body: JSON.stringify({
          outcome: 'draft', bankAccountId: bank, paymentDate: date, allocations: picked,
          expected: { amount, state: item.state, invoiceIds: suggestions.invoices.map((i) => i.id) },
        }),
      }, 'Could not draft the receipt - try again') as { receiptNumber?: string };
      onDone(`Draft receipt ${out?.receiptNumber ?? ''} created. Confirm it from Receipts once the cash is in your bank; match the bank line to it, do not allocate the line again.`);
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not draft the receipt - try again'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form aria-label="Draft a receipt" noValidate className="space-y-3 rounded-lg border border-line p-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <p className="text-sm text-ink-muted">One draft receipt for {formatCurrency(amount)}. Nothing is posted until someone with Approve confirms it.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-medium text-ink-muted">Bank account
          <select className="ff-input w-full text-sm mt-1" value={bank} onChange={(e) => setBank(e.target.value)}>
            {suggestions.bankAccounts.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
          </select>
        </label>
        <DateField label="Receipt date" value={date} minDate={item.paymentDate ?? undefined} maxDate={suggestions.today}
          onChange={(iso, v) => setDate(v.valid ? iso : null)} />
      </div>
      <fieldset className="space-y-2">
        <legend className="text-xs font-medium text-ink-muted">Spread over your open invoices</legend>
        {suggestions.invoices.map((i) => (
          <label key={i.id} className="flex items-center justify-between gap-3 text-sm">
            <span>{i.number}{i.linked ? ' (linked)' : ''} - open {formatCurrency(i.openAmount)}</span>
            <input type="number" step="0.01" min="0" aria-label={`Amount on ${i.number}`} className="ff-input w-32 text-sm text-right"
              value={split[i.id] ?? ''} onChange={(e) => setSplit((s) => ({ ...s, [i.id]: e.target.value }))} />
          </label>
        ))}
      </fieldset>
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onCancel} disabled={busy} className="px-3 py-2 text-sm rounded-lg border border-line text-ink">Cancel</button>
        <button type="submit" disabled={busy || !bank} className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 text-white disabled:opacity-50 inline-flex items-center gap-2">
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}Create draft receipt
        </button>
      </div>
    </form>
  );
}
