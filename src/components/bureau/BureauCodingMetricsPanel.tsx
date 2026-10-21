/**
 * BureauCodingMetricsPanel — learning-loop numbers per client on the bureau dashboard, plus the bureau
 * total for owners and accountants (the API sends `total: null` to a viewer). Reads
 * GET /api/bureau/coding-metrics for one bureau. The total pools every client's lines and decisions.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import type { CodingMetrics } from '@/modules/accounting/services/bank/codingMetrics';
import { fmtDay, fmtPct, rateCell } from '@/components/accounting/bank-transactions/codingMetricsLabels';

interface ClientRow { companyId: string; companyName: string; metrics: CodingMetrics }
interface BureauCodingMetrics { clients: ClientRow[]; total: CodingMetrics | null; minDecisions: number }

function Cells({ m }: { m: CodingMetrics }) {
  return (
    <>
      <td className="py-2 px-3 text-right">{m.autoCoded.denominator === 0 ? '—' : `${fmtPct(m.autoCoded)} of ${m.autoCoded.denominator}`}</td>
      <td className="py-2 px-3 text-right">{rateCell(m.suggestionsAccepted)}</td>
      <td className="py-2 px-3 text-right">{rateCell(m.firstThirtyDays)}</td>
      <td className="py-2 px-3 text-right">{rateCell(m.autoPostRecodeRate)}</td>
    </>
  );
}

export function BureauCodingMetricsPanel({ bureauId, bureauName }: { bureauId: string; bureauName?: string }) {
  const [data, setData] = useState<BureauCodingMetrics | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setData(null); setError('');
    apiFetch(`/api/bureau/coding-metrics?bureauId=${encodeURIComponent(bureauId)}`, { credentials: 'include' })
      .then(async (r) => { await assertOk(r, 'Could not load the coding numbers - try again'); return r.json(); })
      .then((j: { data?: BureauCodingMetrics }) => { if (live) setData(j?.data ?? null); })
      .catch((err) => { if (live) setError(apiErrorMessage(err, 'Could not load the coding numbers - try again')); });
    return () => { live = false; };
  }, [bureauId]);

  if (error) return <p role="alert" className="text-xs text-red-400">{error}</p>;
  if (!data || data.clients.length === 0) return null;
  const since = data.total?.decisionLogSince ?? null;

  return (
    <section aria-label="ISAFlow coding by client" className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--ff-border-primary)]">
        <h2 className="text-sm font-medium text-[var(--ff-text-primary)]">ISAFlow coding this month{bureauName ? ` · ${bureauName}` : ''}</h2>
        <p className="text-xs text-[var(--ff-text-tertiary)] mt-0.5">
          Auto-coded counts lines ISAFlow posted with no clicks. Suggestion rates need {data.minDecisions} decisions
          {since ? ` and are logged since ${fmtDay(since)}` : ''}.
        </p>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] text-left text-[var(--ff-text-secondary)]">
            <th className="py-2 px-3 font-medium">Client</th>
            <th className="py-2 px-3 font-medium text-right">Auto-coded (no clicks)</th>
            <th className="py-2 px-3 font-medium text-right">Suggestions accepted</th>
            <th className="py-2 px-3 font-medium text-right">First 30 days accepted</th>
            <th className="py-2 px-3 font-medium text-right">Auto-posts re-coded</th>
          </tr>
        </thead>
        <tbody className="text-[var(--ff-text-primary)]">
          {data.clients.map((c) => (
            <tr key={c.companyId} className="border-b border-[var(--ff-border-primary)]">
              <td className="py-2 px-3">
                <Link href={`/bureau/clients/${c.companyId}`} className="hover:text-teal-400">{c.companyName}</Link>
              </td>
              <Cells m={c.metrics} />
            </tr>
          ))}
          {data.total && (
            <tr className="bg-[var(--ff-bg-secondary)] font-medium">
              <td className="py-2 px-3">All clients</td>
              <Cells m={data.total} />
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
