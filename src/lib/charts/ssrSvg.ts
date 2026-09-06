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
 * Renumbering them by order of first appearance makes the output a pure
 * function of the option and the size. The names stay unique WITHIN one SVG,
 * which is all they have to be — each chart is its own fragment on the page,
 * and its styles are scoped to it.
 */
function stableIds(svg: string): string {
  const seen = new Map<string, string>();
  return svg.replace(/zr\d+-[A-Za-z]+-?\d+/g, (token) => {
    const existing = seen.get(token);
    if (existing) return existing;
    const stable = `zr-${seen.size}`;
    seen.set(token, stable);
    return stable;
  });
}

export function renderChartSvg(
  option: unknown,
  opts: { widthMm: number; heightMm: number },
): string {
  const width = Math.round(opts.widthMm * PX_PER_MM);
  const height = Math.round(opts.heightMm * PX_PER_MM);
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width, height });
  try {
    // `animation: false` is not cosmetic. An animating option renders its
    // FIRST FRAME, which for a bar series is zero height — the chart would
    // print as an empty axis. It also keeps the output deterministic.
    chart.setOption({ ...(option as Record<string, unknown>), animation: false });
    return stableIds(chart.renderToSVGString());
  } finally {
    chart.dispose();
  }
}
