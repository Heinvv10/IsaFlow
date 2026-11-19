/**
 * The 13-week grid: weeks across ("Week 1 · 16 Nov"), lines down in groups with a subtotal each, opening cash on
 * top and closing cash at the bottom (the engine's figures, never re-added). Estimate lines are dimmed and
 * labelled "estimate"; an AR line (one per customer) shows which bases it holds with the breakdown in cents as a
 * tooltip ("Expected: due R x · history R y · no history R z", from `basisCents`), and its `no_history` flag.
 * Writers click a cell to change it (`onEdit`); a cell changed by hand carries a marker. Viewers read only.
 * Only the table scrolls sideways; the label column is sticky.
 */
import type { ReactNode } from 'react';
import { formatStatementFigure } from '@/lib/format/money';
import type { ArBasis, CashForecast13, ForecastLine } from '@/modules/accounting/services/cashForecast13/types';
import { groupLines, totalRowLabel, weekLabel } from './forecastRows';
import type { StoredOverride } from './cash13Client';

export const BASIS_WORDS: Record<ArBasis, { label: string; tip: string }> = {
  due: { label: 'due', tip: 'Expected on the invoice due date.' },
  history: { label: 'history', tip: 'Overdue: expected after this customer\'s usual delay, from their recent paid invoices.' },
  no_history: { label: 'no history', tip: 'Overdue, and too few paid invoices to judge: expected this week.' },
};

const fig = (cents: number) => formatStatementFigure(cents / 100);
const R = (cents: number) => (cents === 0 ? 'R 0' : formatStatementFigure(cents / 100, { symbol: true }));
const BASES: readonly ArBasis[] = ['due', 'history', 'no_history'];


export function basisBreakdownText(b: Record<ArBasis, number>): string {
  return `Expected: ${BASES.map((k) => `${BASIS_WORDS[k].label} ${R(b[k])}`).join(' · ')}`;
}
const STICKY = 'sticky left-0 z-[1] bg-[var(--ff-surface-primary)]';
const CELL = 'px-3 py-2 text-right tabular-nums whitespace-nowrap';
const neg = (cents: number) => (cents < 0 ? 'text-red-600 dark:text-red-400' : '');

export function overrideKey(lineKey: string, weekStart: string): string {
  return `${lineKey}|${weekStart}`;
}

export interface ForecastGridProps {
  forecast: CashForecast13;
  overrides: ReadonlyMap<string, StoredOverride>;
  /** Present for writers when the stored inputs are available: a cell click opens the editor. */
  onEdit?: (line: ForecastLine, week: number) => void;
}

function LineLabel({ line }: { line: ForecastLine }) {
  const estimate = line.kind === 'estimate';
  const basis = line.basisCents;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span>{line.label}</span>
      {estimate && <span className="rounded border border-[var(--ff-border-primary)] px-1.5 text-xs text-ink-muted">estimate</span>}
      {basis && (
        <span className="rounded bg-[var(--ff-bg-secondary)] px-1.5 text-xs text-ink-muted" title={basisBreakdownText(basis)} data-testid="ar-basis">
          {BASES.filter((k) => basis[k] !== 0).map((k) => BASIS_WORDS[k].label).join(' · ') || 'nothing due'}
          <span className="sr-only">: {basisBreakdownText(basis)}</span>
        </span>
      )}
      {line.flags.includes('no_history') && (
        <span className="rounded border border-amber-500/40 px-1.5 text-xs text-amber-700 dark:text-amber-300" title={BASIS_WORDS.no_history.tip} data-testid="ar-no-history">
          no payment history
          <span className="sr-only">: {BASIS_WORDS.no_history.tip}</span>
        </span>
      )}
    </span>
  );
}

function Cell({ line, week, start, label, override, onEdit }: {
  line: ForecastLine; week: number; start: string; label: string; override: StoredOverride | undefined; onEdit?: ForecastGridProps['onEdit'];
}) {
  const v = line.weekly[week] ?? 0;
  const marker = override ? <span aria-hidden className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-amber-500 align-middle" /> : null;
  const changed = override ? `, changed by hand${override.note ? `: ${override.note}` : ''}` : '';
  if (!onEdit || line.kind === 'override') {
    return (
      <td className={`${CELL} ${neg(v)}`} data-cell={`${line.key}|${start}`} title={override?.note ?? undefined}>
        {fig(v)}{marker}{override && <span className="sr-only">{changed}</span>}
      </td>
    );
  }
  return (
    <td className={CELL} data-cell={`${line.key}|${start}`}>
      <button type="button" onClick={() => onEdit(line, week)} title={override?.note ?? undefined}
        aria-label={`Change ${line.label}, ${label}: ${fig(v)}${changed}`}
        className={`w-full rounded px-1 text-right hover:bg-[var(--ff-bg-hover)] focus-visible:outline focus-visible:outline-2 max-lg:min-h-11 ${neg(v)}`}>
        {fig(v)}{marker}
      </button>
    </td>
  );
}

export function ForecastGrid({ forecast, overrides, onEdit }: ForecastGridProps) {
  const { weeks } = forecast;
  const groups = groupLines(forecast.lines);
  const labels = weeks.map(weekLabel);
  const span = weeks.length + 2;
  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)]">
      <table className="w-full text-sm text-[var(--ff-text-primary)]" aria-label="13-week cash forecast">
        <thead>
          <tr className="bg-[var(--ff-bg-secondary)] text-xs text-ink-muted">
            <th scope="col" className={`${STICKY} px-3 py-2 text-left bg-[var(--ff-bg-secondary)]`}>Line</th>
            {labels.map((l) => <th key={l} scope="col" className="px-3 py-2 text-right whitespace-nowrap">{l}</th>)}
            <th scope="col" className="px-3 py-2 text-right">Total</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--ff-border-primary)]">
          <tr className="font-semibold">
            <th scope="row" className={`${STICKY} px-3 py-2 text-left`}>Opening cash</th>
            {weeks.map((w) => <td key={w.index} className={`${CELL} ${neg(w.openingCents)}`}>{fig(w.openingCents)}</td>)}
            <td className={CELL} />
          </tr>
          {groups.map((g) => (
            <GroupRows key={g.id} title={g.title} span={span}>
              {g.lines.map((line) => (
                <tr key={line.key} data-line={line.key} className={line.kind === 'estimate' ? 'opacity-60 italic' : ''}>
                  <th scope="row" className={`${STICKY} px-3 py-2 text-left font-normal min-w-[12rem]`}><LineLabel line={line} /></th>
                  {weeks.map((w) => (
                    <Cell key={w.index} line={line} week={w.index} start={w.start} label={labels[w.index] as string}
                      override={overrides.get(overrideKey(line.key, w.start))} onEdit={onEdit} />
                  ))}
                  <td className={`${CELL} ${neg(line.totalCents)}`}>{fig(line.totalCents)}</td>
                </tr>
              ))}
              <tr className="font-medium bg-[var(--ff-bg-secondary)]/50">
                <th scope="row" className={`${STICKY} px-3 py-2 text-left`}>{totalRowLabel(g.title)}</th>
                {g.subtotal.map((v, i) => <td key={i} className={`${CELL} ${neg(v)}`}>{fig(v)}</td>)}
                <td className={`${CELL} ${neg(g.total)}`}>{fig(g.total)}</td>
              </tr>
            </GroupRows>
          ))}
          <tr className="font-semibold border-t-2 border-[var(--ff-border-primary)]" data-testid="closing-row">
            <th scope="row" className={`${STICKY} px-3 py-2 text-left`}>Closing cash</th>
            {weeks.map((w) => <td key={w.index} className={`${CELL} ${neg(w.closingCents)}`}>{fig(w.closingCents)}</td>)}
            <td className={CELL} />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function GroupRows({ title, span, children }: { title: string; span: number; children: ReactNode }) {
  return (
    <>
      <tr className="bg-[var(--ff-bg-secondary)]">
        <th scope="rowgroup" colSpan={span} className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-ink-muted">{title}</th>
      </tr>
      {children}
    </>
  );
}
