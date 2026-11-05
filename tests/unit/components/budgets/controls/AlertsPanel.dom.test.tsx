/**
 * The alert panel's "last evaluated" (P5-4 review r2): the daily run and Evaluate now are kept
 * apart, and the stale warning (spec §10: the timer may not be installed) reads the DAILY run only,
 * so a recent Evaluate now cannot hide a daily run that never happens.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlertsPanel } from '@/components/accounting/budgets/controls/AlertsPanel';
import type { BudgetAlertList } from '@/components/accounting/budgets/controls/controlsClient';

afterEach(cleanup);

const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const list = (daily: string | null, manual: string | null): BudgetAlertList => ({
  open: [], resolved: [],
  lastEvaluated: {
    daily: daily ? { at: daily, source: 'daily', fired: 1, resolved: 0 } : null,
    manual: manual ? { at: manual, source: 'manual', fired: 2, resolved: 0 } : null,
  },
});
const panel = (l: BudgetAlertList) => render(<AlertsPanel alerts={l} error="" busy={false} onEvaluate={vi.fn(async () => undefined)} />);

describe('AlertsPanel last evaluated', () => {
  it('no daily run, a recent Evaluate now: warns that the daily run is missing, and shows the manual run', () => {
    panel(list(null, ago(1)));
    expect(screen.getByTestId('alerts-daily-missing')).toHaveTextContent('The daily run has never run');
    expect(screen.getByTestId('alerts-last-manual')).toHaveTextContent('Evaluate now');
  });

  it('a daily run 40 hours ago is stale even after a recent Evaluate now', () => {
    panel(list(ago(40), ago(1)));
    expect(screen.getByTestId('alerts-last-daily')).toHaveTextContent('has not run since');
  });

  it('a daily run an hour ago: no warning', () => {
    panel(list(ago(1), null));
    expect(screen.getByTestId('alerts-last-daily')).not.toHaveTextContent('has not run since');
    expect(screen.queryByTestId('alerts-daily-missing')).toBeNull();
    expect(screen.queryByTestId('alerts-last-manual')).toBeNull();
  });
});
