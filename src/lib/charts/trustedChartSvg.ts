/**
 * The brand a rendered chart SVG carries, the guard that earns it, and the
 * only two ways to obtain one.
 *
 * Split out of `ssrSvg.ts` — which still re-exports every name here, so no
 * caller moved — for one measured reason: `ssrSvg.ts` imports `node:crypto`
 * and the whole of ECharts, and `next.config.js` sets `crypto: false` in the
 * client webpack fallback. A browser module that imports it does not merely
 * ship a chart library it cannot use; the `node:` URI scheme fails to bundle
 * and the BUILD fails (the same defect `shareBundleSafety.test.ts` was written
 * for, on `packParamsHash.ts`). The board pack's print page now adopts a
 * deserialised document in the browser, so `adoptTrustedChartSvg` has to be
 * reachable from there. Nothing in this file touches Node, a DOM, or ECharts:
 * a tokenizer and a CSS-shape check over a string, and the type they hand out.
 *
 * `renderChartSvg` and `adoptTrustedChartSvg` call the SAME guard,
 * `assertNoExternalReferences` below — one grammar parse that also checks the
 * `<style>` bodies it extracted — not two copies that could drift, which is
 * the whole point of the split being a move rather than a re-implementation.
 */
import { parseSvgGrammar, SvgGrammarError, urlReferenceProblem } from './svgGrammar';

/**
 * A string that has passed `assertNoExternalReferences` — one grammar parse
 * that also checks the `<style>` bodies it extracted — which happens in
 * exactly two places: `renderChartSvg` (in `ssrSvg.ts`, which calls it after
 * rendering) and `adoptTrustedChartSvg` below. A page-model field typed
 * `TrustedChartSvg` instead of `string` cannot be filled from any other
 * source without an explicit, greppable `as TrustedChartSvg` cast, which is
 * the point: a plain `string` assignment gave a later task that populates a
 * chart block from anywhere else (a template string, a Sage import, a
 * user-entered narrative) a silent path onto a board pack page inlined via
 * `dangerouslySetInnerHTML`. The brand does not re-run the guards — it marks
 * that they already ran.
 *
 * R-P41, AS AMENDED. The brand was originally sound only because the page
 * model was composed in the SAME process that rendered it, and this comment
 * warned that a future task serialising a `PackPagesDocument` to JSON would
 * see `TrustedChartSvg` reduce to `any` on `JSON.parse`. That task is now
 * done — the board pack is composed server-side by
 * `pages/api/accounting/packs/[id]/pages.ts`, because `renderChartSvg` CANNOT
 * run in a browser (it needs `node:crypto` and ECharts, and the client
 * webpack fallback sets `crypto: false`), so the boundary is not optional.
 * The remedy this comment prescribed is the one that was built:
 * `adoptTrustedChartSvg` re-runs the guard on the deserialised value before
 * handing back the brand. What remains forbidden is what was forbidden then —
 * papering over the boundary with a bare `as TrustedChartSvg` cast at the
 * deserialising end. `adoptPackPagesDocument`
 * (`services/packs/pages/packDocumentWire.ts`) is the only client-side
 * consumer, and it holds no such cast.
 */
export type TrustedChartSvg = string & { readonly __trustedChartSvg: unique symbol };

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
 * something is not a chart we print.
 *
 * IT IS A GRAMMAR, NOT A SCAN (`svgGrammar.ts`). The string reaches
 * `dangerouslySetInnerHTML`, so the browser's HTML parser decides what it
 * means, and a regex over the string reads case, quoting, separators,
 * character references, comments, CDATA and `<text>` bodies differently from
 * it — every difference a bypass. The whole string must instead be consumed
 * by a strict tokenizer: one root `<svg>`, lowercase-exact elements and
 * attribute names from the lists zrender really emits, `name="value"` with
 * double quotes, text with only the five XML entities, CDATA only inside
 * `<style>`, no comments or doctypes or control characters. Values may carry
 * no scheme, `//`, `image-set(`, CSS escape or CSS comment, and every `url()`
 * is `url(#id)`. Anything unconsumed is refused. The denylisted constructs
 * (`<script>`, `<foreignObject>`, `<image>`, handlers, `href`) are still named
 * as external references, because that is what whoever hits one needs to hear.
 *
 * Exported so its positive controls can be tested directly: several of the
 * constructs it refuses (`<use>`, an event handler) are ones no ECharts option
 * can make zrender emit, so a test that could only go through renderChartSvg
 * would silently cover the guard's cheapest half.
 */
export function assertNoExternalReferences(svg: string): void {
  let styleBodies: string[];
  try {
    styleBodies = parseSvgGrammar(svg).styleBodies;
  } catch (err) {
    if (!(err instanceof SvgGrammarError)) throw err;
    if (err.reason.startsWith('EXTERNAL: ')) {
      throw new Error(`renderChartSvg: refusing a chart containing an external reference (${err.reason.slice(10)})`);
    }
    throw new Error(`renderChartSvg: refusing a chart whose markup is outside the grammar (${err.message})`);
  }
  // The bodies the grammar already extracted — one parser, one pass.
  checkStyleBodies(styleBodies);
}

/**
 * The `<style>` block, allow-listed rather than scanned.
 *
 * zrender emits one for every chart and interpolates `emphasis.itemStyle`
 * colours into it UNESCAPED. The block sits inside `<![CDATA[ … ]]>`, so it is
 * not text content and reaches the markup checks above — none of which look
 * for CSS. An inline SVG's stylesheet is DOCUMENT-scoped, so an injected
 * `@font-face` plus a `text { font-family: … }` rule makes Chromium fetch a
 * font while rendering the pack, and an injected `* { display:none }` blanks a
 * document going to a bank with no network involved at all.
 *
 * An allow-list, deliberately, and not a sixth forbidden pattern: this file
 * has been bitten three times by matching a pattern anywhere instead of where
 * it means something. zrender writes exactly one rule shape —
 * `.zr<hash>-<n>:hover { <simple declarations> }` — and anything else in there
 * was injected. Measured across every chart this repo draws: the waterfall
 * custom series, budget bullets, the cash-flow sankey, cash position, small
 * multiples, and a plain bar and line. If a future chart legitimately emits
 * another shape this throws, and the fix is to admit that exact shape here.
 *
 * Exported for the same reason as assertNoExternalReferences above.
 */
const HOVER_SELECTOR = /^\.zr[0-9a-z]+-\d+:hover$/;
/** A property and a value made of colour/keyword characters. No `:`, `;`,
 *  `{`, `}`, `/`, or quote can appear, so neither a nested rule nor a
 *  `url(https://…)` can hide in a declaration. */
const DECLARATION = /^[a-z-]+:[A-Za-z0-9#.,%()\s-]+$/;
/** zrender stringifies a GRADIENT object straight into the hover rule, so a
 *  legitimate gradient fill arrives as `fill:[object Object]`. Admitted as
 *  this exact literal rather than by adding `[` and `]` to the charset above:
 *  the alternative is refusing a real chart — a gradient area fill, or sankey
 *  links, which is a documented ECharts setting — and widening the charset
 *  would admit brackets in every value for the sake of one known artefact.
 *  The literal carries no CSS-active character, so admitting it costs
 *  nothing. */
const GRADIENT_LITERAL = /^[a-z-]+:\[object Object\]$/;

export function checkStyleBodies(bodies: readonly string[]): void {
  // The message names what it saw. This guard can fire on legitimate data —
  // it already did, on a gradient — and "unexpected declaration" alone sends
  // whoever hits it looking in the wrong place.
  const refuse = (why: string, found?: string): never => {
    const seen = found === undefined ? '' : `: ${JSON.stringify(found.slice(0, 80))}`;
    throw new Error(
      `renderChartSvg: refusing a chart whose <style> block is not the shape zrender emits (${why}${seen})`,
    );
  };

  for (const body of bodies) {
    const css = body.replace(/\]\]>$/, '');
    let cursor = 0;
    for (const rule of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      // Anything BETWEEN two rules is not a rule at all — a bare declaration,
      // a stray at-rule, or the tail of an injected one.
      const between = css.slice(cursor, rule.index).trim();
      if (between !== '') refuse('content outside a rule', between);
      cursor = rule.index + rule[0].length;

      const selector = (rule[1] ?? '').trim();
      if (!HOVER_SELECTOR.test(selector)) refuse('unexpected selector', selector);
      for (const declaration of (rule[2] ?? '').split(';')) {
        const text = declaration.trim();
        if (text === '') continue;
        if (!DECLARATION.test(text) && !GRADIENT_LITERAL.test(text)) refuse('unexpected declaration', text);
        // `(` and `)` are in the declaration charset for `rgb()`; a `url(`
        // there is a fetch unless it is exactly `url(#id)`.
        if (urlReferenceProblem(text) !== null) refuse('a url( that is not exactly url(#id)', text);
      }
    }
    const tail = css.slice(cursor).trim();
    if (tail !== '') refuse('trailing content after the last rule', tail);
  }
}

/** Parse and check the style bodies of one SVG. Kept for callers that hold
 *  only the string; `assertNoExternalReferences` does this itself in the same
 *  pass, so the guard pair never parses twice. */
export function assertStyleBlockIsOurs(svg: string): void {
  checkStyleBodies(parseSvgGrammar(svg).styleBodies);
}

/**
 * Re-brand a value that has crossed a JSON boundary.
 *
 * The ONLY sanctioned way to obtain a `TrustedChartSvg` from something that
 * was not produced by `renderChartSvg` in this process. It re-runs the guard
 * above — the same function, not a re-implementation — so a value
 * that merely LOOKS branded on the far side of `res.json()` is refused here
 * rather than reaching `dangerouslySetInnerHTML`.
 *
 * DELIBERATELY NOT a scan over the raw string. The guard is a grammar: it
 * reads text as text and attributes as attributes, so a customer name that
 * contains a URL aborts nothing. Adding a "safety net" regex over the raw
 * string here would reintroduce exactly that defect, and a second reading of
 * the markup that the browser's parser might disagree with.
 *
 * Takes `unknown`, because that is honestly what `JSON.parse` yields: the
 * non-string case is a real branch, not a formality — a chart field that
 * arrives as `null`, a number, or a nested object must fail loudly here
 * rather than be stringified into the page.
 */
export function adoptTrustedChartSvg(value: unknown): TrustedChartSvg {
  if (typeof value !== 'string') {
    throw new Error(
      `adoptTrustedChartSvg: refusing a ${value === null ? 'null' : typeof value} where chart markup was expected`,
    );
  }
  assertNoExternalReferences(value);
  return value as TrustedChartSvg;
}
