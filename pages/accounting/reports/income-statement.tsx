/**
 * Income Statement (P&L) Report Page
 * PRD-060 Phase 5: Revenue, Cost of Sales, Operating Expenses
 */

import { useState, useEffect } from 'react';
import { DateField } from '@/components/ui/DateField';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { ListSkeleton } from '@/components/ui/ListSkeleton';
import { PageHeader } from '@/components/ui/PageHeader';
import { BarChart3, AlertCircle, Download, FileSpreadsheet } from 'lucide-react';
import { IncomeStatementSections } from '@/components/accounting/IncomeStatementSections';
import { formatDisplayDate } from '@/utils/dateFormat';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { EvidenceDrillModal } from '@/components/accounting/evidence/EvidenceDrillModal';
import { ComparatorControls } from '@/components/accounting/reportControls/ComparatorControls';
import { PresentLink } from '@/components/accounting/reportControls/PresentLink';
import { useStatementComparatorState } from '@/components/accounting/reportControls/useStatementComparatorState';
import { ComparatorNotices } from '@/components/accounting/reportControls/ComparatorNotices';
import { reportHref } from '@/components/reports/reportReturnState';
import { localISODate } from '@/lib/dateUtils';
import { useIncomeStatementReport } from '@/components/accounting/reportControls/useIncomeStatementReport';
import { deepLinkDates } from '@/components/accounting/reportControls/deepLinkDates';

interface CostCentre { id: string; code: string; name: string }
interface BusinessUnit { id: string; code: string; name: string }

function clampToToday(dateStr: string): string {
  const today = localISODate();
  return dateStr > today ? today : dateStr;
}

function getDefaultDates(): { periodStart: string; periodEnd: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return {
    periodStart: localISODate(start),
    periodEnd: localISODate(now),
  };
}

export default function IncomeStatementPage() {
  const router = useRouter();
  const { qStart, qEnd } = deepLinkDates(router.query);
  const qBusinessUnit = typeof router.query.business_unit_id === 'string' ? router.query.business_unit_id : '';
  const defaults = getDefaultDates();
  const [periodStart, setPeriodStart] = useState(qStart || defaults.periodStart);
  const [periodEnd, setPeriodEnd] = useState(qEnd || defaults.periodEnd);
  const [periodResolved, setPeriodResolved] = useState(!!(qStart && qEnd));
  // A refused From/To keeps the last good date in state; no report is run or exported over it. Nor is one for
  // an empty date, or a From that is after To (typed into From, where DateField has no bound to refuse it).
  const [badDate, setBadDate] = useState({ from: false, to: false });
  const rangeInverted = Boolean(periodStart && periodEnd && periodStart > periodEnd);
  const datesOk = !badDate.from && !badDate.to && Boolean(periodStart && periodEnd) && !rangeInverted;
  // A refused text keeps DateField's own reason (an external error would hide it).
  const fromError = badDate.from ? undefined : !periodStart ? 'Enter a From date.' : rangeInverted ? 'From must be on or before To.' : undefined;
  const toError = badDate.to || periodEnd ? undefined : 'Enter a To date.';

  const [businessUnitId, setBusinessUnitId] = useState(qBusinessUnit);

  // Sync-back effect: when router.query.period_start / period_end populate after
  // mount (Next.js can hydrate router.query on a later tick, or client-side
  // router.push can set them after the open-period fetch has already resolved),
  // push the URL values into state so the report re-fetches correctly.
  useEffect(() => {
    if (router.isReady === false) return;
    if (qStart) setPeriodStart(qStart);
    if (qEnd) setPeriodEnd(qEnd);
    setBusinessUnitId(qBusinessUnit);
  }, [router.isReady, qStart, qEnd, qBusinessUnit]);

  // Fetch the current open period on mount to set smart default dates.
  // The open-period values are only written when no deep-link params are present
  // (checked both at call-time and when the promise resolves).
  useEffect(() => {
    if (router.isReady === false) return;

    if (qStart && qEnd) {
      // Deep-link params present at mount — use them and skip the period fetch.
      setPeriodStart(qStart);
      setPeriodEnd(qEnd);
      setPeriodResolved(true);
      return;
    }

    let cancelled = false;
    apiFetch('/api/accounting/fiscal-periods?open_period=true', { credentials: 'include' })
      .then(async r => { await assertOk(r, 'Could not load the open period - try again'); return r.json(); })
      .then(json => {
        if (cancelled) return;
        if (!qStart && !qEnd) {
          const period = json.data as { startDate?: string; endDate?: string } | null;
          // Only a period that has begun (From <= To after capping to today); else keep the month-to-date default.
          const end = period?.endDate ? clampToToday(period.endDate) : '';
          if (period?.startDate && end >= period.startDate) { setPeriodStart(period.startDate); setPeriodEnd(end); }
        }
        setPeriodResolved(true);
      })
      .catch(() => {
        if (!cancelled) setPeriodResolved(true);
      });
    return () => { cancelled = true; };
  }, [router.isReady, qStart, qEnd]);
  const [expandedAccount, setExpandedAccount] = useState<string | null>(null);
  const [costCentres, setCostCentres] = useState<CostCentre[]>([]);
  const [costCentreId, setCostCentreId] = useState('');
  const [businessUnits, setBusinessUnits] = useState<BusinessUnit[]>([]);
  const [refError, setRefError] = useState<Record<string, string>>({});
  const [evidenceTarget, setEvidenceTarget] = useState<{ accountId: string; accountName: string } | null>(null);
  // The Prior-period checkbox IS the comparative fetch: one control, so the
  // column cannot be on with no comparative period behind it.
  const { columns, setColumns, companyWideUnavailable, apply, budgetState, trendFailed } =
    useStatementComparatorState({
      dimensionSelected: costCentreId !== '' || businessUnitId !== '',
      asOf: periodEnd, basis: 'movement', periodStart, periodEnd,
    });
  const showComparative = columns.prior;
  const { report, vw, shown, live, isLoading, error } = useIncomeStatementReport({
    ready: router.isReady !== false, periodStart, periodEnd, periodResolved, datesOk,
    costCentreId, businessUnitId, showComparative,
  });
  const returnTo = reportHref('is', { period_start: vw.start, period_end: vw.end,
    cost_centre_id: vw.cc, business_unit_id: vw.bu });

  useEffect(() => {
    apiFetch('/api/accounting/cost-centres?active_only=true', { credentials: 'include' })
      .then(async r => { await assertOk(r, 'Could not load the cost centres - try again'); return r.json(); })
      .then(json => setCostCentres(json.data?.items || json.data || []))
      .catch(err => { setCostCentres([]); log.warn('Failed to load cost centres', { err }, 'income-statement'); setRefError(p => ({ ...p, cc: apiErrorMessage(err, 'Could not load the cost centres - try again') })); });
    apiFetch('/api/accounting/business-units?active=true', { credentials: 'include' })
      .then(async r => { await assertOk(r, 'Could not load the business units - try again'); return r.json(); })
      .then(json => { const items = json.data?.items || json.data || []; setBusinessUnits(Array.isArray(items) ? items : []); })
      .catch(err => { setBusinessUnits([]); log.warn('Failed to load business units', { err }, 'income-statement'); setRefError(p => ({ ...p, bu: apiErrorMessage(err, 'Could not load the business units - try again') })); });
  }, []);

  function handleExport() {
    const params = new URLSearchParams({ period_start: periodStart, period_end: periodEnd });
    if (costCentreId) params.set('cost_centre_id', costCentreId);
    if (businessUnitId) params.set('business_unit_id', businessUnitId);
    window.open(`/api/accounting/income-statement-export?${params}`, '_blank');
  }

  function handleXlsxExport() {
    const params = new URLSearchParams({ period_start: periodStart, period_end: periodEnd });
    if (costCentreId) params.set('cost_centre_id', costCentreId);
    if (businessUnitId) params.set('business_unit_id', businessUnitId);
    window.open(`/api/accounting/income-statement-xlsx?${params}`, '_blank');
  }

  function toggleAccount(code: string) {
    setExpandedAccount(prev => (prev === code ? null : code));
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <PageHeader
          icon={BarChart3}
          title="Income Statement"
          breadcrumb={[{ label: 'Reports', href: '/accounting?tab=reports' }, { label: 'Income Statement' }]}
          chipColor="bg-teal-500/10 text-teal-700 dark:text-teal-400"
          className="mb-0"
          actions={
            <>
              <PresentLink from={report && datesOk ? vw.start : ''} to={report && datesOk ? vw.end : ''} />
              <button onClick={handleXlsxExport} disabled={!report || !datesOk}
                className="inline-flex items-center gap-2 px-4 py-2 bg-success-700 text-white rounded-lg hover:bg-success-800 text-sm font-medium disabled:opacity-50">
                <FileSpreadsheet className="h-4 w-4" /> Export Excel
              </button>
              <button onClick={handleExport} disabled={!report || !datesOk}
                className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 text-sm font-medium disabled:opacity-50">
                <Download className="h-4 w-4" /> Export CSV
              </button>
            </>
          }
        />

        {/* Full width: with prior, budget and trend all showing there are eleven columns, and the
            grid scrolls inside its own frame with the header row and the label column pinned. */}
        <div className="p-6 space-y-6">
          {/* Date Range + Filters */}
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <DateField label="From" value={periodStart || null} name="periodStart" error={fromError} onChange={(iso, v) => { setBadDate(b => ({ ...b, from: !v.valid })); if (v.valid) setPeriodStart(iso ?? ''); }} />
            </div>
            <div>
              <DateField label="To" value={periodEnd || null} name="periodEnd" anchorDate={periodStart || null} error={toError} minDate={periodStart || undefined} onChange={(iso, v) => { setBadDate(b => ({ ...b, to: !v.valid })); if (v.valid) setPeriodEnd(iso ?? ''); }} />
            </div>
            <div>
              <label htmlFor="income-statement-cost-centre-id" className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Cost Centre</label>
              <select id="income-statement-cost-centre-id" name="costCentreId" value={costCentreId} onChange={e => setCostCentreId(e.target.value)}
                className="ff-input text-sm min-w-[160px]">
                <option value="">All Cost Centres</option>
                {costCentres.map(cc => (
                  <option key={cc.id} value={cc.id}>{cc.code} — {cc.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="income-statement-business-unit" className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Business Unit</label>
              <select id="income-statement-business-unit" value={businessUnitId} onChange={e => setBusinessUnitId(e.target.value)} className="ff-input text-sm min-w-[160px]">
                <option value="">All Business Units</option>
                {businessUnitId && !businessUnits.some(bu => bu.id === businessUnitId) && <option value={businessUnitId}>Selected Business Unit (unavailable)</option>}
                {businessUnits.map(bu => <option key={bu.id} value={bu.id}>{bu.code} — {bu.name}</option>)}
              </select>
            </div>
            <div className="pb-2">
              <ComparatorControls value={columns} onChange={setColumns}
                companyWideUnavailable={companyWideUnavailable} />
            </div>
          </div>

          <ComparatorNotices budgetState={budgetState} trendFailed={trendFailed}
            companyWideUnavailable={companyWideUnavailable} />

          {Object.keys(refError).length > 0 && <p role="alert" className="text-xs text-amber-500">{Object.values(refError).join(' ')}</p>}
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
              <AlertCircle className="h-4 w-4" /> {error}
            </div>
          )}

          {isLoading ? (
            <ListSkeleton rows={14} label="Loading profit and loss" />
          ) : report ? (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)]">
              <div className="px-6 py-4 border-b border-[var(--ff-border-light)]">
                <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">
                  Profit &amp; Loss — {formatDisplayDate(vw.start)} to {formatDisplayDate(vw.end)}
                </h2>
              </div>
              <p className="sm:hidden mb-1 text-xs text-[var(--ff-text-tertiary)]">Swipe the statement sideways for the prior period and variance columns.</p>
              <IncomeStatementSections
                costCentreId={vw.cc}
                businessUnitId={vw.bu}
                returnTo={returnTo}
                report={report}
                periodStart={vw.start}
                periodEnd={vw.end}
                expandedAccount={expandedAccount}
                onToggleAccount={toggleAccount}
                showComparative={vw.cmp}
                columns={columns}
                applyComparators={apply}
                onEvidence={(id, name) => setEvidenceTarget({ accountId: id, accountName: name })}
              />
            </div>
          ) : null}
          {/* Always mounted so a screen reader hears the change. Empty and inverted ranges already say so on the field. */}
          <p role="status" className="text-sm text-[var(--ff-text-secondary)]">
            {!report && !datesOk && (badDate.from || badDate.to) ? 'Fix the date to run the report.' : ''}
          </p>
        </div>
      </div>
      {evidenceTarget && (
        <EvidenceDrillModal
          costCentreId={(shown ?? live).cc}
          businessUnitId={(shown ?? live).bu}
          accountId={evidenceTarget.accountId}
          accountName={evidenceTarget.accountName}
          periodStart={(shown ?? live).start}
          periodEnd={(shown ?? live).end}
          onClose={() => setEvidenceTarget(null)}
        />
      )}
    </AppLayout>
  );
}
