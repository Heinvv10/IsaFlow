/**
 * CodingMetricsStrip — the company's learning-loop numbers above the bank transactions table:
 * how many lines ISAFlow coded with no clicks this month, and how often its suggestions were accepted.
 * Reads GET /api/accounting/coding-metrics (active company). Renders nothing until loaded.
 */
import { useEffect, useState } from 'react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import type { CodingMetrics } from '@/modules/accounting/services/bank/codingMetrics';
import { acceptedLabel, autoCodedLabel } from './codingMetricsLabels';

interface CodingMetricsResponse {
  data?: { metrics: CodingMetrics; minDecisions: number };
}

export function CodingMetricsStrip() {
  const [data, setData] = useState<{ metrics: CodingMetrics; minDecisions: number } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    apiFetch('/api/accounting/coding-metrics', { credentials: 'include' })
      .then(async (r) => { await assertOk(r, 'Could not load the coding numbers - try again'); return r.json(); })
      // An envelope without metrics renders nothing rather than taking the page down with it.
      .then((j: CodingMetricsResponse) => { if (live) setData(j?.data?.metrics ? j.data : null); })
      .catch((err) => { if (live) setError(apiErrorMessage(err, 'Could not load the coding numbers - try again')); });
    return () => { live = false; };
  }, []);

  if (error) return <p role="alert" className="mb-2 text-xs text-red-400">{error}</p>;
  if (!data) return null;
  const { metrics, minDecisions } = data;
  return (
    <div aria-label="ISAFlow coding" className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-[var(--ff-text-secondary)]">
      <span>{autoCodedLabel(metrics.autoCoded)}</span>
      <span>{acceptedLabel(metrics.suggestionsAccepted, metrics.decisionLogSince, minDecisions)}</span>
    </div>
  );
}
