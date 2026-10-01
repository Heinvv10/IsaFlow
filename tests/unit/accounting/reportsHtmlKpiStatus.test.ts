/**
 * THE LEGACY HTML PACK DOES NOT COLOUR AN UNSCORED KPI AS A FAILING ONE.
 *
 * Its status pill fell through to `status-red` for anything not green or
 * amber, so a ratio the engine could not state — debt to equity on negative
 * equity, a margin on negative revenue — printed a red "NOT_MEANINGFUL" pill:
 * red says it failed, and it was never measured. It now has its own neutral
 * class, the screen's rule (`PackSectionCard`'s neutral tone), and the row
 * prints the reason.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() }, apiLogger: { info: vi.fn(), error: vi.fn() } }));

import { renderSectionHtml } from '@/../pages/api/accounting/reports-html';
import type { PackSection } from '@/modules/accounting/services/reports/reportPackService';

const section: PackSection = {
  type: 'kpis', title: 'KPI Scorecard',
  data: { scorecard: [
    { ratioKey: 'currentRatio', name: 'Current Ratio', value: 2.4, target: 1.5, status: 'green', percentOfTarget: 160 },
    { ratioKey: 'debtorDays', name: 'Debtor Days', value: 50, target: 30, status: 'amber', percentOfTarget: 166 },
    { ratioKey: 'netProfitMargin', name: 'Net Profit Margin', value: 2, target: 15, status: 'red', percentOfTarget: 13 },
    { ratioKey: 'debtToEquity', name: 'Debt to Equity', value: null, target: 0.5, status: 'not_meaningful',
      reason: 'Equity is negative — liabilities exceed assets, so this ratio inverts and cannot be ranked.', percentOfTarget: 0 },
  ] },
};

const row = (name: string): string => renderSectionHtml(section).split('<tr>').find((r) => r.includes(`<td>${name}</td>`))!;

describe('the legacy HTML pack\'s KPI status', () => {
  it('gives an unscored KPI a neutral pill, not red', () => {
    const html = row('Debt to Equity');
    expect(html).toContain('class="status-neutral"');
    expect(html).not.toContain('status-red');
    expect(html).toContain('NOT MEANINGFUL');
  });

  it('prints the reason in place of a figure', () => {
    expect(row('Debt to Equity')).toContain('Equity is negative — liabilities exceed assets');
  });

  it('keeps red for a KPI that was measured and missed', () => {
    expect(row('Net Profit Margin')).toContain('class="status-red"');
    expect(row('Current Ratio')).toContain('class="status-green"');
    expect(row('Debtor Days')).toContain('class="status-amber"');
  });
});
