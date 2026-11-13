/**
 * The three-way budget page body (budgets P6 spec §8): header (version switcher, opening and balance chips,
 * warnings), the runway chart, and four tabs: Balance sheet (opening, each month, FY close), Cash flow (direct
 * with operating / investing / financing, opening → closing cash, the indirect reconciliation beneath),
 * Assumptions (save re-runs the projection) and Compare. Money arrives in cents.
 */
import { useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { yearRangeLabel } from '@/components/accounting/budgets/budgetClient';
import { ThreeWayHeader } from './ThreeWayHeader';
import { RunwayChart } from './RunwayChart';
import { ThreeWayGrid } from './ThreeWayGrid';
import { AssumptionsPanel } from './AssumptionsPanel';
import { CompareTab } from './CompareTab';
import { balanceSheetModel, cashFlowModel, indirectModel } from './threeWayRows';
import { useThreeWay } from './useThreeWay';

type TabId = 'bs' | 'cf' | 'assumptions' | 'compare';
const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'bs', label: 'Balance sheet' }, { id: 'cf', label: 'Cash flow' }, { id: 'assumptions', label: 'Assumptions' }, { id: 'compare', label: 'Compare' },
];
const SELECT = 'min-w-0 max-w-full rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)] px-3 py-1.5 text-sm text-[var(--ff-text-primary)]';

export function ThreeWayPage() {
  const router = useRouter();
  const q = router.query.version_id;
  const data = useThreeWay(typeof q === 'string' ? q : null);
  const [tab, setTab] = useState<TabId>('bs');
  const { run } = data;
  const bs = useMemo(() => (run ? balanceSheetModel(run) : null), [run]);
  const cf = useMemo(() => (run ? cashFlowModel(run) : null), [run]);
  const ind = useMemo(() => (run ? indirectModel(run) : null), [run]);
  const locked = run?.version.status === 'locked';

  return (
    <div className="mx-auto w-full max-w-[100rem] min-w-0 space-y-4 p-4 sm:p-6" data-testid="three-way-page">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Three-way budget</h1>
        <Link href="/accounting/budgets" className="text-sm text-[var(--ff-text-secondary)] underline">Back to the budget</Link>
      </div>
      <p className="text-sm text-[var(--ff-text-secondary)]">
        The version&apos;s budgeted profit and loss, projected into a balance sheet and a cash flow for every month.
      </p>
      {data.years.length > 1 && data.fiscalYear !== null && (
        <select aria-label="Financial year" className={SELECT} value={data.fiscalYear} onChange={(e) => data.setFiscalYear(Number(e.target.value))}>
          {data.years.map((y) => <option key={y.fiscalYear} value={y.fiscalYear}>FY{y.fiscalYear} ({yearRangeLabel(y)})</option>)}
        </select>
      )}
      {data.error && <p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-error-700 dark:border-red-500/50 dark:bg-red-500/10 dark:text-error-400">{data.error}</p>}
      {!data.loading && !data.error && data.versions.length === 0 && (
        <p className="text-sm text-[var(--ff-text-secondary)]">This year has no budget version yet. Create one on the budget page first.</p>
      )}
      {data.loading && !run && <p className="text-sm text-[var(--ff-text-secondary)]">Projecting the balance sheet and cash flow…</p>}
      {run && data.versionId && (
        <>
          <ThreeWayHeader view={run} versions={data.versions} selectedId={data.versionId} onSelect={data.select} disabled={data.loading} />
          <RunwayChart view={run} />
          <div role="tablist" aria-label="Three-way views" className="flex flex-wrap gap-1 border-b border-[var(--ff-border-light)]">
            {TABS.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} data-testid={`three-way-tab-${t.id}`} onClick={() => setTab(t.id)}
                className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === t.id ? 'border-teal-600 font-medium text-[var(--ff-text-primary)]' : 'border-transparent text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]'}`}>
                {t.label}
              </button>
            ))}
          </div>
          <div role="tabpanel" className="min-w-0">
            {tab === 'bs' && bs && <ThreeWayGrid model={bs} title="Balance sheet (R)" testId="three-way-bs" />}
            {tab === 'cf' && cf && ind && (
              <div className="space-y-4">
                <ThreeWayGrid model={cf} title="Cash flow, direct (R)" testId="three-way-cf" />
                <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Reconciliation: net profit to operating cash (indirect)</h2>
                <ThreeWayGrid model={ind} title="Indirect (R)" testId="three-way-indirect" />
              </div>
            )}
            {tab === 'assumptions' && (
              <AssumptionsPanel versionId={data.versionId} locked={locked} firstMonth={run.months[0]} onSaved={data.reload} />
            )}
            {tab === 'compare' && <CompareTab versions={data.versions} currentId={data.versionId} />}
          </div>
        </>
      )}
    </div>
  );
}
