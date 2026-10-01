/**
 * Reading a rendered bridge back off its SVG: the plot's clip rectangle, the
 * bars, and the figures printed on or beside them. Shared by the tests that
 * hold bridge labels to the rectangle ECharts actually drew.
 */
import { DEFAULT_CHART_PALETTE } from '@/modules/accounting/services/packs/packChartOptions';

export interface ClipRect { top: number; bottom: number; height: number }
export interface Bar { centre: number; top: number; bottom: number; fill: string }
/** A figure: zrender sets it on `dominant-baseline: central`, so `y` is its middle. */
export interface Figure { x: number; y: number; text: string; fill: string }

export const FIGURE_PX = 12;

export function clipRect(svg: string): ClipRect {
  const m = /<clipPath[^>]*>\s*<path d="M[-\d.]+ ([-\d.]+)l[-\d.]+ 0l0 ([-\d.]+)/.exec(svg);
  if (m === null) throw new Error('the SVG carries no clip rectangle');
  const top = Number(m[1]);
  const height = Number(m[2]);
  return { top, bottom: top + height, height };
}

/** Everything drawn inside the clipped group — the custom series. */
function plotted(svg: string): string {
  const at = svg.indexOf('<g clip-path');
  return at < 0 ? '' : svg.slice(at);
}

export function bars(svg: string): Bar[] {
  const all = [...plotted(svg).matchAll(/<path d="M([-\d.]+) ([-\d.]+)l([-\d.]+) 0l0 ([-\d.]+)l[-\d.]+ 0Z"[^>]*fill="([^"]+)"/g)]
    .map((m) => ({
      centre: Number(m[1]) + Number(m[3]) / 2,
      top: Number(m[2]),
      bottom: Number(m[2]) + Number(m[4]),
      width: Number(m[3]),
      fill: m[5]!.toLowerCase(),
    }));
  // Not the paper ground under an outside figure, and not the plot-wide rect
  // the clip path itself is drawn as.
  const widest = Math.max(...all.map((r) => r.width));
  return all
    .filter((r) => r.fill !== DEFAULT_CHART_PALETTE.paper.toLowerCase() && r.width < widest)
    .map(({ centre, top, bottom, fill }) => ({ centre, top, bottom, fill }));
}

export function figures(svg: string): Figure[] {
  return [...plotted(svg).matchAll(/<text([^>]*)\bx="([-\d.]+)"\s+y="([-\d.]+)"([^>]*)>([^<]*)<\/text>/g)]
    .map((m) => ({
      x: Number(m[2]), y: Number(m[3]), text: m[5]!,
      fill: (/fill="([^"]+)"/.exec(`${m[1]} ${m[4]}`)?.[1] ?? '').toLowerCase(),
    }));
}

/** The bar a figure belongs to: the one centred under it. */
export function barOf(svg: string, figure: Figure): Bar | undefined {
  return bars(svg).find((b) => Math.abs(b.centre - figure.x) < 2);
}

/**
 * Whether a figure is on the wrong side of its bar's base: below a rising
 * bar's foot, or above a falling bar's head. On or inside the bar is not.
 */
export function wrongSide(figure: Figure, bar: Bar, rises: boolean): boolean {
  return rises
    ? figure.y - FIGURE_PX / 2 > bar.bottom + 0.01
    : figure.y + FIGURE_PX / 2 < bar.top - 0.01;
}

export function outsideClip(figure: Figure, clip: ClipRect): boolean {
  return figure.y - FIGURE_PX / 2 < clip.top - 0.01 || figure.y + FIGURE_PX / 2 > clip.bottom + 0.01;
}

/** Whether a figure sits over its own bar — any overlap with the fill. */
export function overOwnBar(figure: Figure, bar: Bar): boolean {
  return Math.min(figure.y + FIGURE_PX / 2, bar.bottom) - Math.max(figure.y - FIGURE_PX / 2, bar.top) > 0.5;
}
