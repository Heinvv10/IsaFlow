/**
 * Loan Period Close Page
 * Route: /accounting/loans/period-close
 *
 * Shows all active loans with interest accrual status for a selected period.
 * Allows posting GL journals (interest accrual + reclassification) per loan or in bulk.
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import {
  Landmark, CalendarCheck, ChevronLeft, CheckCircle2, AlertCircle, Loader2, Lock,
} from 'lucide-react';
import { fmt } from '@/components/loans/types';
import type { LoanPeriodStatus } from '@/modules/accounting/services/loans/loanPeriodCloseService';
import { PeriodCloseLoanRow } from '@/components/loans/PeriodCloseLoanRow';

interface PeriodCloseResponse {
  yyyymm: string;
  month: number;
  year: number;
  locked: boolean;
  loans: LoanPeriodStatus[];
}

interface PostResult {
  yyyymm: string;
  posted: Array<{ loanId: string; journalEntryId: string; narrative: string }>;
  errors: Array<{ loanId: string; error: string }>;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function currentPeriod() {
  const now = new Date();
  return { month: now.getMonth() + 1, year: now.getFullYear() };
}

function buildYearOptions(): number[] {
  const cur = new Date().getFullYear();
  return Array.from({ length: 5 }, (_, i) => cur - 2 + i);
}

export default function LoanPeriodClosePage() {
  const { month: defMonth, year: defYear } = currentPeriod();
  const [month, setMonth] = useState(defMonth);
  const [year, setYear] = useState(defYear);
  const [data, setData] = useState<PeriodCloseResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState<Set<string>>(new Set());
  const [postingAll, setPostingAll] = useState(false);
  const [flash, setFlash] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFlash(null);
    const res = await apiFetch(`/api/accounting/loans/period-close?month=${month}&year=${year}`);
    const json = (await res.json()) as { data: PeriodCloseResponse };
    setData(json.data ?? null);
    setLoading(false);
  }, [month, year]);

  useEffect(() => {
    load().catch((err) => {
      setLoading(false);
      setFlash({ type: 'error', msg: err instanceof Error ? err.message : 'Failed to load period data' });
    });
  }, [load]);

  async function postLoans(loanIds: string[]): Promise<PostResult> {
    const res = await apiFetch('/api/accounting/loans/period-close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loanIds, month, year }),
    });
    const json = (await res.json()) as { data: PostResult };
    return json.data;
  }

  async function handlePostSingle(loanId: string) {
    setPosting(prev => new Set(prev).add(loanId));
    try {
      const result = await postLoans([loanId]);
      if (result.errors.length > 0) {
        setFlash({ type: 'error', msg: result.errors[0]?.error ?? 'Posting failed' });
      } else {
        setFlash({ type: 'success', msg: 'Journal posted successfully' });
        await load();
      }
    } finally {
      setPosting(prev => { const s = new Set(prev); s.delete(loanId); return s; });
    }
  }

  async function handlePostAll() {
    const openLoans = (data?.loans ?? []).filter(l => l.periodStatus === 'open').map(l => l.loanId);
    if (openLoans.length === 0) return;
    setPostingAll(true);
    try {
      const result = await postLoans(openLoans);
      const ok = result.posted.length;
      const fail = result.errors.length;
      if (fail > 0 && ok === 0) {
        setFlash({ type: 'error', msg: `All ${fail} loan(s) failed. First: ${result.errors[0]?.error ?? ''}` });
      } else if (fail > 0) {
        setFlash({ type: 'error', msg: `Posted ${ok}, failed ${fail}: ${result.errors[0]?.error ?? ''}` });
      } else {
        setFlash({ type: 'success', msg: `Posted journals for ${ok} loan(s)` });
      }
      await load();
    } finally {
      setPostingAll(false);
    }
  }

  const loans = data?.loans ?? [];
  const openCount = loans.filter(l => l.periodStatus === 'open').length;
  const totalInterest = loans.reduce((s, l) => s + l.accruedInterest, 0);
  const totalPrincipal = loans.reduce((s, l) => s + l.principalBalance, 0);
  const years = buildYearOptions();

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <Link href="/accounting/loans" className="p-1.5 rounded hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-secondary)]">
                <ChevronLeft className="h-5 w-5" />
              </Link>
              <div className="p-2 rounded-lg bg-teal-500/10">
                <CalendarCheck className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Period Close</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  Post interest accrual journals for the selected month
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <select value={month} onChange={e => setMonth(Number(e.target.value))} className="ff-select text-sm">
                {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
              </select>
              <select value={year} onChange={e => setYear(Number(e.target.value))} className="ff-select text-sm">
                {years.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {flash && (
            <div className={`flex items-center gap-2 px-4 py-3 rounded-lg text-sm font-medium border ${
              flash.type === 'success'
                ? 'bg-teal-500/10 border-teal-500/30 text-teal-400'
                : 'bg-red-500/10 border-red-500/30 text-red-400'
            }`}>
              {flash.type === 'success'
                ? <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
                : <AlertCircle className="h-4 w-4 flex-shrink-0" />}
              {flash.msg}
            </div>
          )}

          {data?.locked && (
            <div className="flex items-center gap-2 px-4 py-3 rounded-lg text-sm font-medium bg-red-500/10 border border-red-500/30 text-red-400">
              <Lock className="h-4 w-4 flex-shrink-0" />
              Period {data.yyyymm} is locked — no further postings are allowed.
            </div>
          )}

          <div className="flex items-center justify-between flex-wrap gap-2">
            <p className="text-sm text-[var(--ff-text-secondary)]">
              {loading ? 'Loading…' : `${loans.length} active loans — ${openCount} unposted`}
            </p>
            {!data?.locked && (
              <button
                onClick={handlePostAll}
                disabled={postingAll || openCount === 0 || loading}
                className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {postingAll
                  ? <><Loader2 className="h-4 w-4 animate-spin" /> Posting…</>
                  : <><Landmark className="h-4 w-4" /> Post All Unposted ({openCount})</>}
              </button>
            )}
          </div>

          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)] text-xs uppercase tracking-wide">
                  <th className="px-4 py-3">Loan / Borrower</th>
                  <th className="px-4 py-3 text-right">Principal Balance</th>
                  <th className="px-4 py-3">Rate</th>
                  <th className="px-4 py-3">Next Payment</th>
                  <th className="px-4 py-3 text-right">Accrued Interest</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-[var(--ff-text-tertiary)]">
                      <Loader2 className="h-5 w-5 animate-spin inline mr-2" />
                      Loading period data…
                    </td>
                  </tr>
                )}
                {!loading && loans.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-[var(--ff-text-tertiary)]">
                      No active loans found.{' '}
                      <Link href="/accounting/loans/new" className="text-teal-400 hover:underline">
                        Create a loan
                      </Link>
                    </td>
                  </tr>
                )}
                {!loading && loans.map(loan => (
                  <PeriodCloseLoanRow
                    key={loan.loanId}
                    loan={loan}
                    isPosting={posting.has(loan.loanId)}
                    isLocked={data?.locked ?? false}
                    isBulkPosting={postingAll}
                    onPost={handlePostSingle}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {!loading && loans.length > 0 && (
            <div className="flex justify-end">
              <div className="text-sm text-[var(--ff-text-secondary)] space-y-1 text-right">
                <div>
                  Total accrued interest:{' '}
                  <span className="font-medium text-amber-400">{fmt(totalInterest)}</span>
                </div>
                <div>
                  Total principal balance:{' '}
                  <span className="font-medium text-[var(--ff-text-primary)]">{fmt(totalPrincipal)}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
