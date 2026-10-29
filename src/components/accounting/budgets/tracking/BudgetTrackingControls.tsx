/**
 * Budget vs Actual controls (budgets P3 spec §1, §2.2, §2.5): period (Month |
 * Quarter | YTD | FY | Custom, month-granular), the financial year, the
 * version of FY* (primary by default; disabled, with the reason, when the
 * report's window spans two years: `versionsByFy` on the response), and the
 * CC1 / CC2 / BU filter (explicit levels).
 * The query string they make is `trackingControls.trackingSearch`'s.
 */
import { monthLabel } from '@/components/accounting/budgets/budgetClient';
import type { BudgetVersion } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import { TRACKING_PERIODS, type TrackingPeriod } from '@/modules/accounting/services/budgets/tracking/trackingTypes';
import type { ReportYearOption } from '@/modules/accounting/services/reports/budgetReportYear';
import { crossYearReason, PERIOD_LABEL, quarterOptions, type TrackingControls } from './trackingControls';
import type { DimensionOption } from './useBudgetTracking';

const LABEL = 'block text-xs text-[var(--ff-text-tertiary)] mb-1';
const INPUT = 'ff-input text-sm';
// Long centre and version names must not wrap the bar at 1280: the box is capped, the name
// truncates inside it, and the full name is the box's title (browser review r1 L6).
const CAPPED = 'w-[11rem] max-w-full truncate';

export interface BudgetTrackingControlsProps {
  controls: TrackingControls;
  years: ReportYearOption[];
  /** FY* of the report on screen (the year select's value when none is chosen). */
  shownYear: number | null;
  today: string;
  versions: BudgetVersion[];
  versionsError: string;
  /** The years of a cross-year window (the response's `versionsByFy`); null for a one-year window. */
  crossYears: number[] | null;
  centres: DimensionOption[];
  units: DimensionOption[];
  update: (patch: Partial<TrackingControls>) => void;
  setPeriod: (p: TrackingPeriod) => void;
  setFiscalYear: (fy: number) => void;
  /** Why the controls cannot be sent (an inverted custom range), shown under them. */
  problem: string | null;
}

function DimensionSelect({ label, testId, value, options, onChange }: {
  label: string; testId: string; value: string; options: DimensionOption[]; onChange: (id: string) => void;
}) {
  const chosen = options.find((o) => o.id === value);
  return (
    <div>
      <label htmlFor={testId} className={LABEL}>{label}</label>
      <select id={testId} data-testid={testId} value={value} onChange={(e) => onChange(e.target.value)}
        title={chosen ? `${chosen.code} — ${chosen.name}` : undefined} className={`${INPUT} ${CAPPED}`}>
        <option value="">All</option>
        {value && !options.some((o) => o.id === value) && <option value={value}>Selected (unavailable)</option>}
        {options.map((o) => <option key={o.id} value={o.id}>{o.code} — {o.name}</option>)}
      </select>
    </div>
  );
}

export function BudgetTrackingControls(p: BudgetTrackingControlsProps) {
  const { controls: c, update } = p;
  const usesYear = c.period === 'quarter' || c.period === 'ytd' || c.period === 'fy';
  const yearValue = c.fiscalYear ?? p.shownYear;
  const year = p.years.find((y) => y.fiscalYear === yearValue);
  const primary = p.versions.find((v) => v.isPrimary);
  const crossYear = p.crossYears !== null;
  const versionReason = p.crossYears ? crossYearReason(p.crossYears) : p.versionsError || undefined;

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div>
        <label htmlFor="bva-period" className={LABEL}>Period</label>
        <select id="bva-period" data-testid="bva-period" value={c.period}
          onChange={(e) => p.setPeriod(e.target.value as TrackingPeriod)} className={INPUT}>
          {TRACKING_PERIODS.map((k) => <option key={k} value={k}>{PERIOD_LABEL[k]}</option>)}
        </select>
      </div>
      {c.period === 'month' && (
        <div>
          <label htmlFor="bva-month" className={LABEL}>Month</label>
          <input id="bva-month" data-testid="bva-month" type="month" value={c.month || p.today}
            onChange={(e) => { if (e.target.value) update({ month: e.target.value }); }} className={INPUT} />
        </div>
      )}
      {usesYear && yearValue !== null && (
        <div>
          <label htmlFor="report-year" className={LABEL}>Financial year</label>
          <select id="report-year" data-testid="report-year" value={yearValue}
            onChange={(e) => p.setFiscalYear(Number(e.target.value))} className={INPUT}>
            {!year && <option value={yearValue}>{yearValue}</option>}
            {p.years.map((y) => (
              <option key={y.fiscalYear} value={y.fiscalYear}>
                {`${y.fiscalYear}: ${monthLabel(y.startDate.slice(0, 7))} - ${monthLabel(y.endDate.slice(0, 7))}`}
              </option>
            ))}
          </select>
        </div>
      )}
      {c.period === 'quarter' && (
        <div>
          <label htmlFor="bva-quarter" className={LABEL}>Quarter</label>
          <select id="bva-quarter" data-testid="bva-quarter" value={c.quarter}
            onChange={(e) => update({ quarter: Number(e.target.value) })} className={INPUT}>
            {quarterOptions(year).map((q) => <option key={q.value} value={q.value}>{q.label}</option>)}
          </select>
        </div>
      )}
      {c.period === 'custom' && (
        <>
          <div>
            <label htmlFor="bva-from" className={LABEL}>From month</label>
            <input id="bva-from" data-testid="bva-from" type="month" value={c.from}
              onChange={(e) => { if (e.target.value) update({ from: e.target.value }); }} className={INPUT} />
          </div>
          <div>
            <label htmlFor="bva-to" className={LABEL}>To month</label>
            <input id="bva-to" data-testid="bva-to" type="month" value={c.to}
              onChange={(e) => { if (e.target.value) update({ to: e.target.value }); }} className={INPUT}
              aria-invalid={p.problem !== null} aria-describedby={p.problem ? 'bva-range-error' : undefined} />
          </div>
          {p.problem && (
            <p id="bva-range-error" data-testid="bva-range-error" role="alert" className="self-center text-xs text-red-600 dark:text-red-400">{p.problem}</p>
          )}
        </>
      )}
      <div>
        <label htmlFor="bva-version" className={LABEL}>Version</label>
        <select id="bva-version" data-testid="bva-version" value={c.versionId === primary?.id ? '' : c.versionId}
          disabled={crossYear} title={versionReason ?? p.versions.find((v) => v.id === c.versionId)?.name ?? primary?.name} aria-describedby={crossYear ? 'bva-version-reason' : undefined}
          onChange={(e) => update({ versionId: e.target.value })} className={`${INPUT} ${CAPPED} disabled:opacity-60`}>
          <option value="">{primary ? `Primary: ${primary.name}` : 'Primary version'}</option>
          {c.versionId && !p.versions.some((v) => v.id === c.versionId) && <option value={c.versionId}>Selected version</option>}
          {p.versions.filter((v) => !v.isPrimary).map((v) => (
            <option key={v.id} value={v.id}>{`${v.name} · ${v.status}`}</option>
          ))}
        </select>
        {crossYear && <p id="bva-version-reason" data-testid="bva-version-reason" className="mt-1 max-w-[260px] text-xs text-[var(--ff-text-secondary)]">{versionReason}</p>}
      </div>
      <DimensionSelect label="Cost centre 1" testId="bva-cc1" value={c.cc1Id}
        options={p.centres.filter((o) => o.ccType === 'cc1')} onChange={(id) => update({ cc1Id: id })} />
      <DimensionSelect label="Cost centre 2" testId="bva-cc2" value={c.cc2Id}
        options={p.centres.filter((o) => o.ccType === 'cc2')} onChange={(id) => update({ cc2Id: id })} />
      <DimensionSelect label="Business unit" testId="bva-bu" value={c.buId} options={p.units} onChange={(id) => update({ buId: id })} />
    </div>
  );
}
