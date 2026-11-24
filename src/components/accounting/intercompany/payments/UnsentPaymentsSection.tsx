/**
 * The PAYER's "Paid with no payment message" list (intercompany F, (k) M-4): this company's bank payments on bills linked to a partner's
 * invoices (cash connection, past the cut-over) that carry no message, oldest first, so a lost message is found. Read only. Shown only when
 * there is something to say (an item, or a state the list cannot judge).
 */
import { useEffect, useState } from 'react';
import { apiErrorMessage, apiJson } from '@/lib/apiFetch';
import { formatCurrency, formatDate } from '@/utils/formatters';
import type { UnsentPage } from '@/modules/accounting/services/intercompany/paymentInboxTypes';

export function UnsentPaymentsSection() {
  const [page, setPage] = useState<UnsentPage | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    apiJson('/api/accounting/intercompany/payments/unsent', undefined, 'Could not load the unsent payments - try again')
      .then((p) => { if (current) setPage(p as UnsentPage); })
      .catch((err: unknown) => { if (current) setError(apiErrorMessage(err, '')); });
    return () => { current = false; };
  }, []);
  if (error || !page || (page.state === 'ok' && page.items.length === 0)) return null;
  return (
    <section aria-labelledby="ic-unsent-heading" className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
      <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800">
        <h2 id="ic-unsent-heading" className="text-base font-semibold text-ink">Paid with no payment message</h2>
        <p className="text-sm text-ink-muted">Your bank payments on bills linked to a group company&apos;s invoices that did not send it a payment message. The partner sees nothing for these.</p>
      </div>
      {page.state === 'cannot_determine' ? <p className="px-5 py-4 text-sm text-ink-muted">{page.sentence}</p> : (
        <table className="table-cards w-full text-sm">
          <caption className="sr-only">Paid with no payment message: payment, date, bill, partner and amount</caption>
          <thead><tr>{['Payment', 'Date', 'Bill', 'Partner', 'Amount'].map((h) => <th key={h} className="px-5 py-3 text-left text-xs font-semibold text-ink-muted uppercase">{h}</th>)}</tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {page.items.map((u) => (
              <tr key={u.allocationId}>
                <td className="px-5 py-3">{u.paymentNumber ?? '—'}</td><td className="px-5 py-3">{formatDate(u.paymentDate)}</td>
                <td className="px-5 py-3">{u.billNumber ?? '—'}</td><td className="px-5 py-3">{u.partnerName}</td>
                <td className="px-5 py-3">{formatCurrency(u.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
