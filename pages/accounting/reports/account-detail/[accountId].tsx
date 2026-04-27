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
 *   source      — "tb" | "bs" (controls the back-link label)
 *   page        — page number (default: 1)
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  ArrowLeft,
  Loader2,
  AlertCircle,
  Download,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import type {
  AccountLedgerRow,
  AccountLedgerMeta,
  AccountLedgerResult,
} from '@/modules/accounting/services/reports/accountLedgerService';

const PAGE_SIZE = 200;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

function fmtDate(d: string): string {
  if (!d) return '—';
  const iso = d.length === 10 ? `${d}T00:00:00` : d;
  const date = new Date(iso);
  if (isNaN(date.getTime())) return d;
  return date.toLocaleDateString('en-ZA', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function downloadCsv(
  meta: AccountLedgerMeta,
  rows: AccountLedgerRow[],
  openingBalance: number,
): void {
  const headers = [
    'Date', 'Entry #', 'Description', 'Reference', 'Source',
    'Debit', 'Credit', 'Balance',
  ];
  const lines: string[] = [headers.join(',')];
  lines.push(`,,Opening Balance,,,,,${openingBalance.toFixed(2)}`);

  for (const r of rows) {
    const cols = [
      r.entryDate,
      r.entryNumber,
      `"${r.description.replace(/"/g, '""')}"`,
      `"${r.reference.replace(/"/g, '""')}"`,
      r.source,
      r.debit > 0 ? r.debit.toFixed(2) : '',
      r.credit > 0 ? r.credit.toFixed(2) : '',
      r.runningBalance.toFixed(2),
    ];
    lines.push(cols.join(','));
  }

  const closingBalance =
    rows.length > 0
      ? (rows[rows.length - 1]?.runningBalance ?? openingBalance)
      : openingBalance;
  lines.push(`,,Closing Balance,,,,,${closingBalance.toFixed(2)}`);

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ledger-${meta.accountCode}-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function AccountDetailPage() {
  const router = useRouter();
  const { accountId } = router.query;
  const from = typeof router.query.from === 'string' ? router.query.from : '';
  const to = typeof router.query.to === 'string' ? router.query.to : '';
  const postedOnly = router.query.posted_only !== 'false';
  const sourceParam =
    typeof router.query.source === 'string' ? router.query.source : '';
  const pageParam =
    typeof router.query.page === 'string'
      ? parseInt(router.query.page, 10)
      : 1;
  const page = isNaN(pageParam) || pageParam < 1 ? 1 : pageParam;
  const offset = (page - 1) * PAGE_SIZE;

  const [data, setData] = useState<AccountLedgerResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!accountId || typeof accountId !== 'string' || !from || !to) return;
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
      // Route to the correct identifier param
      if (UUID_RE.test(accountId)) {
        params.set('account_id', accountId);
      } else {
        params.set('account_code', accountId);
      }

      const res = await apiFetch(
        `/api/accounting/reports/account-ledger?${params}`,
        { credentials: 'include' },
      );
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(json.message ?? 'Failed to load ledger');
      }
      const json = (await res.json()) as { data?: AccountLedgerResult };
      setData(json.data ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load ledger');
    } finally {
      setLoading(false);
    }
  }, [accountId, from, to, postedOnly, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 1;
  const closingBalance =
    data && data.rows.length > 0
      ? (data.rows[data.rows.length - 1]?.runningBalance ?? data.openingBalance)
      : (data?.openingBalance ?? 0);

  const backHref =
    sourceParam === 'bs'
      ? `/accounting/reports/balance-sheet${to ? `?as_at_date=${to}` : ''}`
      : '/accounting/trial-balance';
  const backLabel =
    sourceParam === 'bs' ? 'Back to Balance Sheet' : 'Back to Trial Balance';

  function goPage(p: number) {
    void router.push({
      pathname: router.pathname,
      query: { ...router.query, page: String(p) },
    });
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
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">
                  Account Detail
                </h1>
              )}
            </div>

            {data && (
              <button
                onClick={() =>
                  downloadCsv(data.meta, data.rows, data.openingBalance)
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
              {/* Summary strip */}
              <div className="grid grid-cols-3 divide-x divide-[var(--ff-border-light)] border-b border-[var(--ff-border-light)]">
                <div className="px-6 py-3">
                  <p className="text-xs text-[var(--ff-text-tertiary)]">Opening Balance</p>
                  <p className="font-mono font-medium text-[var(--ff-text-primary)]">
                    {fmt(data.openingBalance)}
                  </p>
                </div>
                <div className="px-6 py-3">
                  <p className="text-xs text-[var(--ff-text-tertiary)]">
                    Transactions ({data.total.toLocaleString()})
                  </p>
                  <p className="font-mono font-medium text-[var(--ff-text-primary)]">
                    {fmt(data.rows.reduce((s, r) => s + r.debit - r.credit, 0))}
                    <span className="text-xs text-[var(--ff-text-tertiary)] ml-1">net</span>
                  </p>
                </div>
                <div className="px-6 py-3">
                  <p className="text-xs text-[var(--ff-text-tertiary)]">Closing Balance</p>
                  <p className="font-mono font-medium text-[var(--ff-text-primary)]">
                    {fmt(closingBalance)}
                  </p>
                </div>
              </div>

              {/* Ledger table */}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)] text-xs uppercase tracking-wide">
                      <th className="px-4 py-2 w-28">Date</th>
                      <th className="px-4 py-2 w-28">Entry #</th>
                      <th className="px-4 py-2">Description</th>
                      <th className="px-4 py-2 w-32">Reference</th>
                      <th className="px-4 py-2 w-20">Source</th>
                      <th className="px-4 py-2 text-right w-28">Debit</th>
                      <th className="px-4 py-2 text-right w-28">Credit</th>
                      <th className="px-4 py-2 text-right w-32">Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* Opening balance row */}
                    <tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]/40">
                      <td
                        colSpan={7}
                        className="px-4 py-2 text-xs text-[var(--ff-text-tertiary)] font-medium"
                      >
                        Opening Balance
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-[var(--ff-text-secondary)]">
                        {fmt(data.openingBalance)}
                      </td>
                    </tr>

                    {data.rows.length === 0 ? (
                      <tr>
                        <td
                          colSpan={8}
                          className="px-4 py-8 text-center text-[var(--ff-text-tertiary)] text-sm"
                        >
                          No transactions in this period
                        </td>
                      </tr>
                    ) : (
                      data.rows.map((r, i) => (
                        <tr
                          key={`${r.journalEntryId}-${i}`}
                          className="border-b border-[var(--ff-border-light)]/50 hover:bg-[var(--ff-bg-primary)]/50"
                        >
                          <td className="px-4 py-2 text-[var(--ff-text-tertiary)]">
                            {fmtDate(r.entryDate)}
                          </td>
                          <td className="px-4 py-2 font-mono text-[var(--ff-text-secondary)]">
                            {r.entryNumber}
                          </td>
                          <td className="px-4 py-2 text-[var(--ff-text-secondary)] max-w-xs truncate">
                            {r.description}
                          </td>
                          <td className="px-4 py-2 text-[var(--ff-text-tertiary)] text-xs">
                            {r.reference || '—'}
                          </td>
                          <td className="px-4 py-2 text-[var(--ff-text-tertiary)] text-xs">
                            {r.source}
                          </td>
                          <td className="px-4 py-2 text-right font-mono text-[var(--ff-text-primary)]">
                            {r.debit > 0 ? fmt(r.debit) : ''}
                          </td>
                          <td className="px-4 py-2 text-right font-mono text-[var(--ff-text-primary)]">
                            {r.credit > 0 ? fmt(r.credit) : ''}
                          </td>
                          <td className="px-4 py-2 text-right font-mono text-[var(--ff-text-secondary)]">
                            {fmt(r.runningBalance)}
                          </td>
                        </tr>
                      ))
                    )}

                    {/* Closing balance row */}
                    <tr className="border-t border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]/40 font-medium">
                      <td
                        colSpan={7}
                        className="px-4 py-2 text-xs text-[var(--ff-text-tertiary)]"
                      >
                        Closing Balance
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-[var(--ff-text-primary)]">
                        {fmt(closingBalance)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between px-6 py-3 border-t border-[var(--ff-border-light)]">
                  <span className="text-xs text-[var(--ff-text-tertiary)]">
                    Page {page} of {totalPages} (
                    {data.total.toLocaleString()} transactions)
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => goPage(page - 1)}
                      disabled={page <= 1}
                      className="p-1.5 rounded border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)] disabled:opacity-40"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => goPage(page + 1)}
                      disabled={page >= totalPages}
                      className="p-1.5 rounded border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)] disabled:opacity-40"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </AppLayout>
  );
}
