/**
 * An ECharts option rendered to an inline SVG string, in plain Node.
 *
 * This is what puts a chart in a printed pack: the PDF renderer photographs
 * the page, and a chart that draws only after client hydration is a race the
 * readiness gate cannot see. Rendering server-side removes the race entirely
 * — by the time the page is served, the chart is already markup.
 *
 * It works because the option builders take a palette as an ARGUMENT rather
 * than reading `document` themselves: that is what makes them callable here.
 * Keep it that way.
 */
import { createHash } from 'node:crypto';

import { echarts } from '@/lib/charts/echarts';

const PX_PER_MM = 96 / 25.4;

/** The three heights a pack chart is allowed to take, in millimetres. */
export const CHART_HEIGHT_MM = { inline: 48, half: 72, full: 110 } as const;

/**
 * zrender scopes its generated class names and clip-path ids to a
 * PROCESS-GLOBAL counter — the same chart drawn twice comes out as
 * `zr0-cls-2` and then `zr1-cls-15`, because both the instance number and
 * the style ordinal keep climbing for the life of the process. Two renders
 * of one option therefore differ byte-for-byte purely by how many charts the
 * process has drawn before, which makes a rendered pack undiffable and
 * uncacheable.
 *
 * But that per-instance prefix is also the ONLY thing keeping two charts'
 * ids apart, and a pack page inlines several SVGs into one document — the
 * board pack's highlights page carries eight sparklines. Dropping the prefix
 * for a fixed one makes every chart emit `<clipPath id="zr-1">`, `url(#zr-1)`
 * resolves to whichever came first, and a tall chart's plot area is silently
 * clipped to a short chart's box in the printed PDF.
 *
 * So the prefix is replaced rather than removed: a short hash of the
 * canonicalised markup. Same option and size -> same hash (deterministic);
 * different chart -> different hash (unique on the page). Two charts that
 * render byte-identically do share ids, which is harmless — their clip rects
 * are identical too.
 */
function stableIds(svg: string): string {
  const ZR_TOKEN = /zr\d+-[A-Za-z]+-?\d+/g;
  const order = new Map<string, number>();
  const canonical = svg.replace(ZR_TOKEN, (token) => {
    if (!order.has(token)) order.set(token, order.size);
    return `zrid-${order.get(token)}`;
  });
  const hash = createHash('sha1').update(canonical).digest('hex').slice(0, 8);
  return svg.replace(ZR_TOKEN, (token) => `zr${hash}-${order.get(token)}`);
}

export function renderChartSvg(
  option: unknown,
  opts: { widthMm: number; heightMm: number },
): string {
  const width = Math.round(opts.widthMm * PX_PER_MM);
  const height = Math.round(opts.heightMm * PX_PER_MM);
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width, height });
  try {
    // `animation: false` is defensive, not load-bearing. Under `ssr: true`
    // zrender draws a complete frame regardless — measured: bar heights are
    // identical with the flag true, false, or absent. It is kept because the
    // option is handed to a headless renderer that must never be asked for a
    // partial frame, but do not believe it is what makes the chart appear.
    chart.setOption({ ...(option as Record<string, unknown>), animation: false });
    return stableIds(chart.renderToSVGString());
  } finally {
    chart.dispose();
  }
}
