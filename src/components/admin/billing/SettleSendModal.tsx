/**
 * Settle an invoice Send whose outcome is unknown (the claim of migration 991): the email may or may not have
 * left. The admin checks the email log first, then marks it sent (it was delivered) or releases it (it was not,
 * so it can be sent again). POST /api/admin/billing/invoices/[id]/settle-send, audited `invoice.send_settled`.
 */
import { useState } from 'react';
import { AlertCircle, Loader2, X } from 'lucide-react';
import { apiFetch, apiErrorMessage, assertOk } from '@/lib/apiFetch';
import { formatDisplayDateTime } from '@/utils/dateFormat';
import { claimAgeText } from '@/modules/admin/services/invoiceSendTiming';
import type { Invoice } from './invoiceModel';

type Outcome = 'sent' | 'released';
const FAILURE = 'Could not settle the send - try again';

interface Props {
  invoice: Invoice;
  onClose: () => void;
  onSettled: (outcome: Outcome) => void;
}

export function SettleSendModal({ invoice, onClose, onSettled }: Props) {
  const [busy, setBusy] = useState<Outcome | null>(null);
  const [error, setError] = useState('');

  async function settle(outcome: Outcome) {
    setBusy(outcome);
    setError('');
    try {
      const res = await apiFetch(`/api/admin/billing/invoices/${invoice.id}/settle-send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Request': 'true' },
        body: JSON.stringify({ outcome }),
      });
      await assertOk(res, FAILURE);
      onSettled(outcome);
    } catch (err) {
      setError(apiErrorMessage(err, FAILURE));
    } finally {
      setBusy(null);
    }
  }

  const btn = 'inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-50';
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="settle-send-title" className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 id="settle-send-title" className="font-semibold text-gray-900 dark:text-white">Settle send of {invoice.invoice_number}</h3>
          <button onClick={onClose} aria-label="Close" className="text-gray-600 dark:text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"><X className="w-5 h-5" /></button>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
          A send to {invoice.billing_email ?? `${invoice.company_name}'s billing email`} started
          {invoice.send_claimed_at ? ` ${formatDisplayDateTime(invoice.send_claimed_at)} (${claimAgeText(invoice.send_claimed_at)} ago)` : ''} and
          its outcome is unknown. Check the email log for {invoice.invoice_number} first. If it was delivered, mark it as sent.
          If it was not, release it so it can be sent again.
        </p>
        {error && (
          <div className="flex items-center gap-2 p-3 mb-4 rounded-lg bg-red-500/10 text-red-400 text-xs"><AlertCircle className="w-4 h-4 flex-shrink-0" /> {error}</div>
        )}
        <div className="flex gap-3 justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors">Cancel</button>
          <button onClick={() => void settle('released')} disabled={busy !== null}
            className={`${btn} border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-white`}>
            {busy === 'released' && <Loader2 className="w-4 h-4 animate-spin" />} Release, not sent
          </button>
          <button onClick={() => void settle('sent')} disabled={busy !== null} className={`${btn} bg-brand-600 hover:bg-brand-700 text-white`}>
            {busy === 'sent' && <Loader2 className="w-4 h-4 animate-spin" />} Mark as sent
          </button>
        </div>
      </div>
    </div>
  );
}
