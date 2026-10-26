/**
 * The Budget vs Actual table: Revenue lines and Total revenue, Expense lines
 * and Total expenses, then Net profit (budgets P0, D1). Every figure is the
 * report's own: Variance prints `movement` (actual − budget) and % prints
 * `movement_pct`; good or bad news is `favourable`, coloured by
 * `varianceColor` only. An unbudgeted line shows "—" for its budget and %, no
 * colour and no bar. A line expands into its transactions for the report's
 * own range.
 */

import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { AccountDrillDown } from '@/components/accounting/AccountDrillDown';
import { useChartPalette } from '@/components/accounting/charts/ChartFrame';
import { varianceColor } from '@/components/accounting/charts/ibcs';
import type { ChartPalette } from '@/components/accounting/charts/chartTypes';
import { formatMoney } from '@/lib/money/formatMoney';
import type { BudgetVsActualLine } from '@/modules/accounting/services/reports/budgetVsActualLines';
import type { BudgetVsActualSection, BudgetVsActualSections } from '@/modules/accounting/services/reports/budgetVsActualSections';
import { variancePctLabel } from './budgetClient';

/** The report's own row model (type-only), so the screen cannot drift from the service. */
export type BvaLine = BudgetVsActualLine;
export type BvaSection = BudgetVsActualSection;
export type BvaSections = BudgetVsActualSections;

interface Props {
  lines: BvaLine[];
  sections: BvaSections;
  range: { start: string; end: string } | null;
}

const TH = 'py-3 px-4 text-xs tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase';
const COLS = 7;

function colour(favourable: boolean | null, palette: ChartPalette): React.CSSProperties | undefined {
  const c = varianceColor(favourable ?? undefined, palette);
  return c ? { color: c } : undefined;
}

/** Fill = |actual| / |budget|, capped at 100%; none without a non-zero budget (D4). */
function Bar({ line, palette }: { line: BvaLine; palette: ChartPalette }) {
  if (!line.budgeted || line.budget_amount === 0) return null;
  const fill = Math.min((Math.abs(line.actual_amount) / Math.abs(line.budget_amount)) * 100, 100);
  return (
    <div className="w-full h-2 bg-[var(--ff-bg-tertiary)] rounded-full overflow-hidden">
      <div data-testid={`bva-bar-${line.account_code}`} className="h-full rounded-full"
        style={{ width: `${fill}%`, backgroundColor: varianceColor(line.favourable ?? undefined, palette) }} />
    </div>
  );
}

function TotalRow({ id, label, s, palette, strong }: { id: string; label: string; s: BvaSection; palette: ChartPalette; strong?: boolean }) {
  return (
    <tr data-testid={`bva-total-${id}`}
      className={`border-b border-[var(--ff-border-light)] font-semibold ${strong ? 'border-t-2 font-bold' : ''}`}>
      <td colSpan={2} className="py-3 px-4 text-[var(--ff-text-primary)]">{label}</td>
      <td className="py-3 px-4 text-right text-[var(--ff-text-primary)]">{formatMoney(s.budget)}</td>
      <td className="py-3 px-4 text-right text-[var(--ff-text-primary)]">{formatMoney(s.actual)}</td>
      <td data-testid={`bva-total-${id}-variance`} className="py-3 px-4 text-right" style={colour(s.favourable, palette)}>
        {formatMoney(s.movement)}
      </td>
      <td className="py-3 px-4 text-right text-xs" style={colour(s.favourable, palette)}>{variancePctLabel(s.movement_pct)}</td>
      <td />
    </tr>
  );
}

export function BudgetVsActualTable({ lines, sections, range }: Props) {
  const palette = useChartPalette();
  const [expanded, setExpanded] = useState<string | null>(null);

  const lineRows = (type: 'revenue' | 'expense') => lines.filter((l) => l.account_type === type).map((line) => (
    <React.Fragment key={line.account_code}>
      <tr data-testid={`bva-line-${line.account_code}`}
        onClick={() => setExpanded(expanded === line.account_code ? null : line.account_code)}
        className="border-b border-[var(--ff-border-light)] hover:bg-teal-500/[0.04] cursor-pointer">
        <td className="py-3 px-4 font-mono text-[var(--ff-text-tertiary)]">
          <span className="flex items-center gap-1">
            {expanded === line.account_code ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {line.account_code}
          </span>
        </td>
        <td className="py-3 px-4 text-[var(--ff-text-primary)]">{line.account_name}</td>
        <td className="py-3 px-4 text-right text-[var(--ff-text-secondary)]">{line.budgeted ? formatMoney(line.budget_amount) : '—'}</td>
        <td className="py-3 px-4 text-right text-[var(--ff-text-primary)]">{formatMoney(line.actual_amount)}</td>
        <td data-testid={`bva-variance-${line.account_code}`} className="py-3 px-4 text-right font-medium"
          style={colour(line.favourable, palette)}>
          {formatMoney(line.movement)}
        </td>
        <td data-testid={`bva-pct-${line.account_code}`} className="py-3 px-4 text-right text-xs"
          style={colour(line.favourable, palette)}>
          {variancePctLabel(line.movement_pct)}
        </td>
        <td className="py-3 px-4"><Bar line={line} palette={palette} /></td>
      </tr>
      {expanded === line.account_code && range && (
        <AccountDrillDown accountCode={line.account_code} periodStart={range.start} periodEnd={range.end} asTableRow colSpan={COLS} />
      )}
    </React.Fragment>
  ));

  const heading = (label: string) => (
    <tr className="bg-[var(--ff-bg-secondary)]">
      <td colSpan={COLS} className="py-2 px-4 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ff-text-secondary)]">{label}</td>
    </tr>
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--ff-border-light)]">
            <th className={`text-left ${TH}`}>Account</th>
            <th className={`text-left ${TH}`}>Name</th>
            <th className={`text-right ${TH}`}>Budget</th>
            <th className={`text-right ${TH}`}>Actual</th>
            <th className={`text-right ${TH}`} title="Actual less budget">Variance</th>
            <th className={`text-right ${TH}`}>%</th>
            <th className={`${TH} w-32`}>Used</th>
          </tr>
        </thead>
        <tbody>
          {heading('Revenue')}
          {lineRows('revenue')}
          <TotalRow id="revenue" label="Total revenue" s={sections.revenue} palette={palette} />
          {heading('Expenses')}
          {lineRows('expense')}
          <TotalRow id="expense" label="Total expenses" s={sections.expense} palette={palette} />
        </tbody>
        <tfoot>
          <TotalRow id="net_profit" label="Net profit" s={sections.net_profit} palette={palette} strong />
        </tfoot>
      </table>
    </div>
  );
}
