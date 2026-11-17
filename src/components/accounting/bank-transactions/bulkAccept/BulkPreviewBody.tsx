/** The preview half of the bulk-accept modal: rows, totals, by account, what was left out, held lines, next page. */
import { formatMoney } from '@/lib/money/formatMoney';
import type { BulkPreview } from './bulkAcceptApi';

const EXCLUDED_LABELS: Record<keyof BulkPreview['excluded'], string> = {
  badTarget: 'target account cannot take a posting', reconciliationHeld: 'held by a reconciliation', periodClosed: 'in a closed period',
  noPeriod: 'in a month with no period', vatLocked: 'in a locked VAT period', vatCode: 'VAT code refused',
};

export function excludedSummary(excluded: BulkPreview['excluded']): string {
  return (Object.keys(EXCLUDED_LABELS) as Array<keyof BulkPreview['excluded']>)
    .filter((k) => excluded[k] > 0).map((k) => `${excluded[k]} ${EXCLUDED_LABELS[k]}`).join(', ');
}

const KIND_LABEL = { importer: 'needs a colleague (you imported it)', approval: 'needs an approval' } as const;

export function BulkPreviewBody({ preview, onNextPage, busy }: { preview: BulkPreview; onNextPage: () => void; busy: boolean }) {
  const { lines } = preview;
  const left = excludedSummary(preview.excluded);
  return (
    <div>
      {lines.length === 0 ? (
        <p className="py-6 text-center text-sm text-[var(--ff-text-secondary)]">No high-confidence suggestions can be posted right now.</p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-sm" data-testid="bulk-totals">
            <span>Total in <b>{formatMoney(preview.totalIn)}</b></span>
            <span>Total out <b>{formatMoney(preview.totalOut)}</b></span>
          </div>
          <ul aria-label="By account" className="mb-3 space-y-0.5 text-xs text-[var(--ff-text-secondary)]">
            {preview.byAccount.map((a) => (
              <li key={a.glAccountId}>{[a.code, a.name].filter(Boolean).join(' ')}: {a.count} line{a.count === 1 ? '' : 's'}
                {a.totalIn > 0 && `, in ${formatMoney(a.totalIn)}`}{a.totalOut > 0 && `, out ${formatMoney(a.totalOut)}`}</li>
            ))}
          </ul>
          <div className="max-h-72 overflow-auto rounded border border-[var(--ff-border-light)]">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-[var(--ff-bg-secondary)] text-left text-[var(--ff-text-tertiary)]">
                <tr><th className="px-2 py-1">Date</th><th className="px-2 py-1">Description</th><th className="px-2 py-1 text-right">Amount</th><th className="px-2 py-1">Account</th><th className="px-2 py-1">VAT</th><th className="px-2 py-1 text-right">Confidence</th></tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id} className="border-t border-[var(--ff-border-light)]">
                    <td className="px-2 py-1 whitespace-nowrap">{l.date}</td>
                    <td className="px-2 py-1 max-w-[16rem] truncate" title={l.description ?? ''}>{l.description}</td>
                    <td className="px-2 py-1 text-right whitespace-nowrap">{formatMoney(l.amount)}</td>
                    <td className="px-2 py-1">{[l.glAccountCode, l.glAccountName].filter(Boolean).join(' ')}</td>
                    <td className="px-2 py-1">{l.effectiveVatCode}</td>
                    <td className="px-2 py-1 text-right">{Math.round(l.confidence * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <div className="mt-3 space-y-1 text-xs text-[var(--ff-text-secondary)]">
        {preview.truncated && <p>Showing the first {lines.length}. A confirm posts at most {lines.length}; preview again for the rest.</p>}
        {left && <p>Left out (a confirm would refuse them): {left}.</p>}
        {preview.needsAttentionCount > 0 && (
          <details>
            <summary>{preview.needsAttentionCount}{preview.scanTruncated ? '+' : ''} held for a colleague or an approval, not included</summary>
            <ul aria-label="Held lines" className="mt-1 space-y-0.5">
              {preview.needsAttention.map((h) => (
                <li key={h.id}>{h.id.slice(0, 8)}: {KIND_LABEL[h.kind]} - {h.reason}</li>
              ))}
            </ul>
            {preview.needsAttentionCount > preview.needsAttention.length && <p className="mt-1">Showing the first {preview.needsAttention.length}.</p>}
          </details>
        )}
        {preview.nextScanAfter && (
          <p>{preview.scanTruncated && lines.length === 0 ? 'The scan stopped early.' : 'More suggestions may follow.'}{' '}
            <button type="button" onClick={onNextPage} disabled={busy} className="underline">
              {lines.length === 0 ? 'Look further for more' : 'Show the next 25'}
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
