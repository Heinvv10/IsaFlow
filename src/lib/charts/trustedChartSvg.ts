/**
 * The brand a rendered chart SVG carries, the two guards that earn it, and the
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
 * two regex batteries over a string, and the type they hand out.
 *
 * `renderChartSvg` and `adoptTrustedChartSvg` call the SAME two guard
 * functions defined below — not two copies that could drift, which is the
 * whole point of the split being a move rather than a re-implementation.
 */

/**
 * A string that has passed `assertNoExternalReferences` and
 * `assertStyleBlockIsOurs` — which happens in exactly two places, both in
 * this file: `renderChartSvg` (in `ssrSvg.ts`, which calls the guards after
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
 * `adoptTrustedChartSvg` re-runs both guards on the deserialised value before
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
 * something is not a chart we print. A handful of checks over the rendered
 * MARKUP, deliberately not a parser — the legitimate output of this one code
 * path is narrow and known.
 *
 * Exported so its positive controls can be tested directly: several of the
 * constructs it refuses (`<use>`, an event handler) are ones no ECharts option
 * can make zrender emit, so a test that could only go through renderChartSvg
 * would silently cover the guard's cheapest half.
 */
export function assertNoExternalReferences(svg: string): void {
  // Positional, like the id rewrite above and for the same reason: a pattern
  // matched anywhere in the string is a pattern matched in DATA. Scanning the
  // raw markup for an absolute URL aborted a whole pack render on a customer
  // name containing one — and those arrive from Sage and bank imports. So the
  // text nodes go first, and what is checked is markup only. A URL sitting in
  // a text node fetches nothing; every actual fetch surface is an element or
  // an attribute, and all of them are below.
  const markup = svg
    // `<text>` bodies specifically, not every `>…<` run. A general strip
    // consumes `>` characters, and a `>` inside an ATTRIBUTE value (producible
    // — `textStyle.fontFamily: 'a>b'` renders `font-family:a>b;`) opens what
    // the regex reads as a text node, deleting every sibling attribute up to
    // the next `<`. The only false positive being excluded here is label text,
    // and label text lives in `<text>`; SSR emits no `<title>` or `<desc>`,
    // and the `<style>` CDATA is allow-listed separately below.
    //
    // The opening tag skips quoted sections for the same reason — `[^>]*`
    // would stop at that same attribute `>` and put the tail of the tag back
    // into the body.
    .replace(/(<text\b(?:"[^"]*"|'[^']*'|[^>"'])*>)[^<]*(<\/text>)/gi, '$1$2')
    .replace(/xmlns(:xlink)?="[^"]*"/g, '');
  const checks: Array<[RegExp, string]> = [
    [/<script\b/i, 'a script element'],
    [/<foreignObject\b/i, 'a foreignObject'],
    [/<image\b/i, 'an image element'],
    [/\son[a-z]+\s*=/i, 'an event-handler attribute'],
    [/\b(?:xlink:)?href\s*=/i, 'an href'],
  ];
  for (const [pattern, what] of checks) {
    if (pattern.test(markup)) {
      throw new Error(`renderChartSvg: refusing a chart containing an external reference (${what})`);
    }
  }
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

export function assertStyleBlockIsOurs(svg: string): void {
  // The message names what it saw. This guard can fire on legitimate data —
  // it already did, on a gradient — and "unexpected declaration" alone sends
  // whoever hits it looking in the wrong place.
  const refuse = (why: string, found?: string): never => {
    const seen = found === undefined ? '' : `: ${JSON.stringify(found.slice(0, 80))}`;
    throw new Error(
      `renderChartSvg: refusing a chart whose <style> block is not the shape zrender emits (${why}${seen})`,
    );
  };

  for (const block of svg.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)) {
    const css = (block[1] ?? '').replace(/<!\[CDATA\[/, '').replace(/\]\]>/, '');
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
      }
    }
    const tail = css.slice(cursor).trim();
    if (tail !== '') refuse('trailing content after the last rule', tail);
  }
}

/**
 * Re-brand a value that has crossed a JSON boundary.
 *
 * The ONLY sanctioned way to obtain a `TrustedChartSvg` from something that
 * was not produced by `renderChartSvg` in this process. It re-runs the two
 * guards above — the same functions, not a re-implementation — so a value
 * that merely LOOKS branded on the far side of `res.json()` is refused here
 * rather than reaching `dangerouslySetInnerHTML`.
 *
 * DELIBERATELY NOT a blacklist scan over the whole SVG string. Both guards
 * are POSITIONAL, and this file has been bitten four times by matching a
 * pattern anywhere in a document instead of where it carries meaning — once
 * aborting a whole pack render on a customer name containing a URL. Adding a
 * "safety net" regex over the raw string here would reintroduce exactly that
 * defect on data the guards were carefully taught to leave alone.
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
  assertStyleBlockIsOurs(value);
  return value as TrustedChartSvg;
}
