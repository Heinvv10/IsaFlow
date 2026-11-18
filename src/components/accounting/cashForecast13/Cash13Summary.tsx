/**
 * The 13-week tab's header and side panels: opening cash (today's bank balance), the lowest week's closing cash
 * and its week; the runway chart; the overdue customer invoices (total, by basis, past the horizon, disputed);
 * and the warnings in plain English (`cash13WarningText`, never a code).
 */
import { useCallback } from 'react';
import { formatStatementFigure } from '@/lib/format/money';
import { ChartFrame } from '@/components/accounting/charts/ChartFrame';
import type { ChartPalette } from '@/components/accounting/charts/chartTypes';
import type { CashForecast13, ForecastWarning, ForecastWeek, OverdueArSummary } from '@/modules/accounting/services/cashForecast13/types';
import { buildCash13RunwayOption, runwaySummary } from './cash13RunwayOption';
import { cash13WarningText } from './cash13WarningText';
import { lowestWeek, weekLabel } from './forecastRows';

const R = (cents: number) => formatStatementFigure(cents / 100, { symbol: true });
const PANEL = 'rounded-xl border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-4';

function Kpi({ label, value, sub, negative = false, testId }: { label: string; value: string; sub?: string; negative?: boolean; testId: string }) {
  return (
    <div className={PANEL} data-testid={testId}>
      <p className="text-xs text-ink-muted">{label}</p>
      <p className={`mt-1 text-xl font-semibold tabular-nums ${negative ? 'text-red-600 dark:text-red-400' : 'text-[var(--ff-text-primary)]'}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-ink-muted">{sub}</p>}
    </div>
  );
}

export function Cash13Header({ forecast }: { forecast: CashForecast13 }) {
  const first = forecast.weeks[0];
  const low = lowestWeek(forecast.weeks);
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Kpi testId="kpi-opening" label="Cash in the bank today" value={R(first?.openingCents ?? 0)} sub="Opening cash for week 1" negative={(first?.openingCents ?? 0) < 0} />
      <Kpi testId="kpi-lowest" label="Lowest week" value={low ? R(low.closingCents) : '–'}
        sub={low ? `Closing cash in ${weekLabel(low)}` : undefined} negative={(low?.closingCents ?? 0) < 0} />
    </div>
  );
}

export function Cash13Runway({ weeks }: { weeks: readonly ForecastWeek[] }) {
  const option = useCallback((palette: ChartPalette) => buildCash13RunwayOption(weeks, palette), [weeks]);
  return (
    <div data-testid="cash13-runway">
      <ChartFrame title="Cash runway" unit="R, closing cash at the end of each week" height={260} summary={runwaySummary(weeks)}>{option}</ChartFrame>
    </div>
  );
}

export function OverdueArPanel({ overdue }: { overdue: OverdueArSummary }) {
  const rows: Array<[string, number]> = [
    ['Expected after the customer\'s usual delay', overdue.byBasis.history],
    ['Too little history, expected this week', overdue.byBasis.no_history],
  ];
  return (
    <section className={PANEL} aria-labelledby="cash13-overdue">
      <h3 id="cash13-overdue" className="text-sm font-semibold text-[var(--ff-text-primary)]">Overdue customer invoices</h3>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-[var(--ff-text-primary)]" data-testid="overdue-total">{R(overdue.totalCents)}</p>
      <p className="text-xs text-ink-muted">{overdue.invoiceCount} invoice{overdue.invoiceCount === 1 ? '' : 's'} expected in these 13 weeks</p>
      <dl className="mt-3 space-y-1 text-sm">
        {rows.map(([label, cents]) => (
          <div key={label} className="flex justify-between gap-3"><dt className="text-ink-muted">{label}</dt><dd className="tabular-nums">{R(cents)}</dd></div>
        ))}
        <div className="flex justify-between gap-3"><dt className="text-ink-muted">Expected after week 13 (not in this forecast)</dt><dd className="tabular-nums">{R(overdue.beyondHorizonCents)}</dd></div>
        {overdue.disputedCents !== 0 && (
          <div className="flex justify-between gap-3"><dt className="text-ink-muted">Disputed (left out)</dt><dd className="tabular-nums">{R(overdue.disputedCents)}</dd></div>
        )}
      </dl>
    </section>
  );
}

export function WarningsList({ warnings }: { warnings: readonly ForecastWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <section className={PANEL} aria-labelledby="cash13-warnings">
      <h3 id="cash13-warnings" className="text-sm font-semibold text-[var(--ff-text-primary)]">Things to know about this forecast</h3>
      <ul className="mt-2 list-disc space-y-2 pl-5 text-sm text-[var(--ff-text-primary)]" data-testid="cash13-warnings">
        {warnings.map((w, i) => {
          const t = cash13WarningText(w);
          return (
            <li key={`${w.code}-${i}`}>
              {t.title}
              {t.detail && <span className="block text-xs text-ink-muted">{t.detail}</span>}
              {t.items && (
                <details className="mt-1 text-xs text-ink-muted">
                  <summary className="cursor-pointer">Show the {t.items.length} returns</summary>
                  <ul className="mt-1 list-none space-y-0.5 pl-0 tabular-nums">
                    {t.items.map((line) => <li key={line}>{line}</li>)}
                  </ul>
                </details>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
