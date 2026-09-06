/**
 * Server-rendered ECharts SVG, for PDFs produced by a renderer that runs no
 * JavaScript — the statutory AFS path through WeasyPrint.
 *
 * Its own module registry, deliberately: src/lib/charts/echarts.ts registers
 * the canvas renderer and is documented as client-only. Here only the SVG
 * renderer and the chart types a statement needs are registered, so this file
 * is safe to import in a Node request handler.
 *
 * It lives here, beside its only consumer (pdfExportService.ts). It was
 * written under services/packs/ while this workstream owned both halves, but
 * it imports three afs/ modules and no pack surface renders through it — the
 * screen and the PDF draw their charts in the browser from packChartOptions.ts,
 * and the deck uses native PowerPoint charts. The one thing it still borrows
 * from packs/ is the default palette, so an AFS chart and a pack chart are the
 * same colours.
 */
import * as echarts from 'echarts/core';
import { BarChart } from 'echarts/charts';
import { GridComponent, LegendComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';
import { log } from '@/lib/logger';
import type { AfsSection, SectionType } from './afsTypes';
import { flipSign, type SectionLine } from './noteGenerators/primaryStatements/_helpers';
import { isRevenueLine } from './noteGenerators/primaryStatements/incomeStatement';
import { DEFAULT_CHART_PALETTE, type ChartPalette } from '../packs/packChartOptions';

echarts.use([BarChart, GridComponent, LegendComponent, SVGRenderer]);

const DEFAULT_SIZE = { width: 680, height: 300 };
/** Statement totals are few; more than this on one chart is unreadable. */
const MAX_BARS = 6;

/**
 * Account labels come from the database and end up inside SVG text. Angle
 * brackets are removed rather than entity-escaped: escaping would double up
 * if ECharts escapes as well, and no legitimate account name contains one.
 */
function sanitizeLabel(label: string): string {
  return label.replace(/[<>]/g, '').trim();
}

export function renderOptionToSvg(option: EChartsCoreOption, size = DEFAULT_SIZE): string {
  const chart = echarts.init(null, undefined, { renderer: 'svg', ssr: true, width: size.width, height: size.height });
  try {
    chart.setOption(option);
    return chart.renderToSVGString();
  } finally {
    chart.dispose();
  }
}

export function afsIncomeChartOption(lines: SectionLine[], palette: ChartPalette = DEFAULT_CHART_PALETTE): EChartsCoreOption {
  // The SAME flip the statement applies (incomeStatement.ts), imported rather
  // than restated: a second copy of that rule is a chart that contradicts the
  // table three centimetres above it.
  const totals = lines
    .filter((l) => l.isTotal)
    .slice(0, MAX_BARS)
    .map((l) => (isRevenueLine(l) ? flipSign(l) : l));

  return {
    animation: false,
    grid: { left: 90, right: 20, top: 30, bottom: 70 },
    legend: { data: ['Current', 'Prior'], bottom: 0 },
    xAxis: {
      type: 'category',
      data: totals.map((l) => sanitizeLabel(l.label)),
      axisLabel: { color: palette.axis, interval: 0, rotate: 25 },
    },
    yAxis: { type: 'value', axisLabel: { color: palette.axis } },
    series: [
      { name: 'Current', type: 'bar', itemStyle: { color: palette.ink }, data: totals.map((l) => l.currentAmount) },
      { name: 'Prior', type: 'bar', itemStyle: { color: palette.prior }, data: totals.map((l) => l.priorAmount) },
    ],
  };
}

/** The seam: one entry per section type that benefits from a visual. */
const CHART_BUILDERS: Partial<Record<SectionType, (snapshot: Record<string, unknown>) => EChartsCoreOption | null>> = {
  income_statement: (snapshot) => {
    const lines = snapshot.lines;
    if (!Array.isArray(lines) || lines.length === 0) return null;
    return afsIncomeChartOption(lines as SectionLine[]);
  },
};

export function buildAfsCharts(sections: AfsSection[]): Partial<Record<SectionType, string>> {
  const charts: Partial<Record<SectionType, string>> = {};
  for (const section of sections) {
    const builder = CHART_BUILDERS[section.sectionType];
    if (!builder || !section.dataSnapshot) continue;
    const option = builder(section.dataSnapshot);
    if (!option) continue;
    charts[section.sectionType] = renderOptionToSvg(option);
  }
  log.info('buildAfsCharts', { rendered: Object.keys(charts).length }, 'afs');
  return charts;
}
