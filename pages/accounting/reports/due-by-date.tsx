/**
 * Due by date: what falls due by a chosen date, per supplier (AP) and per
 * customer (AR), at today's open balances, with the net cash position.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { ArrowLeft, CalendarClock, Loader2, AlertCircle, Download } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { FixDateNotice, GatedDateField, useDateGate } from '@/components/forms/GatedDateField';
import { DueByDateTable } from '@/components/accounting/dueByDate/DueByDateTable';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { todayInSast } from '@/lib/saDateParser';
import { formatMoney } from '@/lib/money/formatMoney';
import { endOfMonth, type DueByDateContactDetail, type DueByDateInvoice, type DueByDateReport, type DueSide } from '@/modules/accounting/utils/dueByDate';

const TABS: { id: DueSide; label: string; contact: string }[] = [
  { id: 'ap', label: 'Payables (AP)', contact: 'Supplier' },
  { id: 'ar', label: 'Receivables (AR)', contact: 'Customer' },
];

export default function DueByDatePage() {
  const [byDate, setByDate] = useState(() => endOfMonth(todayInSast()));
  const dates = useDateGate();
  const [tab, setTab] = useState<DueSide>('ap');
  const [data, setData] = useState<DueByDateReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Each load takes a number; only the latest may write. A slower answer for an earlier date
  // must not replace the report for the date now on screen.
  const latest = useRef(0);

  const load = useCallback(async () => {
    if (!byDate) return;
    const mine = ++latest.current;
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/api/accounting/reports/due-by-date?${new URLSearchParams({ by_date: byDate })}`, { credentials: 'include' });
      await assertOk(res, 'Could not load the due-by-date report - try again');
      const json = await res.json() as { data?: DueByDateReport };
      if (mine !== latest.current) return;
      setData(json.data ?? null);
    } catch (err) {
      if (mine !== latest.current) return;
      setData(null);
      setError(apiErrorMessage(err, 'Could not load the due-by-date report - try again'));
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  }, [byDate]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => { latest.current += 1; }, []);

  const loadInvoices = useCallback(async (contactId: string): Promise<DueByDateInvoice[]> => {
    const params = new URLSearchParams({ by_date: data?.byDate ?? byDate, side: tab, entity_id: contactId });
    const res = await apiFetch(`/api/accounting/reports/due-by-date?${params}`, { credentials: 'include' });
    await assertOk(res, 'Could not load the invoices - try again');
    const json = await res.json() as { data?: { contact?: DueByDateContactDetail } };
    return json.data?.contact?.invoices ?? [];
  }, [data?.byDate, byDate, tab]);

  function handleExport() {
    if (byDate) window.open(`/api/accounting/reports/due-by-date-xlsx?${new URLSearchParams({ by_date: byDate })}`, '_blank');
  }

  const side = data ? data[tab] : null;
  const net = data?.netPosition ?? 0;

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Link href="/accounting/reports" className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] mb-2">
            <ArrowLeft className="h-4 w-4" /> Back to Reports
          </Link>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-500/10"><CalendarClock className="h-6 w-6 text-blue-600 dark:text-blue-400" /></div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Due by date</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">What falls due by a date, at today&apos;s open balances</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <GatedDateField gate={dates} gateKey="byDate" label="Due by date" value={byDate || null} onValue={setByDate} />
              <button
                onClick={handleExport}
                disabled={!data || dates.blocked}
                className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium disabled:opacity-50 mt-4"
              >
                <Download className="h-4 w-4" /> Export Excel
              </button>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-7xl space-y-6">
          <FixDateNotice gate={dates} />
          {error && (
            <div role="alert" className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-700 dark:text-red-400 text-sm">
              <AlertCircle className="h-4 w-4" /> {error}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-blue-600 dark:text-blue-400" /></div>
          ) : data && side && (
            <>
              <div data-testid="net-position" className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 rounded-lg bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)]">
                <span className="text-sm font-semibold text-[var(--ff-text-secondary)]">
                  Net position by {byDate}: receivables {formatMoney(data.ar.totals.totalByDate)} less payables {formatMoney(data.ap.totals.totalByDate)}
                </span>
                <span className={`text-lg font-bold tabular-nums ${net < 0 ? 'text-red-700 dark:text-red-400' : 'text-[var(--ff-text-primary)]'}`}>{formatMoney(net)}</span>
              </div>
              <p
                data-testid="net-excludes"
                className={`-mt-3 px-1 text-xs ${data.ap.totals.noDueDate + data.ar.totals.noDueDate > 0 ? 'text-amber-700 dark:text-amber-400' : 'text-[var(--ff-text-tertiary)]'}`}
              >
                Excludes {formatMoney(data.ap.totals.noDueDate)} payables and {formatMoney(data.ar.totals.noDueDate)} receivables with no due date.
              </p>

              <div role="tablist" className="flex gap-2 border-b border-[var(--ff-border-light)]">
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    role="tab"
                    aria-selected={tab === t.id}
                    onClick={() => setTab(t.id)}
                    className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${tab === t.id ? 'border-blue-600 text-[var(--ff-text-primary)]' : 'border-transparent text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]'}`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              <DueByDateTable key={`${tab}:${data.byDate}:${data.today}`} side={side} contactLabel={TABS.find((t) => t.id === tab)!.contact} loadInvoices={loadInvoices} />
              <p className="text-xs text-[var(--ff-text-tertiary)]">
                Open documents as at {data.today}. Total by date = overdue now + due today to date. Money in &quot;No due date&quot; is
                owed but cannot be placed in time. Open customer disputes are held out of the columns, as in the age analysis.
              </p>
            </>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
