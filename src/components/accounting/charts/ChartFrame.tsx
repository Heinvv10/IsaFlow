import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { EChartsCoreOption } from 'echarts/core';
import { EChartClient } from '@/components/charts/EChartClient';
import { buildTheme } from '@/lib/charts/theme';
import { DEFAULT_PALETTE, paletteFromTheme, type ChartPalette } from './chartTypes';

/**
 * The palette, re-resolved whenever `<html>`'s `class`/`data-theme` actually
 * changes. `DEFAULT_PALETTE` is returned on the server and for the first
 * client paint so the markup matches and React does not warn about a
 * hydration mismatch.
 *
 * This watches the DOM attribute directly, via `MutationObserver`, rather
 * than subscribing to `ThemeContext`'s `theme` value: `ThemeContext` flips
 * the `dark` class from its OWN effect, and that effect is a sibling of
 * this one, not an ancestor — React fires passive effects bottom-up on
 * both mount and update, so a `useEffect([theme])` here would still run
 * BEFORE `ThemeProvider`'s effect had touched the class, and would read
 * `getComputedStyle` one toggle behind. A `MutationObserver` only fires
 * once the class attribute has actually mutated, so it can't win that race,
 * and it repaints every chart no matter what flips the class (the app's
 * theme toggle, a future preference switch, or a script).
 */
export function useChartPalette(): ChartPalette {
  const [resolved, setResolved] = useState<ChartPalette | null>(null);
  useEffect(() => {
    const resolve = () => {
      const styles = getComputedStyle(document.documentElement);
      setResolved(paletteFromTheme(buildTheme((name) => styles.getPropertyValue(name).trim())));
    };
    resolve();

    const observer = new MutationObserver(resolve);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme'],
    });
    return () => observer.disconnect();
  }, []);
  return resolved ?? DEFAULT_PALETTE;
}

export interface ChartFrameProps {
  title: string;
  /** The unit and basis, stated in words. IBCS requires it and a reader who
   *  has to guess whether a bar is thousands or millions will guess wrong. */
  unit: string;
  height?: number;
  /** Shown in place of the chart when the builder returns null. */
  unavailable?: string;
  children: (palette: ChartPalette) => EChartsCoreOption | null;
}

export function ChartFrame({
  title, unit, height = 280, unavailable, children,
}: ChartFrameProps): ReactElement {
  const palette = useChartPalette();
  const option = useMemo(() => children(palette), [children, palette]);

  return (
    <figure className="m-0 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] p-5">
      <figcaption className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">{title}</h2>
        <span className="text-xs text-[var(--ff-text-tertiary)]">{unit}</span>
      </figcaption>
      {option === null ? (
        <p className="py-8 text-center text-sm text-[var(--ff-text-secondary)]">
          {unavailable ?? 'Not meaningful for this period.'}
        </p>
      ) : (
        <EChartClient option={option} height={height} />
      )}
    </figure>
  );
}
