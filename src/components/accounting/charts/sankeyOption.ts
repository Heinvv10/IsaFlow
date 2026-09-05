/**
 * Where the cash came from and where it went, as flows through one node.
 *
 * Every ribbon is a figure from the cash-flow report; nothing here nets,
 * re-signs or reclassifies. Outflows are drawn as positive magnitudes
 * leaving `Cash` because a sankey link value cannot be negative — the
 * DIRECTION carries the sign, which is also how a reader reads it.
 */
import type { EChartsCoreOption } from 'echarts/core';
import { formatMoney } from '@/lib/format/money';
import type { ChartPalette } from './chartTypes';
import { roleStyle } from './ibcs';

export interface CashFlowReport {
  period_start: string;
  period_end: string;
  opening_cash: number;
  sections: Array<{ section: string; items: Array<{ label: string; amount: number }>; total: number }>;
  net_change: number;
  closing_cash: number;
}

const CASH = 'Cash';
const OPENING = 'Opening cash';
const CLOSING = 'Closing cash';

export function canRenderSankey(report: CashFlowReport): boolean {
  return report.opening_cash >= 0 && report.closing_cash >= 0;
}

export function buildCashFlowSankeyOption(
  report: CashFlowReport,
  palette: ChartPalette,
): EChartsCoreOption {
  const links: Array<{ source: string; target: string; value: number }> = [];
  const names = new Set<string>([CASH]);

  if (report.opening_cash > 0) {
    links.push({ source: OPENING, target: CASH, value: report.opening_cash });
    names.add(OPENING);
  }

  for (const section of report.sections) {
    for (const item of section.items) {
      if (item.amount === 0) continue;
      names.add(item.label);
      if (item.amount > 0) links.push({ source: item.label, target: CASH, value: item.amount });
      else links.push({ source: CASH, target: item.label, value: -item.amount });
    }
  }

  if (report.closing_cash > 0) {
    links.push({ source: CASH, target: CLOSING, value: report.closing_cash });
    names.add(CLOSING);
  }

  const actual = roleStyle('actual', palette);
  return {
    tooltip: {
      trigger: 'item',
      formatter: (p: { name: string; value: number }) =>
        `${p.name}<br/>${formatMoney(p.value, { symbol: true })}`,
    },
    series: [
      {
        type: 'sankey',
        data: [...names].map((name) => ({ name, itemStyle: { color: actual.color } })),
        links,
        emphasis: { focus: 'adjacency' },
        label: { color: palette.axisLabel, fontFamily: palette.figFont, fontSize: 11 },
        lineStyle: { color: 'source', opacity: 0.28 },
      },
    ],
  };
}
