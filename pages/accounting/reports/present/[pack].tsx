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
  const [error, setError] = useState('');

  useEffect(() => {
    if (!router.isReady) return;
    if (!PACK_TYPES.has(packType) || !from || !to) {
      setError(`Unknown pack: "${packType || '(none)'}". Expected one of board, management, monthly with a from/to range.`);
      return;
    }
    let live = true;
    setTrendsFailed(false);
    setBudgetFailed(false);

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
        if (budgetResult.status === 'fulfilled') {
          setBudget(budgetResult.value.lines);
          setBudgetedCount(budgetResult.value.budgetedCount);
        } else {
          setBudgetFailed(true);
          log.error('Budget comparator failed to load', { error: budgetResult.reason }, 'present');
        }
        if (incomeResult.status === 'fulfilled') {
          setIncome(incomeResult.value);
        } else {
          log.error('Income statement failed to load', { error: incomeResult.reason }, 'present');
        }
      } catch (err) {
        if (live) setError(err instanceof Error ? err.message : String(err));
        log.error('Presentation pack failed to load', { error: err }, 'present');
      }
    };

    void load();
    return () => { live = false; };
  }, [router.isReady, packType, from, to]);

  const renderSlide = useCallback(
    (slide: Slide) => (
      <PresentSlide
        slide={slide} income={income}
        trends={trends} trendsFailed={trendsFailed}
        budget={budget} budgetedCount={budgetedCount} budgetFailed={budgetFailed}
      />
    ),
    [income, trends, trendsFailed, budget, budgetedCount, budgetFailed],
  );

  const exit = useCallback(() => {
    void router.push('/accounting/reports/report-packs');
  }, [router]);

  if (error) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[var(--ff-bg-primary)]">
        <p className="text-sm text-[var(--ff-unfav)]">This pack could not be loaded: {error}</p>
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
