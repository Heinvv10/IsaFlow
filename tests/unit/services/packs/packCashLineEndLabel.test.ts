/**
 * PAGE 8'S CLOSING FIGURE DOES NOT SIT ON THE LINE IT LABELS.
 *
 * The end label is set just left of the last point, lifted above it — right
 * for a line that climbs into its last month, and on top of one that falls
 * into it: the long-period demo's cash rose to (300) and fell to (548) in
 * the final month, and "(548)" was printed across that last segment. Read off
 * the SVG: the label's opaque ground does not meet the final segment.
 */
import { describe, expect, it } from 'vitest';
import { buildCashTrendChart } from '@/modules/accounting/services/packs/pages/packPageCharts';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import { liveDemoTrend } from './fixtures/liveDemoBoardPack';

interface Box { left: number; right: number; top: number; bottom: number }

function lastSegment(svg: string): [[number, number], [number, number]] {
  const d = /<path d="(M[^"]*L[^"]*)"[^>]*fill="none"[^>]*stroke="#15202b"/.exec(svg)![1]!;
  const pts = [...d.matchAll(/[ML]([-\d.]+) ([-\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])] as [number, number]);
  return [pts[pts.length - 2]!, pts[pts.length - 1]!];
}

function labelGround(svg: string): Box {
  const m = /<path d="M([-\d.]+) ([-\d.]+)l([-\d.]+) 0l0 ([-\d.]+)[^"]*" transform="translate\(([-\d.]+) ([-\d.]+)\)" fill="#ffffff"/.exec(svg)!;
  const [x, y, w, h, tx, ty] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  return { left: tx + x, right: tx + x + w, top: ty + y, bottom: ty + y + h };
}

/** Whether a segment passes through a box, sampled finely along its length. */
function crosses([[x1, y1], [x2, y2]]: [[number, number], [number, number]], box: Box): boolean {
  for (let i = 0; i <= 200; i += 1) {
    const x = x1 + ((x2 - x1) * i) / 200;
    const y = y1 + ((y2 - y1) * i) / 200;
    if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) return true;
  }
  return false;
}

const chart = (closing: number[]) => {
  const trend = liveDemoTrend.slice(0, closing.length).map((p, i) => ({ ...p, cash: closing[i]! * 1000 }));
  return String(buildCashTrendChart(trend, PACK_SCALE)!.svg);
};

describe("page 8's closing-cash label", () => {
  it('clears a line that FALLS into its last month', () => {
    const svg = chart([-108, -115, -118, -560, -800, -1000, -1200, -1400, -1600, -300, -548]);
    expect(crosses(lastSegment(svg), labelGround(svg))).toBe(false);
  });

  it('clears a line that CLIMBS into its last month', () => {
    const svg = chart([-108, -115, -118, -560, -800, -1000, -1200, -1400, -1600, -900, -300]);
    expect(crosses(lastSegment(svg), labelGround(svg))).toBe(false);
  });
});
