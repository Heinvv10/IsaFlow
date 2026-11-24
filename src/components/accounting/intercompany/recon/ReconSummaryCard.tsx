/**
 * The loan reconciliation's summary card (P5): "as at <T>, read at <readAt>", both loan balances (or "Withheld: <sentence>"), the difference,
 * the components with their counts and the badge: "Reconciles: every difference is explained" ONLY when the summary says so (never "the
 * balances agree": the difference may be messages in flight / rejected / undone, plan (m).19), "Unexplained R x", "Does not reconcile: n rows
 * need attention", or "Does not reconcile: postings no message explains" (U = 0 from residuals that cancel). "Reconciles" with hand postings
 * on the loan accounts (they cancel: mirrored openings) carries a note naming yours and the partner's (a disclosed figure, partner_other).
 * The four parts of Unexplained are listed whenever ANY of them is not 0. With the partner withheld there is no difference, no component,
 * no badge and no note. A loan account of yours that also serves another connection never reconciles ((m).18) and the card says why.
 * Read only.
 */
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { formatCurrency, formatDate, formatRandAbs } from '@/utils/formatters';
import type { ReconSummary } from '@/modules/accounting/services/intercompany/loanReconTypes';
import { BUCKET_LABELS, PART_LABELS, formatReadAt } from './reconLabels';

interface Props { summary: ReconSummary; asOf: string; readAt: string; partnerName: string }

const PART_KEYS = Object.keys(PART_LABELS) as (keyof typeof PART_LABELS)[];
/** Some part of Unexplained is not 0 (they can cancel to U = 0 and still need a person). */
const anyPart = (s: ReconSummary): boolean => s.unexplained !== null && PART_KEYS.some((k) => s.unexplained![k] !== 0);
/** Reconciles, and hand postings on the two loan accounts make it up (they cancel, or the summary would not reconcile). */
const handPostings = (s: ReconSummary): boolean => s.reconciles === true && s.unexplained !== null
  && (s.unexplained.ownOther !== 0 || s.unexplained.partnerOther !== 0);

function Badge({ s }: { s: ReconSummary }) {
  if (s.reconciles) {
    return <span data-testid="badge" className="inline-flex items-center gap-1 rounded bg-green-100 px-2 py-1 text-sm font-medium text-green-800"><CheckCircle2 className="h-4 w-4" />Reconciles: every difference is explained</span>;
  }
  const u = s.unexplained?.total ?? 0;
  const text = u !== 0 ? `Unexplained ${formatRandAbs(u)}`
    : s.blockingRows ? `Does not reconcile: ${s.blockingRows} rows need attention`
      : anyPart(s) ? 'Does not reconcile: postings no message explains' : 'Does not reconcile';
  return <span data-testid="badge" className="inline-flex items-center gap-1 rounded bg-amber-100 px-2 py-1 text-sm font-medium text-amber-800"><AlertTriangle className="h-4 w-4" />{text}</span>;
}

export function ReconSummaryCard({ summary: s, asOf, readAt, partnerName }: Props) {
  return (
    <section data-testid="recon-summary" aria-label="Summary" className="space-y-4 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] p-4">
      <p className="text-sm text-ink-muted">As at {formatDate(asOf)}, read at {formatReadAt(readAt)}</p>
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-ink-muted">Your loan account</dt>
          <dd data-testid="own-balance" className="text-lg font-semibold">{s.own ? formatCurrency(s.own.balance) : 'No loan account set'}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">{partnerName}&apos;s loan account</dt>
          {s.partner
            ? <dd data-testid="partner-balance" className="text-lg font-semibold">{formatCurrency(s.partner.balance)}</dd>
            : <dd data-testid="partner-withheld" className="text-sm">Withheld: {s.withheld?.sentence ?? ''}</dd>}
        </div>
        {s.difference !== null && (
          <div>
            <dt className="text-xs text-ink-muted">Difference</dt>
            <dd data-testid="difference" className="text-lg font-semibold">{formatCurrency(s.difference)}</dd>
          </div>
        )}
      </dl>
      {s.reconciles !== null && <Badge s={s} />}
      {handPostings(s) && (
        <p data-testid="hand-postings-note" className="text-sm">
          Includes hand postings on the loan accounts: yours {formatCurrency(s.unexplained!.ownOther)}, partner&apos;s {formatCurrency(s.unexplained!.partnerOther)} (they cancel)
        </p>
      )}
      {anyPart(s) && (
        <ul data-testid="unexplained-parts" className="space-y-1 text-sm">
          {PART_KEYS.map((k) => (
            <li key={k} className="flex justify-between gap-4"><span>{PART_LABELS[k]}</span><span>{formatCurrency(s.unexplained![k])}</span></li>
          ))}
        </ul>
      )}
      {s.identityFailures > 0 && <p className="text-sm text-red-700">Unexplained ({s.identityFailures}): the report could not account for every message. Tell support.</p>}
      {s.loanAccountChanged && <p className="text-sm">A loan account was changed: figures cover the current account only.</p>}
      {s.own?.loanShared && <p className="text-sm">Your loan account also serves another connection: postings from it cannot be separated from this one.</p>}
      {s.components && s.components.length > 0 && (
        <table className="w-full text-sm">
          <caption className="sr-only">What the difference is made of</caption>
          <thead><tr><th scope="col" className="text-left">Component</th><th scope="col" className="text-right">Messages</th><th scope="col" className="text-right">Amount</th></tr></thead>
          <tbody>
            {s.components.map((c) => (
              <tr key={c.key}><td>{BUCKET_LABELS[c.key]}</td><td className="text-right">{c.count}</td><td className="text-right">{formatCurrency(c.amount)}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
