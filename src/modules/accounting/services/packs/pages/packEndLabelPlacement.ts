/**
 * WHERE PAGE 8'S CLOSING-CASH LABEL GOES, DECIDED BY LOOKING AT THE CHART.
 *
 * The label sat above the last point, then — for a line that falls into its
 * last month — below it. Below a point at the bottom of the domain, its
 * opaque ground dropped out of the plot and over the last month's axis
 * label ("Sep 2026 (part)" printed as "Sep 2026 ("). Where a label fits
 * depends on where ECharts put the axis, the line and the month names, and
 * none of that is known before the chart is drawn.
 *
 * So the chart is drawn, read back, and drawn again if the label does not
 * fit: its ground must lie inside the plot, clear of every axis label, and
 * not be crossed by the line. Candidates are tried in a fixed preference
 * order; a rendered chart is about two milliseconds.
 */
import { format } from 'echarts/core';
import { PACK_FONT_STACK } from '@/lib/charts/packFont';

/** A side of the last point, and how far from it — a falling line can run
 *  through the first few pixels above its own end. */
export interface EndLabelPlacement { side: 'below' | 'above' | 'left'; away: number }

/** The end label's anchor for a placement. The right edge stays inside the
 *  plot, which ends at the last point. */
export function endLabelAnchor(at: EndLabelPlacement): { align: string; verticalAlign: string; offset: [number, number] } {
  if (at.side === 'left') return { align: 'right', verticalAlign: 'middle', offset: [-14, 0] };
  return at.side === 'below'
    ? { align: 'right', verticalAlign: 'top', offset: [-8, at.away] }
    : { align: 'right', verticalAlign: 'bottom', offset: [-8, -at.away] };
}

/** As far as a placement moves the label from its point: the full height of
 *  the tallest chart the pack draws. A candidate off the plot is refused. */
const MAX_AWAY_PX = 400;

/** Preference order: away from the side the line arrives from first, then
 *  the other side, a line further off at a time; left of the point last. */
export function endLabelCandidates(fallsIntoLast: boolean): EndLabelPlacement[] {
  const first = fallsIntoLast ? 'below' : 'above';
  const second = fallsIntoLast ? 'above' : 'below';
  const out: EndLabelPlacement[] = [];
  for (let away = 6; away <= MAX_AWAY_PX; away += 12) out.push({ side: first, away }, { side: second, away });
  out.push({ side: 'left', away: 0 });
  return out;
}

interface Box { left: number; right: number; top: number; bottom: number }

const overlaps = (a: Box, b: Box): boolean =>
  Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5
  && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;

function plotRect(svg: string): Box | null {
  const m = /<clipPath[^>]*>\s*<path d="M([-\d.]+) ([-\d.]+)l([-\d.]+) 0l0 ([-\d.]+)/.exec(svg);
  if (m === null) return null;
  const [x, y, w, h] = m.slice(1, 5).map(Number) as [number, number, number, number];
  return { left: x, right: x + w, top: y, bottom: y + h };
}

/** The end label's opaque ground, and the translate that anchors it. */
function ground(svg: string, paper: string): { box: Box; anchor: string } | null {
  const re = new RegExp(
    `<path d="M([-\\d.]+) ([-\\d.]+)l([-\\d.]+) 0l0 ([-\\d.]+)[^"]*" transform="(translate\\([-\\d. ]+\\))" fill="${paper}"`,
    'i',
  );
  const m = re.exec(svg);
  if (m === null) return null;
  const [x, y, w, h] = m.slice(1, 5).map(Number) as [number, number, number, number];
  const t = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(m[5]!)!;
  const tx = Number(t[1]);
  const ty = Number(t[2]);
  return { box: { left: tx + x, right: tx + x + w, top: ty + y, bottom: ty + y + h }, anchor: m[5]! };
}

/** Every axis label's box: the texts that are not the end label itself. */
function axisLabels(svg: string, endAnchor: string): Box[] {
  const out: Box[] = [];
  for (const m of svg.matchAll(/<text([^>]*)>([^<]*)<\/text>/g)) {
    const attrs = m[1]!;
    const t = /transform="(translate\(([-\d.]+) ([-\d.]+)\))"/.exec(attrs);
    if (t === null || t[1] === endAnchor) continue;
    const size = Number(/font-size:([\d.]+)px/.exec(attrs)?.[1] ?? 12);
    const text = m[2]!.replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    const width = format.getTextRect(text, `${size}px ${PACK_FONT_STACK}`).width;
    const x = Number(t[2]) + Number(/\sx="([-\d.]+)"/.exec(attrs)?.[1] ?? 0);
    const y = Number(t[3]) + Number(/\sy="([-\d.]+)"/.exec(attrs)?.[1] ?? 0);
    const anchor = /text-anchor="(\w+)"/.exec(attrs)?.[1] ?? 'start';
    const left = anchor === 'end' ? x - width : anchor === 'middle' ? x - width / 2 : x;
    out.push({ left, right: left + width, top: y - size / 2, bottom: y + size / 2 });
  }
  return out;
}

/** Whether a segment enters a box — exactly, by clipping the segment to it
 *  (Liang–Barsky). A sampled test missed a line cutting a label's corner. */
function segmentEnters(x1: number, y1: number, x2: number, y2: number, box: Box): boolean {
  const dx = x2 - x1;
  const dy = y2 - y1;
  let t0 = 0;
  let t1 = 1;
  const edges: Array<[number, number]> = [
    [-dx, x1 - box.left], [dx, box.right - x1], [-dy, y1 - box.top], [dy, box.bottom - y1],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q <= 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 >= t1) return false;
  }
  return true;
}

/** Whether the series' polyline passes through a box. */
function lineCrosses(svg: string, ink: string, box: Box): boolean {
  const d = new RegExp(`<path d="(M[^"]*L[^"]*)"[^>]*fill="none"[^>]*stroke="${ink}"`, 'i').exec(svg)?.[1];
  if (d === undefined) return false;
  const pts = [...d.matchAll(/[ML]([-\d.]+) ([-\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
  for (let i = 1; i < pts.length; i += 1) {
    if (segmentEnters(pts[i - 1]![0], pts[i - 1]![1], pts[i]![0], pts[i]![1], box)) return true;
  }
  return false;
}

/** Whether the drawn end label sits inside the plot, clear of the axis
 *  labels and of the line. A chart with no end label to find fits trivially. */
export function endLabelFits(svg: string, palette: { paper: string; ink: string }): boolean {
  const rect = plotRect(svg);
  const label = ground(svg, palette.paper);
  if (rect === null || label === null) return true;
  const b = label.box;
  if (b.left < rect.left - 0.5 || b.right > rect.right + 0.5 || b.top < rect.top - 0.5 || b.bottom > rect.bottom + 0.5) {
    return false;
  }
  if (axisLabels(svg, label.anchor).some((a) => overlaps(a, b))) return false;
  return !lineCrosses(svg, palette.ink, b);
}
