import { describe, it, expect } from 'vitest';
import { buildTheme } from '@/lib/charts/theme';

describe('buildTheme', () => {
  it('reads CSS variables into the ECharts theme', () => {
    const vars: Record<string, string> = {
      '--ff-text-primary': '#111827',
      '--ff-text-tertiary': '#9ca3af',
      '--ff-border-light': '#e5e7eb',
      '--ff-fav': '#2e7d32',
      '--ff-unfav': '#c62828',
      '--ff-prior': '#607d8b',
      '--ff-plan': '#8a94a0',
      '--ff-fig-font': 'ui-monospace, Menlo, monospace',
    };
    const getVar = (name: string) => vars[name] ?? '';

    const theme = buildTheme(getVar);

    expect(theme.color).toEqual(['#111827', '#607d8b', '#8a94a0']);
    expect(theme.textStyle.fontFamily).toBe('ui-monospace, Menlo, monospace');
  });

  it('falls back to sane defaults when getVar returns empty strings', () => {
    const theme = buildTheme(() => '');

    expect(theme.color).toEqual(['#15202b', '#c9d0cc', '#8a94a0']);
    expect(theme.textStyle.fontFamily).toBe('ui-monospace, monospace');
  });

  it('colours axis lines and labels from the tertiary text and light border tokens', () => {
    const theme = buildTheme(() => '');

    expect(theme.categoryAxis.axisLine.lineStyle.color).toBe('#e5e7eb');
    expect(theme.categoryAxis.axisLabel.color).toBe('#9ca3af');
    expect(theme.valueAxis.axisLine.lineStyle.color).toBe('#e5e7eb');
    expect(theme.valueAxis.axisLabel.color).toBe('#9ca3af');
  });
});
