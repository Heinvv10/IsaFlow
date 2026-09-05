import { useEffect, useRef } from 'react';
import type { EChartsType, EChartsCoreOption } from 'echarts/core';
import { echarts } from '@/lib/charts/echarts';
import { buildTheme } from '@/lib/charts/theme';
import { log } from '@/lib/logger';

const THEME_NAME = 'ff-echarts-theme';
let themeRegistered = false;

function registerThemeOnce(): void {
  if (themeRegistered || typeof document === 'undefined') return;
  const styles = getComputedStyle(document.documentElement);
  const theme = buildTheme((name) => styles.getPropertyValue(name).trim());
  echarts.registerTheme(THEME_NAME, theme);
  themeRegistered = true;
}

export interface EChartProps {
  option: EChartsCoreOption;
  height?: number;
  renderer?: 'canvas' | 'svg';
}

export function EChart({ option, height = 280, renderer = 'canvas' }: EChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsType | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    registerThemeOnce();

    const chart = echarts.init(containerRef.current, THEME_NAME, { renderer });
    chartRef.current = chart;

    const resizeObserver = new ResizeObserver(() => {
      chart.resize();
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, [renderer]);

  useEffect(() => {
    if (!chartRef.current) return;
    try {
      chartRef.current.setOption(option, { notMerge: true });
    } catch (error) {
      log.error('EChart failed to set option', { error });
    }
  }, [option]);

  return <div ref={containerRef} style={{ width: '100%', height }} />;
}
