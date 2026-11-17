/**
 * Cash Flow Forecast (Reports > Financial). One page, two tabs (Hein, 2026-11-16):
 *   - "13 weeks" (default): the 13-week cash forecast from the books (cash13; Cash13Tab).
 *   - "AI outlook" (`?tab=ai`): the AI weekly forecast, unchanged (AiOutlookTab). With no AI key configured it
 *     says so instead of failing; `aiConfigured` is read on the server by the same test the AI service makes.
 * A tab is mounted when first opened and then only hidden, so its state (a generated AI forecast) survives.
 * The monthly heuristic forecast stays at /accounting/cash-flow-forecast (its own page; not linked from the menu).
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { TrendingUp } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Tabs } from '@/components/ui';
import { Cash13Tab } from '@/components/accounting/cashForecast13/Cash13Tab';
import { AiOutlookTab } from '@/components/accounting/AiCashFlowOutlook';
import { aiForecastConfigured } from '@/modules/accounting/services/reports/aiForecastKey';

const TABS = [
  { id: 'weeks', label: '13 weeks' },
  { id: 'ai', label: 'AI outlook' },
];

export default function CashFlowForecastPage({ aiConfigured = false }: { aiConfigured?: boolean }) {
  const router = useRouter();
  const tab = router.query.tab === 'ai' ? 'ai' : 'weeks';
  // A tab stays mounted (hidden) once opened: switching away must not drop a generated AI forecast and bill a
  // second one, nor reload the 13 weeks.
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set([tab]));
  useEffect(() => { setOpened((o) => (o.has(tab) ? o : new Set([...o, tab]))); }, [tab]);
  const onChange = (id: string) => {
    const query = id === 'ai' ? { tab: 'ai' } : {};
    void router.replace({ pathname: router.pathname, query }, undefined, { shallow: true });
  };
  return (
    <AppLayout>
      <div className="p-4 lg:p-6 space-y-6">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-teal-500/10 border border-teal-500/20">
            <TrendingUp className="h-6 w-6 text-teal-400" />
          </div>
          <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Cash Flow Forecast</h1>
        </div>
        <Tabs tabs={TABS} activeTab={tab} onChange={onChange} aria-label="Forecast views" />
        {(tab === 'weeks' || opened.has('weeks')) && <div hidden={tab !== 'weeks'}><Cash13Tab /></div>}
        {(tab === 'ai' || opened.has('ai')) && <div hidden={tab !== 'ai'}><AiOutlookTab aiConfigured={aiConfigured} /></div>}
      </div>
    </AppLayout>
  );
}

/** Whether the AI tab can run: read on the server, where the key lives. */
export async function getServerSideProps() {
  return { props: { aiConfigured: aiForecastConfigured() } };
}
