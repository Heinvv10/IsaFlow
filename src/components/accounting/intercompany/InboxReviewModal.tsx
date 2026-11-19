/**
 * Review an intercompany message before accepting it: the sender's figures, the supplier the draft will go on, the expense account for
 * each line (the one used last time for that description, else this connection's default; change any), and whatever blocks Accept.
 * Accepting creates a DRAFT only; nothing is approved or posted.
 */
import { useEffect, useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { apiErrorMessage, apiJson } from '@/lib/apiFetch';
import { formatCurrency, formatDate } from '@/utils/formatters';
import type { AcceptResult, InboxDetail, InboxItem } from '@/modules/accounting/services/intercompany/inboxTypes';

interface Props {
  item: InboxItem | null;
  canWrite: boolean;
  onClose: () => void;
  onReject: (item: InboxItem) => void;
  onAccepted: (item: InboxItem, result: AcceptResult) => void;
}

const SOURCE_NOTE = { last_used: 'used last time', default: 'default for this connection' } as const;

export function InboxReviewModal({ item, canWrite, onClose, onReject, onAccepted }: Props) {
  const [detail, setDetail] = useState<InboxDetail | null>(null);
  const [loadError, setLoadError] = useState('');
  const [chosen, setChosen] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setDetail(null); setLoadError(''); setError(''); setChosen({});
    if (!item) return undefined;
    let current = true;
    apiJson(`/api/accounting/intercompany/inbox/${item.id}`, undefined, 'Could not load this message - try again')
      .then((d) => { if (current) { setDetail(d); setChosen(Object.fromEntries(d.lines.filter((l) => l.accountId).map((l) => [l.index, l.accountId as string]))); } })
      .catch((err: unknown) => { if (current) setLoadError(apiErrorMessage(err, 'Could not load this message - try again')); });
    return () => { current = false; };
  }, [item]);

  const isNote = item?.kind === 'credit_note';
  const missing = detail ? detail.lines.some((l) => !chosen[l.index]) : true;
  const blocked = !detail || detail.blockers.length > 0 || missing;

  async function accept() {
    if (!item || !detail) return;
    setBusy(true); setError('');
    try {
      const body = isNote ? { accountId: chosen[0] } : { lineAccounts: chosen };
      const result = await apiJson(`/api/accounting/intercompany/inbox/${item.id}/accept`, { method: 'POST', body: JSON.stringify(body) },
        'Could not accept this message - try again');
      onAccepted(item, result);
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not accept this message - try again'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={item !== null} onClose={busy ? () => undefined : onClose} size="xl"
      title={item ? `${isNote ? 'Credit note' : 'Invoice'} ${item.number} from ${item.senderName}` : 'Review'}>
      <Modal.Body>
        {!detail && !loadError && <p className="flex items-center gap-2 text-sm text-ink-muted"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />Loading…</p>}
        {loadError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{loadError}</p>}
        {detail && (
          <div className="space-y-4">
            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <div><dt className="text-xs text-ink-muted">Date</dt><dd>{formatDate(detail.item.date)}</dd></div>
              <div><dt className="text-xs text-ink-muted">Due</dt><dd>{formatDate(detail.item.dueDate)}</dd></div>
              <div><dt className="text-xs text-ink-muted">Draft goes on supplier</dt><dd>{detail.supplier?.name ?? <span className="text-amber-700 dark:text-amber-400">Not linked yet</span>}</dd></div>
              <div><dt className="text-xs text-ink-muted">Total</dt><dd className="font-semibold tabular-nums">{detail.item.total === null ? '—' : formatCurrency(detail.item.total)}</dd></div>
            </dl>
            {detail.item.creditsInvoiceNumber && <p className="text-sm text-ink-muted">Credits invoice {detail.item.creditsInvoiceNumber}.</p>}
            {detail.item.notes && <p className="text-sm text-ink-muted">Note from the sender: {detail.item.notes}</p>}
            {detail.blockers.length > 0 && (
              <ul role="alert" className="space-y-1 p-3 rounded-lg bg-amber-500/10 text-amber-800 dark:text-amber-300 text-sm" data-testid="inbox-blockers">
                {detail.blockers.map((b) => <li key={b} className="flex gap-2"><AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" aria-hidden />{b}</li>)}
              </ul>
            )}
            <table className="w-full text-sm">
              <thead><tr className="text-xs text-ink-muted text-left border-b border-line">
                <th className="py-2 pr-3 font-medium">Line</th><th className="py-2 pr-3 text-right font-medium">Amount</th>
                <th className="py-2 pr-3 text-right font-medium">VAT</th><th className="py-2 font-medium">{isNote ? 'Account credited' : 'Expense account'}</th>
              </tr></thead>
              <tbody className="divide-y divide-line">
                {detail.lines.map((l) => (
                  <tr key={l.index} className="align-top">
                    <td className="py-2 pr-3">{l.description}<span className="block text-xs text-ink-muted">{l.quantity} x {formatCurrency(l.unitPrice)}</span></td>
                    <td className="py-2 pr-3 text-right tabular-nums">{formatCurrency(l.lineTotal)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{formatCurrency(l.taxAmount)}</td>
                    <td className="py-2">
                      <select aria-label={`Account for line ${l.index + 1}`} className="ff-input w-full text-sm" disabled={!canWrite}
                        value={chosen[l.index] ?? ''} onChange={(e) => setChosen((c) => ({ ...c, [l.index]: e.target.value }))}>
                        <option value="">Choose an account</option>
                        {detail.accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                      </select>
                      {l.accountSource && chosen[l.index] === l.accountId && <span className="block text-xs text-ink-muted mt-0.5">{SOURCE_NOTE[l.accountSource]}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-xs text-ink-muted">Accepting creates a draft. Nothing is approved or posted until you approve it in the usual way.</p>
            {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          </div>
        )}
      </Modal.Body>
      <Modal.Footer>
        <button type="button" onClick={onClose} disabled={busy} className="px-3 py-2 text-sm rounded-lg border border-line text-ink hover:bg-surface-sunken disabled:opacity-50">Close</button>
        {canWrite && item && (
          <>
            <button type="button" disabled={busy} onClick={() => onReject(item)} className="px-3 py-2 text-sm rounded-lg border border-line text-red-600 dark:text-red-400 hover:bg-red-500/10 disabled:opacity-50">Reject…</button>
            <button type="button" disabled={busy || blocked} onClick={() => void accept()}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 inline-flex items-center gap-2">
              {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}Accept as draft
            </button>
          </>
        )}
      </Modal.Footer>
    </Modal>
  );
}
