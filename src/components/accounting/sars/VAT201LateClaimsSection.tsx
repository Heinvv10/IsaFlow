/**
 * The VAT201's late-claims section (wave 6 LC, read-only): every s16(3) late input-VAT claim in the period, and any
 * reversal of one, with its original document, the filed period it was dated in, the claim date and the VAT. Each
 * row links to its journal. The total is the late part of the input-tax fields; the server refuses a total that is not.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { formatMoney } from '@/lib/money/formatMoney';
import { formatDate } from '@/utils/formatters';
import type { Vat201LateClaimRow, Vat201LateClaims } from '@/modules/accounting/services/reports/vat201LateClaims';

const day = (s: string): string => s.slice(0, 10);
const link = 'inline-flex min-h-[24px] items-center text-teal-700 underline dark:text-teal-400';

export async function fetchVat201LateClaims(from: string, to: string, signal?: AbortSignal): Promise<Vat201LateClaims> {
  const qs = new URLSearchParams({ from: day(from), to: day(to) });
  const res = await apiFetch(`/api/accounting/sars/vat201-late-claims?${qs}`, { credentials: 'include', signal });
  await assertOk(res, 'The late claims could not be loaded.');
  return (await res.json() as { data: Vat201LateClaims }).data;
}

function Original({ r }: { r: Vat201LateClaimRow }) {
  if (!r.original) return <span className="text-[var(--ff-text-secondary)]">Not found</span>;
  return (
    <div>
      {r.document && <div>{r.document.invoiceNumber}{r.document.supplierName ? ` (${r.document.supplierName})` : ''}</div>}
      <div className="whitespace-nowrap">
        <Link href={`/accounting/journal-entries/${r.original.journalEntryId}`} className={link}>{r.original.entryNumber}</Link>
        <span className="ml-1 text-[var(--ff-text-secondary)]">{formatDate(r.original.entryDate)}</span>
      </div>
    </div>
  );
}

const period = (p: { start: string; end: string }): string => `${formatDate(p.start)} to ${formatDate(p.end)}`;

/** On a reversal: which claim it reverses, when that was claimed, and the return it was filed in (or not yet). */
function Reverses({ r }: { r: NonNullable<Vat201LateClaimRow['reverses']> }) {
  return (
    <div className="text-[var(--ff-text-secondary)]" data-testid="vat201-late-claims-reverses">
      of <Link href={`/accounting/journal-entries/${r.journalEntryId}`} className={link}>{r.entryNumber}</Link>
      {` claimed ${formatDate(r.claimDate)}, `}
      {r.filedIn ? `filed in ${period(r.filedIn)}` : 'not yet filed'}
    </div>
  );
}

function Rows({ data }: { data: Vat201LateClaims }) {
  return (
    <div>
      <p className="mb-1 text-xs text-[var(--ff-text-secondary)] sm:hidden">Scroll sideways for every column.</p>
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Late input VAT claims in this period">
        <table className="w-full min-w-[720px] text-xs" data-testid="vat201-late-claims-rows">
          <thead>
            <tr className="text-left text-[var(--ff-text-secondary)]">
              <th scope="col" className="py-1 pr-2 font-medium">Claim journal</th>
              <th scope="col" className="py-1 pr-2 font-medium">Claim date</th>
              <th scope="col" className="py-1 pr-2 font-medium">Original document</th>
              <th scope="col" className="py-1 pr-2 font-medium">Document's filed period</th>
              <th scope="col" className="py-1 pr-2 font-medium">Field</th>
              <th scope="col" className="py-1 text-right font-medium">VAT</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.journalEntryId} className="border-t border-[var(--ff-border-light)] text-[var(--ff-text-primary)]">
                <td className="whitespace-nowrap py-1 pr-2">
                  <Link href={`/accounting/journal-entries/${r.journalEntryId}`} className={link}>{r.entryNumber}</Link>
                  {r.kind === 'reversal' && <span className="ml-1 text-[var(--ff-text-secondary)]">(reversal)</span>}
                  {r.reverses && <Reverses r={r.reverses} />}
                </td>
                <td className="whitespace-nowrap py-1 pr-2">{formatDate(r.claimDate)}</td>
                <td className="min-w-[14rem] py-1 pr-2"><Original r={r} /></td>
                <td className="whitespace-nowrap py-1 pr-2">
                  {r.filedPeriod ? period(r.filedPeriod) : 'Not found'}
                </td>
                <td className="whitespace-nowrap py-1 pr-2">{r.boxes.join(', ')}</td>
                <td className="whitespace-nowrap py-1 text-right tabular-nums">{formatMoney(r.vat)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-[var(--ff-border-light)] font-semibold text-[var(--ff-text-primary)]">
              <td colSpan={5} className="py-1 pr-2">Total claimed late</td>
              <td className="whitespace-nowrap py-1 text-right tabular-nums" data-testid="vat201-late-claims-total">{formatMoney(data.total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

export function VAT201LateClaimsSection({ from, to }: { from: string; to: string }) {
  const [data, setData] = useState<Vat201LateClaims | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const ctl = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    setLoading(true); setError(''); setData(null);
    try {
      const d = await fetchVat201LateClaims(from, to, c.signal);
      if (!c.signal.aborted) setData(d);
    } catch (err) {
      if (!c.signal.aborted) setError(apiErrorMessage(err, 'The late claims could not be loaded.'));
    } finally {
      if (!c.signal.aborted) setLoading(false);
    }
  }, [from, to]);

  useEffect(() => { void load(); return () => ctl.current?.abort(); }, [load]);

  return (
    <section aria-labelledby="vat201-late-claims-title" data-testid="vat201-late-claims"
      className="rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] p-4 space-y-2">
      <h2 id="vat201-late-claims-title" className="text-sm font-semibold text-[var(--ff-text-primary)]">Late input VAT claims</h2>
      <p className="text-xs text-[var(--ff-text-secondary)]">
        Input VAT on documents dated in a VAT period already filed, claimed in this one (VAT Act s16(3)). It is
        included in the input-tax fields above.
      </p>
      {loading && <p className="text-xs text-[var(--ff-text-secondary)]" role="status">Loading late claims…</p>}
      {error && (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>
          <Button variant="secondary" size="sm" onClick={() => void load()}>Retry</Button>
        </div>
      )}
      {data && data.rows.length === 0 && (
        <p className="text-xs text-[var(--ff-text-secondary)]" data-testid="vat201-late-claims-empty">No late claims in this period.</p>
      )}
      {data && data.rows.length > 0 && <Rows data={data} />}
    </section>
  );
}
