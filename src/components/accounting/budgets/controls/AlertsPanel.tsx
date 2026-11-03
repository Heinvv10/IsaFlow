/**
 * The overspend alert list (budgets P5-4; owners and admins): when the alerts were last evaluated
 * (and a warning when the daily run looks missing, spec §10), Evaluate now, the open alerts and
 * those resolved in the last 30 days. A table from md up, cards below (390 px). Each alert links to
 * Budget vs Actual on its month, filtered to its slice.
 */
import Link from 'next/link';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import type { BudgetAlertItem } from '@/modules/accounting/services/budgets/budgetAlertList';
import { monthLabel } from '@/components/accounting/budgets/budgetClient';
import { formatMoney } from '@/lib/money/formatMoney';
import { formatDisplayDateTime } from '@/utils/dateFormat';
import type { BudgetAlertList } from './controlsClient';

const PANEL = 'rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] p-4';
const BTN = 'inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50';
const FIG = 'text-right whitespace-nowrap tabular-nums';
/** The daily run is late when the last evaluation is older than this. */
const STALE_MS = 36 * 3600 * 1000;

const money = formatMoney;
const pct = (a: BudgetAlertItem) => (a.pct === null ? 'over a R0 budget' : `${Math.round(a.pct * 10) / 10}%`);

function LastEvaluated({ last, now }: { last: BudgetAlertList['lastEvaluated']; now: number }) {
  if (!last) {
    return (
      <p className="flex items-start gap-1.5 text-sm text-[var(--ff-unfav)]" data-testid="alerts-never-evaluated">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> Never evaluated. The daily run may not be set up on this server yet; Evaluate now runs it once.
      </p>
    );
  }
  const stale = now - Date.parse(last.at) > STALE_MS;
  return (
    <p className={`flex items-start gap-1.5 text-sm ${stale ? 'text-[var(--ff-unfav)]' : 'text-[var(--ff-text-secondary)]'}`} data-testid="alerts-last-evaluated">
      {stale && <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
      Last evaluated {formatDisplayDateTime(last.at)} ({last.source === 'daily' ? 'daily run' : 'Evaluate now'}): {last.fired} new, {last.resolved} resolved.
      {stale && ' The daily run has not run since; check that it is installed.'}
    </p>
  );
}

function AlertRows({ items, resolved }: { items: BudgetAlertItem[]; resolved: boolean }) {
  return (
    <>
      <table className="hidden w-full text-sm md:table">
        <thead>
          <tr className="text-left text-xs text-[var(--ff-text-secondary)]">
            <th className="py-1 pr-2 font-medium">Account</th><th className="py-1 pr-2 font-medium">Month</th>
            <th className={`py-1 pr-2 font-medium ${FIG}`}>Threshold</th><th className={`py-1 pr-2 font-medium ${FIG}`}>Spent</th>
            <th className={`py-1 pr-2 font-medium ${FIG}`}>Budget</th><th className={`py-1 font-medium ${FIG}`}>Of budget</th>
            <th className="py-1 pl-2 font-medium">{resolved ? 'Resolved' : 'Fired'}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--ff-border-light)] text-[var(--ff-text-primary)]">
          {items.map((a) => (
            <tr key={a.id}>
              <td className="py-1.5 pr-2">
                <Link href={a.href} className="text-teal-600 hover:underline dark:text-teal-400">{a.accountCode} {a.accountName}</Link>
                {a.sliceName && <span className="block text-xs text-[var(--ff-text-secondary)]">{a.sliceName}</span>}
              </td>
              <td className="py-1.5 pr-2 whitespace-nowrap">{monthLabel(a.month)}</td>
              <td className={`py-1.5 pr-2 ${FIG}`}>{a.threshold}%</td>
              <td className={`py-1.5 pr-2 ${FIG}`}>{money(a.actual + a.committed)}</td>
              <td className={`py-1.5 pr-2 ${FIG}`}>{money(a.budget)}</td>
              <td className={`py-1.5 ${FIG} font-medium`}>{pct(a)}</td>
              <td className="py-1.5 pl-2 whitespace-nowrap text-xs text-[var(--ff-text-secondary)]">{formatDisplayDateTime((resolved ? a.resolvedAt : a.firedAt) ?? a.firedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="divide-y divide-[var(--ff-border-light)] md:hidden">
        {items.map((a) => (
          <li key={a.id} className="py-2 text-sm text-[var(--ff-text-primary)]">
            <Link href={a.href} className="font-medium text-teal-600 hover:underline dark:text-teal-400">{a.accountCode} {a.accountName}</Link>
            <div className="text-xs text-[var(--ff-text-secondary)]">{monthLabel(a.month)}{a.sliceName ? ` · ${a.sliceName}` : ''} · passed {a.threshold}%</div>
            <div className="mt-1 flex justify-between tabular-nums"><span>{money(a.actual + a.committed)} of {money(a.budget)}</span><span className="font-medium">{pct(a)}</span></div>
          </li>
        ))}
      </ul>
    </>
  );
}

export interface AlertsPanelProps {
  alerts: BudgetAlertList | null;
  error: string;
  busy: boolean;
  onEvaluate: () => Promise<void>;
}

export function AlertsPanel({ alerts, error, busy, onEvaluate }: AlertsPanelProps) {
  return (
    <section className={PANEL} aria-labelledby="budget-alerts-heading" data-testid="budget-alerts">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="budget-alerts-heading" className="text-base font-semibold text-[var(--ff-text-primary)]">Overspend alerts</h2>
        <button type="button" className={BTN} disabled={busy} onClick={() => void onEvaluate()} data-testid="alerts-evaluate-now">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />} Evaluate now
        </button>
      </div>
      <div className="mt-2"><LastEvaluated last={alerts?.lastEvaluated ?? null} now={Date.now()} /></div>
      {error && <p role="alert" className="mt-2 text-sm text-error-700 dark:text-error-400">{error}</p>}
      {alerts && (
        <>
          <h3 className="mt-4 text-sm font-semibold text-[var(--ff-text-primary)]">Open ({alerts.open.length})</h3>
          {alerts.open.length === 0
            ? <p className="mt-1 text-sm text-[var(--ff-text-secondary)]" data-testid="alerts-none-open">No budget line is past a threshold.</p>
            : <AlertRows items={alerts.open} resolved={false} />}
          {alerts.resolved.length > 0 && (
            <>
              <h3 className="mt-4 text-sm font-semibold text-[var(--ff-text-primary)]">Resolved in the last 30 days ({alerts.resolved.length})</h3>
              <AlertRows items={alerts.resolved} resolved />
            </>
          )}
        </>
      )}
    </section>
  );
}
