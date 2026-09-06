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
  // Driven by the ids the document DEFINES, in two passes. The earlier version
  // rewrote whatever a context regex matched, and one of its alternatives —
  // `url(#` — needs no quote, so it matched inside TEXT content. A label here
  // is ledger data (an account name, a cost centre, a project code), so a
  // label of `url(#zr0-cls-0)` was rewritten in the output and the client read
  // a name that was not in their ledger. Worse, that label token entered the
  // order map and was normalised into the canonical form the hash is taken
  // over, so two charts differing ONLY in such a label hashed identically and
  // emitted the same id set — the exact collision this function prevents.
  //
  // A token typed into a label is never DECLARED, so collecting the declared
  // set first makes the hash a function of what the document declares rather
  // than of a regex's judgement about context.
  const ID_ATTRIBUTE = /\bid="([^"]*)"/g;
  // zrender also emits a `<style>` block of `.zr0-cls-0:hover` rules. Those
  // selectors declare the generated class names, and leaving them out would
  // leave the hash — and the class attributes — dependent on the instance
  // counter this function exists to remove.
  const STYLE_BLOCK = /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/g;
  // Any attribute VALUE. Every legitimate use of a generated name is one:
  // `id`, `class`, and `clip-path="url(#…)"`. Text content has no `name="`
  // to match, and zrender escapes a `"` in a label to `&quot;`, so a label
  // cannot manufacture one.
  const ATTRIBUTE_VALUE = /(\s[A-Za-z_:][\w.:-]*=")([^"]*)/g;
  const ZR_TOKEN = /zr\d+-[A-Za-z]+-?\d+/g;

  // Pass 1 — what this document declares, numbered in declaration order.
  // Ordinals come from here rather than from wherever a name happens to be
  // used first, so no use site can renumber the set.
  const order = new Map<string, number>();
  const declarations: Array<[number, string]> = [];
  for (const m of svg.matchAll(ID_ATTRIBUTE)) declarations.push([m.index, m[1] ?? '']);
  for (const m of svg.matchAll(STYLE_BLOCK)) declarations.push([m.index, m[2] ?? '']);
  declarations.sort((a, b) => a[0] - b[0]);
  for (const [, text] of declarations) {
    for (const token of text.match(ZR_TOKEN) ?? []) {
      if (!order.has(token)) order.set(token, order.size);
    }
  }

  // Pass 2 — rename only declared tokens, and only where a name can be used.
  const rewrite = (name: (index: number) => string): string => {
    const rename = (value: string): string =>
      value.replace(ZR_TOKEN, (token) => {
        const index = order.get(token);
        return index === undefined ? token : name(index);
      });
    return svg
      .replace(ATTRIBUTE_VALUE, (_whole, lead: string, value: string) => lead + rename(value))
      .replace(STYLE_BLOCK, (_whole, open: string, css: string, close: string) =>
        open + rename(css) + close,
      );
  };

  const canonical = rewrite((index) => `zrid-${index}`);
  const hash = createHash('sha1').update(canonical).digest('hex').slice(0, 8);
  return rewrite((index) => `zr${hash}-${index}`);
}

/**
 * The rendered SVG is inlined into documents that go to clients and banks, and
 * the PDF renderer fetches whatever the markup tells it to. An ECharts option
 * can produce such a fetch from data alone: a per-datum
 * `symbol: 'image://https://…'` emits `<image href="https://…">`. No option
 * builder in this repo sets `symbol` from data, so it is not reachable today —
 * but `renderChartSvg` takes `unknown`, and an outbound request from the print
 * renderer is a tracking beacon or an SSRF probe.
 *
 * So this is a runtime check, not just a test: a chart that tried to fetch
 * something is not a chart we print. A handful of anchored checks over the
 * rendered string, deliberately not a parser — the legitimate output of this
 * one code path is narrow and known.
 */
function assertNoExternalReferences(svg: string): void {
  // The two xmlns declarations are the only URLs in a clean render, and they
  // are namespace identifiers that are never fetched.
  const body = svg.replace(/xmlns(:xlink)?="[^"]*"/g, '');
  const checks: Array<[RegExp, string]> = [
    [/<script\b/i, 'a script element'],
    [/<foreignObject\b/i, 'a foreignObject'],
    [/<image\b/i, 'an image element'],
    [/\son[a-z]+\s*=/i, 'an event-handler attribute'],
    [/\b(?:xlink:)?href\s*=/i, 'an href'],
    [/https?:\/\//i, 'an absolute URL'],
  ];
  for (const [pattern, what] of checks) {
    if (pattern.test(body)) {
      throw new Error(`renderChartSvg: refusing a chart containing an external reference (${what})`);
    }
  }
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
    const svg = stableIds(chart.renderToSVGString());
    assertNoExternalReferences(svg);
    return svg;
  } finally {
    chart.dispose();
  }
}
