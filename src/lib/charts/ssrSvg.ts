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
import { PACK_FONT_STACK } from '@/lib/charts/packFont';

export const PX_PER_MM = 96 / 25.4;

/** The three heights a pack chart is allowed to take, in millimetres. */
export const CHART_HEIGHT_MM = { inline: 48, half: 72, full: 110 } as const;

/**
 * The brand and its two guards live in a sibling that imports nothing from
 * Node and nothing from ECharts, so the browser can adopt a serialised chart
 * (see `adoptTrustedChartSvg` there). They are re-exported here because every
 * existing caller — and the guards' own test batteries — import them from
 * this module, and because `renderChartSvg` below must be seen to call THESE
 * functions rather than a second copy.
 */
export {
  assertNoExternalReferences,
  assertStyleBlockIsOurs,
  adoptTrustedChartSvg,
} from '@/lib/charts/trustedChartSvg';
export type { TrustedChartSvg } from '@/lib/charts/trustedChartSvg';

import {
  assertNoExternalReferences,
  assertStyleBlockIsOurs,
  type TrustedChartSvg,
} from '@/lib/charts/trustedChartSvg';

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
 * NO CHART LEAVES HERE SET IN THE RENDERER'S DEFAULT FACE.
 *
 * The option's `textStyle` reaches an axis label and an ECharts series label,
 * and it does NOT reach a raw zrender text drawn by a `custom` series: that
 * takes `style.font`, whose default is the literal `12px sans-serif`, and
 * zrender emits it as the `font` shorthand rather than as `font-family`. The
 * profit bridge's bar values are exactly such elements, so the pack's family
 * was set on every chart and the bridge's own figures still printed in
 * whatever Chromium resolves a bare `sans-serif` to — Liberation Sans in the
 * Gotenberg image. On the demo income statement that put `1 431` on one sheet
 * twice in two typefaces, once in the Cost of sales row and once on its own
 * bar a centimetre below.
 *
 * A default that silently produces a second typeface cannot be guarded by
 * setting a value somewhere; it has to be guarded by reading what came out.
 *
 * THE GENERIC KEYWORDS ONLY, AND THAT IS THE WHOLE RULE. A bare `sans-serif`
 * is never something a caller decided — every builder in this repo names a
 * face — so it is always the renderer's default arriving unset. A caller that
 * genuinely asks for another family is making a choice, and this is a shared
 * SSR renderer rather than a pack-private one, so it is not the place to
 * legislate which face a chart may be set in. What the PACK is allowed to
 * embed is held on the printed file instead, by
 * `tests/unit/print/packOneTypeface.test.ts`.
 */
const RENDERER_DEFAULT_FACES = new Set(['sans-serif', 'serif', 'monospace']);

function assertNoDefaultFontFamily(svg: string): void {
  // FROM `style` ATTRIBUTES ONLY, which is where zrender puts a font and is
  // the one position in the document where the token means a typeface. A chart
  // LABEL is ledger data — a cost centre, a project code — and scanning the
  // whole markup reads it as one. This file has been bitten by matching a
  // token anywhere instead of where it means something twice already; see
  // `stableIds` and `assertStyleBlockIsOurs`.
  const declarations = [...svg.matchAll(/\sstyle="([^"]*)"/g)].map((m) => m[1]!);
  const families = declarations.flatMap((style) => [
    ...[...style.matchAll(/font-family\s*:\s*([^;]*)/g)].map((m) => m[1]!.trim()),
    // zrender's own spelling for a raw text element is the `font` SHORTHAND —
    // `font: 12px sans-serif` — which no `font-family` scan would ever see.
    ...[...style.matchAll(/(?:^|;)\s*font\s*:\s*[\d.]+px\s+([^;]*)/g)].map((m) => m[1]!.trim()),
  ]);
  const bare = [...new Set(families.filter((family) => RENDERER_DEFAULT_FACES.has(family)))];
  if (bare.length > 0) {
    throw new Error(
      `renderChartSvg: refusing a chart whose text is set in the renderer's default face (${bare.join(', ')}). `
      + 'Name a family on the element that emitted it — a `custom` series text takes '
      + '`style.fontFamily`, not `option.textStyle`.',
    );
  }
}

export function renderChartSvg(
  option: unknown,
  opts: { widthMm: number; heightMm: number },
): TrustedChartSvg {
  const width = Math.round(opts.widthMm * PX_PER_MM);
  const height = Math.round(opts.heightMm * PX_PER_MM);
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width, height });
  try {
    // `animation: false` is defensive, not load-bearing. Under `ssr: true`
    // zrender draws a complete frame regardless — measured: bar heights are
    // identical with the flag true, false, or absent. It is kept because the
    // option is handed to a headless renderer that must never be asked for a
    // partial frame, but do not believe it is what makes the chart appear.
    // THE FAMILY, ON EVERY CHART, FROM ONE PLACE.
    //
    // ECharts writes `font-family` as an ATTRIBUTE on every `<text>` it
    // emits, and its default is the literal `sans-serif` — so a chart inlined
    // into the pack does not inherit the page's face, it overrides it with
    // whatever Chromium resolves `sans-serif` to (Liberation Sans in the
    // Gotenberg image). Set here rather than in the five option builders
    // because a sixth builder would be a sixth chance to forget, and because
    // `renderChartSvg` is the pack's ONLY producer of chart markup — the
    // statutory AFS renderer has its own (`afs/serverChartSvg.ts`) and its own
    // typography, so this does not reach it.
    //
    // BEFORE the caller's option, so a chart that genuinely needs another face
    // can still say so; nothing in the pack does.
    chart.setOption({
      textStyle: { fontFamily: PACK_FONT_STACK },
      ...(option as Record<string, unknown>),
      animation: false,
    });
    const svg = stableIds(chart.renderToSVGString());
    assertNoExternalReferences(svg);
    assertStyleBlockIsOurs(svg);
    assertNoDefaultFontFamily(svg);
    return svg as TrustedChartSvg;
  } finally {
    chart.dispose();
  }
}
