/**
 * Presentation mode. Full screen, keyboard paged, no app chrome — the same
 * React components the report surfaces use, on a boardroom screen.
 *
 * No AppLayout on purpose: the sidebar, the header and the tenant switcher
 * are the "app chrome" this route exists to remove.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { Loader2 } from 'lucide-react';
import { apiJson } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { PresentDeck } from '@/components/accounting/present/PresentDeck';
import { buildSlides, type ReportPack, type Slide } from '@/components/accounting/present/presentSlides';
import { PresentSlide } from '@/components/accounting/present/PresentSlide';
import type { BudgetVsActualLine } from '@/modules/accounting/services/reports/budgetVsActualLines';
import type { AccountTrends } from '@/modules/accounting/services/reports/trendRowsService';
import type { IncomeStatementReport } from '@/modules/accounting/types/gl.types';

const PACK_TYPES = new Set(['board', 'management', 'monthly']);

export default function PresentPackPage() {
  const router = useRouter();
  const packType = typeof router.query['pack'] === 'string' ? router.query['pack'] : '';
  const from = typeof router.query['from'] === 'string' ? router.query['from'] : '';
  const to = typeof router.query['to'] === 'string' ? router.query['to'] : '';

  const [slides, setSlides] = useState<Slide[] | null>(null);
  const [trends, setTrends] = useState<AccountTrends | null>(null);
  const [trendsFailed, setTrendsFailed] = useState(false);
  const [budget, setBudget] = useState<BudgetVsActualLine[]>([]);
  const [budgetedCount, setBudgetedCount] = useState(0);
  const [budgetFailed, setBudgetFailed] = useState(false);
  const [income, setIncome] = useState<IncomeStatementReport | null>(null);
  // One flag per fetch, not one for the batch. The deck renders as soon as
  // the PACK resolves, which is before any of these three have landed — so
  // without them the income slide says "could not be loaded" and the trends
  // slide says "no renderer yet" about requests that are still in flight.
  const [incomeLoading, setIncomeLoading] = useState(false);
  const [trendsLoading, setTrendsLoading] = useState(false);
  const [budgetLoading, setBudgetLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!router.isReady) return;
    if (!PACK_TYPES.has(packType) || !from || !to) {
      setError(`Unknown pack: "${packType || '(none)'}". Expected one of board, management, monthly with a from/to range.`);
      return;
    }
    // The params are valid for THIS run of the effect. Clear a stale error
    // (and the slides it may have been shown alongside) from a previous,
    // invalid pack — a client-side navigation from an unknown pack to a
    // known one must not keep the old "Unknown pack" banner on screen.
    setError('');
    setSlides(null);
    let live = true;
    setTrendsFailed(false);
    setBudgetFailed(false);
    // Set BEFORE the pack fetch, not after it: `setSlides` and these flags
    // land in the same render, so a deck can never appear with all three
    // reading "not loading, no data".
    setIncomeLoading(true);
    setTrendsLoading(true);
    setBudgetLoading(true);

    const load = async () => {
      try {
        const packData = await apiJson(
          `/api/accounting/reports-pack?type=${packType}&from=${from}&to=${to}`,
        );
        if (!live) return;
        setSlides(buildSlides(packData.pack as ReportPack));

        // Trend, budget and income-statement figures back the income
        // statement slide's comparator columns. A failure here degrades that
        // one slide — PresentSlide renders it without the missing column —
        // it must not blank the whole deck the pack fetch just built.
        const [trendsResult, budgetResult, incomeResult] = await Promise.allSettled([
          apiJson(`/api/accounting/reports-account-trends?as_of=${to}&basis=movement`),
          apiJson(`/api/accounting/reports-budget-comparator?period_start=${from}&period_end=${to}`),
          apiJson(`/api/accounting/reports-income-statement?period_start=${from}&period_end=${to}`),
        ]);
        if (!live) return;

        if (trendsResult.status === 'fulfilled') {
          setTrends(trendsResult.value);
        } else {
          setTrendsFailed(true);
          log.error('Account trends failed to load', { error: trendsResult.reason }, 'present');
        }
        setTrendsLoading(false);
        if (budgetResult.status === 'fulfilled') {
          setBudget(budgetResult.value.lines);
          setBudgetedCount(budgetResult.value.budgetedCount);
        } else {
          setBudgetFailed(true);
          log.error('Budget comparator failed to load', { error: budgetResult.reason }, 'present');
        }
        setBudgetLoading(false);
        if (incomeResult.status === 'fulfilled') {
          setIncome(incomeResult.value);
        } else {
          log.error('Income statement failed to load', { error: incomeResult.reason }, 'present');
        }
        setIncomeLoading(false);
      } catch (err) {
        if (live) setError(err instanceof Error ? err.message : String(err));
        log.error('Presentation pack failed to load', { error: err }, 'present');
        // The pack fetch threw, so the three comparator fetches were never
        // started. Leaving them "loading" would spin those slides forever
        // behind an error banner nobody can page past.
        if (live) {
          setTrendsLoading(false);
          setBudgetLoading(false);
          setIncomeLoading(false);
        }
      }
    };

    void load();
    return () => { live = false; };
  }, [router.isReady, packType, from, to]);

  const renderSlide = useCallback(
    (slide: Slide) => (
      <PresentSlide
        slide={slide} income={income} incomeLoading={incomeLoading}
        trends={trends} trendsFailed={trendsFailed} trendsLoading={trendsLoading}
        budget={budget} budgetedCount={budgetedCount}
        budgetFailed={budgetFailed} budgetLoading={budgetLoading}
      />
    ),
    [
      income, incomeLoading, trends, trendsFailed, trendsLoading,
      budget, budgetedCount, budgetFailed, budgetLoading,
    ],
  );

  const exit = useCallback(() => {
    void router.push('/accounting/reports/report-packs');
  }, [router]);

  if (error) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[var(--ff-bg-primary)]">
        {/* `text-red-400`, the app's error colour — never `--ff-unfav`, which
            means "this variance moved the wrong way". Borrowing the variance
            token for a load failure makes one colour say two things. */}
        <p role="alert" className="text-sm text-red-400">This pack could not be loaded: {error}</p>
      </main>
    );
  }
  if (!slides) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[var(--ff-bg-primary)]">
        <Loader2 className="h-8 w-8 animate-spin text-[var(--ff-text-tertiary)]" />
      </main>
    );
  }
  return <PresentDeck slides={slides} renderSlide={renderSlide} onExit={exit} />;
}
