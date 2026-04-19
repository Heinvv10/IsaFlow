/**
 * Loan Detail Page
 * Route: /accounting/loans/[id]
 * Tabs: Overview | Schedule | Events | Rate Curve
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { Landmark, ArrowLeft, Loader2, RefreshCw } from 'lucide-react';
import { Loan, ScheduleRow, LoanEvent, RateCurve, RatePoint, PRODUCT_LABELS } from '@/components/loans/types';
import { LoanStatusBadge } from '@/components/loans/LoanStatusBadge';
import { LoanOverviewTab } from '@/components/loans/LoanOverviewTab';
import { LoanScheduleTab } from '@/components/loans/LoanScheduleTab';
import { LoanEventsTab } from '@/components/loans/LoanEventsTab';
import { LoanRateCurveTab } from '@/components/loans/LoanRateCurveTab';
import { LoanComplianceTab } from '@/components/loans/LoanComplianceTab';

type TabId = 'overview' | 'schedule' | 'events' | 'curve' | 'compliance';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'events', label: 'Events' },
  { id: 'curve', label: 'Rate Curve' },
  { id: 'compliance', label: 'Compliance' },
];

export default function LoanDetailPage() {
  const router = useRouter();
  const { id } = router.query as { id: string };

  const [tab, setTab] = useState<TabId>('overview');
  const [loan, setLoan] = useState<Loan | null>(null);
  const [scheduleRows, setScheduleRows] = useState<ScheduleRow[]>([]);
  const [events, setEvents] = useState<LoanEvent[]>([]);
  const [curve, setCurve] = useState<RateCurve | null>(null);
  const [curvePoints, setCurvePoints] = useState<RatePoint[]>([]);

  const [loadingLoan, setLoadingLoan] = useState(true);
  const [loadingSchedule, setLoadingSchedule] = useState(false);
  const [loadingCurve, setLoadingCurve] = useState(false);
  const [error, setError] = useState('');

  const loadLoan = useCallback(async () => {
    if (!id) return;
    setLoadingLoan(true);
    setError('');
    const res = await apiFetch(`/api/accounting/loans/${id}`);
    const json = await res.json();
    if (!res.ok) { setError(json.message || 'Failed to load loan'); setLoadingLoan(false); return; }
    setLoan(json.data);
    setLoadingLoan(false);
  }, [id]);

  const loadSchedule = useCallback(async () => {
    if (!id) return;
    setLoadingSchedule(true);
    const res = await apiFetch(`/api/accounting/loans/${id}/schedule`);
    const json = await res.json();
    setScheduleRows(json.data?.rows ?? []);
    setLoadingSchedule(false);
  }, [id]);

  const loadEvents = useCallback(async () => {
    if (!id) return;
    const res = await apiFetch(`/api/accounting/loans/${id}/events`);
    const json = await res.json();
    setEvents(json.data ?? []);
  }, [id]);

  const loadCurve = useCallback(async (curveId: string) => {
    setLoadingCurve(true);
    const [curveRes, pointsRes] = await Promise.all([
      apiFetch(`/api/accounting/loan-rate-curves`),
      apiFetch(`/api/accounting/loan-rate-curves/${curveId}/points`),
    ]);
    const [curvesJson, pointsJson] = await Promise.all([curveRes.json(), pointsRes.json()]);
    const found = (curvesJson.data ?? []).find((c: RateCurve) => c.id === curveId) ?? null;
    setCurve(found);
    setCurvePoints(pointsJson.data ?? []);
    setLoadingCurve(false);
  }, []);

  useEffect(() => { loadLoan(); }, [loadLoan]);

  useEffect(() => {
    if (!loan) return;
    if (tab === 'schedule' && scheduleRows.length === 0) loadSchedule();
    if (tab === 'events') loadEvents();
    if (tab === 'curve') {
      if (loan.curveId) loadCurve(loan.curveId);
      else { setCurve(null); setCurvePoints([]); }
    }
  }, [tab, loan, scheduleRows.length, loadSchedule, loadEvents, loadCurve]);

  if (loadingLoan) {
    return (
      <AppLayout>
        <div className="min-h-screen bg-[var(--ff-bg-primary)] flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
        </div>
      </AppLayout>
    );
  }

  if (error || !loan) {
    return (
      <AppLayout>
        <div className="min-h-screen bg-[var(--ff-bg-primary)] flex items-center justify-center">
          <div className="text-center space-y-3">
            <p className="text-red-400">{error || 'Loan not found'}</p>
            <Link href="/accounting/loans" className="text-teal-400 hover:underline text-sm">Back to Portfolio</Link>
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <Link href="/accounting/loans" className="p-1.5 rounded-lg hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-secondary)]">
                <ArrowLeft className="h-5 w-5" />
              </Link>
              <div className="p-2 rounded-lg bg-teal-500/10">
                <Landmark className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">
                    {loan.reference || `Loan ${loan.id.slice(0, 8)}`}
                  </h1>
                  <LoanStatusBadge status={loan.status} />
                </div>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  {PRODUCT_LABELS[loan.product ?? ''] || loan.product || 'Loan'}
                  {loan.description ? ` — ${loan.description}` : ''}
                </p>
              </div>
            </div>
            <button
              onClick={loadLoan}
              className="p-1.5 rounded-lg hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-secondary)]"
              title="Refresh"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>

          <div className="flex gap-1 mt-4">
            {TABS.map(t => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`px-4 py-2 rounded-t text-sm font-medium transition-colors ${
                  tab === t.id
                    ? 'bg-teal-600 text-white'
                    : 'text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-primary)]'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="p-6">
          {tab === 'overview' && (
            <LoanOverviewTab loan={loan} onRefresh={loadLoan} />
          )}
          {tab === 'schedule' && (
            <LoanScheduleTab
              loanId={id}
              rows={scheduleRows}
              loading={loadingSchedule}
            />
          )}
          {tab === 'events' && (
            <LoanEventsTab
              loanId={id}
              events={events}
              onRefresh={loadEvents}
            />
          )}
          {tab === 'curve' && (
            <LoanRateCurveTab
              curve={curve}
              points={curvePoints}
              loading={loadingCurve}
            />
          )}
          {tab === 'compliance' && (
            <LoanComplianceTab loanId={id} />
          )}
        </div>
      </div>
    </AppLayout>
  );
}
