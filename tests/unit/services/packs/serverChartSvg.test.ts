import { describe, it, expect } from 'vitest';
import { renderOptionToSvg, afsIncomeChartOption, buildAfsCharts } from '@/modules/accounting/services/packs/serverChartSvg';
import type { SectionLine } from '@/modules/accounting/services/afs/noteGenerators/primaryStatements/_helpers';
import type { AfsSection } from '@/modules/accounting/services/afs/afsTypes';

const line = (over: Partial<SectionLine>): SectionLine => ({
  code: 'IS001', label: 'Revenue', parentCode: null, noteNumber: null, sortOrder: 1,
  isHeader: false, isTotal: true, currentAmount: -1000, priorAmount: -800,
  totalBasis: 'running', totalComponents: null, ...over,
});

describe('renderOptionToSvg', () => {
  it('renders an SVG string in Node, with no DOM', () => {
    const svg = renderOptionToSvg({ xAxis: { type: 'category', data: ['a'] }, yAxis: { type: 'value' }, series: [{ type: 'bar', data: [1] }] });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('</svg>');
  });
});

describe('afsIncomeChartOption', () => {
  const lines = [
    line({ code: 'IS001', label: 'Revenue', currentAmount: -1000, priorAmount: -800 }),
    line({ code: 'IS900', label: 'Operating Expenses', currentAmount: 400, priorAmount: 350 }),
    line({ code: 'IS002', label: 'Detail line', isTotal: false }),
  ];

  it('charts the statement totals only', () => {
    const opt = afsIncomeChartOption(lines) as { xAxis: { data: string[] } };
    expect(opt.xAxis.data).toEqual(['Revenue', 'Operating Expenses']);
  });

  it('applies the SAME sign flip the statement applies, so revenue reads positive', () => {
    const opt = afsIncomeChartOption(lines) as unknown as { series: Array<{ name: string; data: number[] }> };
    expect(opt.series[0]!.name).toBe('Current');
    expect(opt.series[0]!.data).toEqual([1000, 400]);
    expect(opt.series[1]!.data).toEqual([800, 350]);
  });

  it('cannot be broken out of by an account name', () => {
    const nasty = afsIncomeChartOption([line({ label: 'Revenue</svg><script>alert(1)</script>' })]);
    const svg = renderOptionToSvg(nasty);
    expect(svg).not.toContain('<script');
    expect(svg.match(/<\/svg>/g)!.length).toBe(1);
  });
});

describe('buildAfsCharts', () => {
  it('returns a chart for the income statement section and nothing for the others', () => {
    const sections = [
      { sectionType: 'income_statement', dataSnapshot: { lines: [line({})] } },
      { sectionType: 'note_4', dataSnapshot: { lines: [line({})] } },
    ] as unknown as AfsSection[];
    const charts = buildAfsCharts(sections);
    expect(charts.income_statement?.startsWith('<svg')).toBe(true);
    expect(charts.note_4).toBeUndefined();
  });

  it('skips a section whose snapshot has no lines rather than drawing an empty box', () => {
    const sections = [{ sectionType: 'income_statement', dataSnapshot: null }] as unknown as AfsSection[];
    expect(buildAfsCharts(sections).income_statement).toBeUndefined();
  });
});
