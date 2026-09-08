/**
 * THE ONE FAMILY A PRINTED PACK IS SET IN, named once.
 *
 * It lives in a leaf module with no imports because three very different
 * places need it and none of them may pull in the others: `styles/packPrint.css`
 * declares the faces, `usePrintMode.ts` (a React hook, browser-only) waits for
 * them before the page says it is print-ready, and `renderChartSvg` (Node,
 * ECharts, `node:crypto`) has to stamp the family onto every `<text>` a chart
 * emits.
 *
 * WHY THE CHART LAYER NEEDS TELLING AT ALL. ECharts defaults `textStyle.fontFamily`
 * to the literal string `sans-serif`, and it writes that into the SVG as an
 * attribute — so the chart text does not inherit the page's family, it
 * OVERRIDES it. Chromium resolves a bare `sans-serif` against the system, which
 * in the Gotenberg image is Liberation Sans: every axis label, bar label and
 * end label on pages 6, 7, 8 and 10 of both packs printed in an Arial clone
 * while the table three centimetres above them was IBM Plex. On the demo
 * income statement the figure `1 431` appeared twice on one sheet, in two
 * typefaces. That is a renderer's fallback, not a decision anyone made.
 */

/** The family every pack position is set in — the `@font-face` rules of
 *  `styles/packPrint.css` declare exactly this name. */
export const PACK_FONT_FAMILY = 'IBM Plex Sans';

/** The weights those rules declare, and therefore the weights the readiness
 *  gate waits for. A face this list does not name is a face the gate does not
 *  wait for, which is the whole defect it was written against. */
export const PACK_FONT_WEIGHTS = [400, 500, 600] as const;

/**
 * The stack, in the form CSS and ECharts both take. Identical to
 * `--pack-font-sans` in `styles/packPrint.css`, deliberately: two spellings of
 * one stack is how a chart and the table above it come to disagree.
 *
 * The fallbacks are a safety net that must never engage —
 * `tests/unit/print/packOneTypeface.test.ts` renders a pack and fails if the
 * PDF embeds any face but this one.
 */
export const PACK_FONT_STACK = `'${PACK_FONT_FAMILY}', system-ui, sans-serif`;

/**
 * THE FOOTER'S OWN FACE, AND WHY IT IS A SEPARATE FAMILY NAME.
 *
 * Chromium draws `displayHeaderFooter` templates in a document of its own that
 * inherits no stylesheet from the page — so the footer has to declare its own
 * `@font-face`, and on a page served from a real origin it may not FETCH one.
 * Measured, three ways, against a page at `http://…`:
 *
 *   footer `src: url('/fonts/…')`        -> relative to no base; Noto Sans
 *   footer `src: url('http://host/…')`   -> `Page.printToPDF` fails outright
 *   footer `src: url(data:font/woff2;…)` -> Noto Sans
 *
 * The last one works only when the MAIN document has already loaded the
 * identical data URI: Chromium matches the resource, not the family, so the
 * page loading `/fonts/IBMPlexSans-Regular.woff2` is not the same resource as
 * the footer's data URI however identical the bytes. Loading the same data URI
 * under any family name on the page is enough — measured — which is why this
 * family exists: the page never SETS TYPE in it, it only loads it, so the
 * cache holds the resource the footer is about to ask for.
 *
 * `packFooterFaceCss` is called on both sides for exactly that reason. Two
 * spellings of this string is two resources, and the footer falls back in
 * silence.
 */
export const PACK_FOOTER_FONT_FAMILY = 'IBM Plex Sans Print Footer';

/** The woff2 the footer face is cut from — the 400 weight, which is the only
 *  one the footer sets. */
export const PACK_FOOTER_FACE_FILE = 'IBMPlexSans-Regular.woff2';

/** The face, from the font's bytes in standard base64. Byte-identical on the
 *  page and in the footer template, or the mechanism above does not fire. */
export function packFooterFaceCss(base64: string): string {
  return `@font-face{font-family:'${PACK_FOOTER_FONT_FAMILY}';font-weight:400;font-style:normal;`
    + `src:url(data:font/woff2;base64,${base64}) format('woff2')}`;
}
