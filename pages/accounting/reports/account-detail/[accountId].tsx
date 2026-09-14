/**
 * Account Detail (Ledger Drill-Down) Page
 * /accounting/reports/account-detail/[accountId]
 *
 * [accountId] in the URL may be either a UUID or an account code (e.g. "1110").
 * The API resolves whichever is provided.
 *
 * Query params:
 *   from        — ISO date YYYY-MM-DD (required)
 *   to          — ISO date YYYY-MM-DD (required)
 *   posted_only — "false" to include drafts (default: true)
 *   cost_centre_id / business_unit_id — optional dimension filters
 *   source      — "tb" | "bs" | "is" (controls the back-link label)
 *   page        — page number (default: 1)
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { ArrowLeft, Loader2, AlertCircle, Download } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { UUID_RE } from '@/lib/validation';
import { downloadAccountLedgerCsv } from '@/lib/csv/accountLedgerCsv';
import { AccountLedgerSummary } from '@/components/reports/AccountLedgerSummary';
import { AccountLedgerTable } from '@/components/reports/AccountLedgerTable';
import type { AccountLedgerResult } from '@/modules/accounting/services/reports/accountLedgerService';

import { accountReportBackHref } from '@/components/reports/reportReturnState';

const PAGE_SIZE = 200;

function fmtDate(d: string): string {
  if (!d) return '—';
  const iso = d.length === 10 ? `${d}T00:00:00` : d;
  const date = new Date(iso);
  if (isNaN(date.getTime())) return d;
  return date.toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function AccountDetailPage() {
  const router = useRouter();
  const { accountId } = router.query;
  const from = typeof router.query.from === 'string' ? router.query.from : '';
  const to = typeof router.query.to === 'string' ? router.query.to : '';
  const costCentreId = typeof router.query.cost_centre_id === 'string' ? router.query.cost_centre_id : '';
  const businessUnitId = typeof router.query.business_unit_id === 'string' ? router.query.business_unit_id : '';
  const postedOnly = router.query.posted_only !== 'false';
  const sourceParam = typeof router.query.source === 'string' ? router.query.source : '';
  const pageParam =
    typeof router.query.page === 'string' ? parseInt(router.query.page, 10) : 1;
  const page = isNaN(pageParam) || pageParam < 1 ? 1 : pageParam;
  const offset = (page - 1) * PAGE_SIZE;

  const [data, setData] = useState<AccountLedgerResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    if (!accountId || typeof accountId !== 'string' || !from || !to) {
      requestRef.current += 1;
      return;
    }
    const requestId = ++requestRef.current;
    setData(null);
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({
        from,
        to,
        posted_only: postedOnly ? 'true' : 'false',
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      if (costCentreId) params.set('cost_centre_id', costCentreId);
      if (businessUnitId) params.set('business_unit_id', businessUnitId);
      if (UUID_RE.test(accountId)) {
        params.set('account_id', accountId);
      } else {
        params.set('account_code', accountId);
      }

      // Endpoint is now under /api/accounting/reports- prefix for auto-rate-limiting.
      const res = await apiFetch(
        `/api/accounting/reports-account-ledger?${params}`,
        { credentials: 'include' },
      );
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(json.message ?? 'Failed to load ledger');
      }
      const json = (await res.json()) as { data?: AccountLedgerResult };
      if (requestId === requestRef.current) setData(json.data ?? null);
    } catch (err) {
      if (requestId === requestRef.current)
        setError(err instanceof Error ? err.message : 'Failed to load ledger');
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [accountId, from, to, postedOnly, offset, costCentreId, businessUnitId]);

  useEffect(() => { void load(); }, [load]);

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 1;

  const backHref = accountReportBackHref(router.query);
  const backLabel = sourceParam === 'bs' ? 'Back to Balance Sheet'
    : sourceParam === 'is' ? 'Back to Income Statement' : 'Back to Trial Balance';

  function goPage(p: number) {
    void router.push({ pathname: router.pathname, query: { ...router.query, page: String(p) } });
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Link
            href={backHref}
            className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] mb-2"
          >
            <ArrowLeft className="h-4 w-4" />
            {backLabel}
          </Link>

          <div className="flex items-center justify-between">
            <div>
              {data?.meta ? (
                <>
                  <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">
                    <span className="font-mono text-[var(--ff-text-tertiary)] mr-2 text-lg">
                      {data.meta.accountCode}
                    </span>
                    {data.meta.accountName}
                  </h1>
                  <p className="text-sm text-[var(--ff-text-secondary)] mt-0.5">
                    {fmtDate(from)} — {fmtDate(to)}
                    <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-tertiary)] uppercase tracking-wide">
                      {data.meta.accountType}
                    </span>
                  </p>
                </>
              ) : (
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Account Detail</h1>
              )}
            </div>

            {data && (
              <button
                onClick={() =>
                  downloadAccountLedgerCsv(
                    data.meta,
                    data.rows,
                    data.openingBalance,
                    data.periodClosingBalance,
                  )
                }
                className="inline-flex items-center gap-2 px-4 py-2 border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 text-sm font-medium"
              >
                <Download className="h-4 w-4" />
                Export this view
              </button>
            )}
          </div>
        </div>

        <div className="p-6">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-indigo-500" />
            </div>
          ) : error ? (
            <div className="flex items-center gap-2 text-red-400 py-8 justify-center">
              <AlertCircle className="h-5 w-5" />
              <span>{error}</span>
            </div>
          ) : data ? (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
              <AccountLedgerSummary
                openingBalance={data.openingBalance}
                periodNet={data.periodNet}
                periodClosingBalance={data.periodClosingBalance}
                total={data.total}
              />
              <AccountLedgerTable
                rows={data.rows}
                openingBalance={data.openingBalance}
                periodClosingBalance={data.periodClosingBalance}
                page={page}
                totalPages={totalPages}
                onPageChange={goPage}
              />
            </div>
          ) : null}
        </div>
      </div>
    </AppLayout>
  );
}
