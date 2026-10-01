/**
 * THE CHART SVG GRAMMAR — a fail-closed tokenizer, not a scan.
 *
 * The SVG reaches `dangerouslySetInnerHTML`, so the browser's HTML parser, not
 * this module, decides what the string means. A guard that searches the string
 * for bad things loses to anything the two read differently: case, quoting,
 * separators, character references, comments, CDATA, breakouts from SVG
 * foreign content, an unterminated `<text>` hiding markup from a strip. So
 * instead of recognising bad input this recognises GOOD input, and the whole
 * string must be consumed by it:
 *
 *   document  = ws? svg ws?
 *   element   = "<" NAME ((" " ATTR)* | " ") ("/>" | ">" content "</" NAME ">")
 *   ATTR      = ANAME '="' VALUE '"'            (double quotes, one space, no repeats)
 *   content   = (ws | element)*                 (a `text` element holds TEXT only)
 *             | CDATA                           (a `style` element only)
 *   TEXT      = chars without "<", "&" only as one of five entities
 *
 * NAME and ANAME are exact, lowercase-where-zrender-is, and drawn from the
 * lists below — which are what zrender really emits for every chart this repo
 * draws (`ssrSvgElementAllowlist.test.ts` enumerates the real output against them). There
 * are no comments, processing instructions, doctypes, control characters or
 * CDATA sections outside `<style>`, and no second root.
 *
 * Values are checked on top: no reference of any kind (scheme, `//`,
 * `image-set(`, CSS escape or comment), and every `url(…)` is `url(#id)`.
 * The only exempt values are the two exact `xmlns` declarations.
 */

/** Elements zrender emits, plus the gradient trio. Case-sensitive. */
export const ELEMENTS: ReadonlySet<string> = new Set([
  'svg', 'g', 'defs', 'clipPath', 'rect', 'path', 'text', 'style',
  'linearGradient', 'radialGradient', 'stop',
]);

/** Attributes zrender emits on those elements. Deliberately without `href`,
 *  `xlink:href`, `src`, `style`-adjacent URL carriers or any `on*` handler. */
export const ATTRIBUTES: ReadonlySet<string> = new Set([
  'xmlns', 'xmlns:xlink', 'version', 'baseProfile', 'width', 'height', 'viewBox',
  'x', 'y', 'rx', 'ry', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'd', 'transform', 'id', 'class',
  'offset', 'gradientUnits', 'gradientTransform', 'stop-color', 'stop-opacity',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap',
  'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'opacity',
  'clip-path', 'pointer-events', 'style', 'dominant-baseline', 'text-anchor', 'xml:space',
  'font-family', 'font-size', 'font-weight', 'font-style', 'paint-order',
  'ecmeta_data_index', 'ecmeta_series_index', 'ecmeta_silent', 'ecmeta_ssr_type',
]);

/** What zrender writes on the ROOT `<svg>` and nothing else: no `style`, no
 *  `class`, so a chart cannot position itself over the page or borrow the
 *  app's utility classes. */
export const ROOT_ATTRIBUTES: ReadonlySet<string> = new Set([
  'width', 'height', 'xmlns', 'xmlns:xlink', 'version', 'baseProfile', 'viewBox',
]);

/** The largest root width or height admitted, in px. The biggest real chart is
 *  ~650 x 420; this leaves headroom without letting a chart size itself to the
 *  page (`100vw`) or past it (`100000`). */
export const ROOT_MAX_PX = 2000;

const XMLNS: Readonly<Record<string, string>> = {
  xmlns: 'http://www.w3.org/2000/svg',
  'xmlns:xlink': 'http://www.w3.org/1999/xlink',
};

/** `&` only as one of these. `&#39;` is what zrender writes for an apostrophe. */
const ENTITY = /&(?:amp|lt|gt|quot|apos|#39);/y;
/** Tab, LF and CR are whitespace; every other control character is refused. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\ufeff\ufffe\uffff]/;

export class SvgGrammarError extends Error {
  constructor(readonly reason: string, readonly at: number) {
    super(`${reason} (at offset ${at})`);
    this.name = 'SvgGrammarError';
  }
}

const fail = (reason: string, at: number): never => { throw new SvgGrammarError(reason, at); };

/** A tag the grammar cannot read. Refused either way; but where the unreadable
 *  part is a handler or an href in a spelling a browser WOULD read (`<g/onload=…>`,
 *  `x="1"onclick=…`, `href = …`), say so, because that is what to look for. */
function malformed(svg: string, tagStart: number, reason: string, at: number): never {
  const tag = svg.slice(tagStart, Math.max(svg.indexOf('>', at), at) + 1);
  const hostile = /[\s"'/](on[a-z]+)\s*=/i.exec(tag) ?? /[\s"'/]((?:xlink:)?href)\s*=/i.exec(tag);
  if (hostile) fail(`EXTERNAL: ${/^on/i.test(hostile[1]!) ? 'an event-handler attribute' : 'an href'} "${hostile[1]}" in an unreadable tag`, at);
  return fail(reason, at);
}

/** Text or an attribute value: no `&` except the five entities, no `<`. */
function checkCharacters(s: string, at: number, what: string, allowGt: boolean): void {
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '<') fail(`a "<" in ${what}`, at + i);
    if (c === '>' && !allowGt) fail(`a ">" in ${what}`, at + i);
    if (c === '&') {
      ENTITY.lastIndex = i;
      if (!ENTITY.test(s)) fail(`a character reference in ${what} other than the five XML entities`, at + i);
    }
  }
}

/**
 * EVERY `url(` MUST BE EXACTLY `url(#id)`, WITH ITS PAREN. CSS closes an
 * unterminated `url(` at the end of the value, so checking only closed ones
 * let `url('/<TAB>/evil.example/b.png'` through. Count the openers loosely
 * (any case, whitespace before the paren) and the strict matches exactly; a
 * surplus is a reference the strict form does not account for.
 */
export function urlReferenceProblem(value: string): string | null {
  const openers = value.match(/url\s*\(/gi)?.length ?? 0;
  const strict = value.match(/url\(#[A-Za-z0-9_-]+\)/gi)?.length ?? 0;
  return openers === strict ? null : 'a url( that is not exactly url(#id)';
}

/** A value may not carry a reference of any kind. */
function checkValue(name: string, value: string, at: number): void {
  if (name in XMLNS) {
    if (value !== XMLNS[name]) fail(`an ${name} declaration that is not the standard one`, at);
    return;
  }
  checkCharacters(value, at, `the value of "${name}"`, true);
  // The URL parser strips tab, CR and LF from anywhere in a URL, so `/<TAB>/`
  // is `//`. No whitespace control has any business in a chart value.
  if (/[\t\r\n]/.test(value)) fail(`EXTERNAL: a tab, CR or LF in the value of "${name}"`, at);
  if (/\\|\/\*|image-set\s*\(|\b(?:https?|data|javascript|file|ftp|vbscript):|\/\//i.test(value)) {
    fail(`EXTERNAL: ${JSON.stringify(value.slice(0, 60))} — a reference, CSS escape or CSS comment in "${name}"`, at);
  }
  const urlProblem = urlReferenceProblem(value);
  if (urlProblem) fail(`EXTERNAL: ${urlProblem} in "${name}"`, at);
}

export interface SvgGrammarResult {
  /** Every `<style>` body, for `checkStyleBodies` — the one place CSS is read. */
  styleBodies: string[];
}

export function parseSvgGrammar(svg: string): SvgGrammarResult {
  const control = CONTROL.exec(svg);
  if (control) fail('a control character', control.index);

  const stack: string[] = [];
  const styleBodies: string[] = [];
  let i = 0;
  let closedRoot = false;
  const n = svg.length;

  const skipWs = (): void => { while (i < n && /[ \t\n\r]/.test(svg[i]!)) i++; };
  skipWs();
  if (!svg.startsWith('<svg', i)) fail('the document does not begin with <svg', i);

  while (i < n) {
    if (svg[i] !== '<') {
      // A text node.
      const end = svg.indexOf('<', i);
      const text = svg.slice(i, end === -1 ? n : end);
      const parent = stack[stack.length - 1];
      if (parent === 'text') {
        checkCharacters(text, i, 'text', true);
      } else if (!/^[ \t\n\r]*$/.test(text)) {
        fail(`text outside a <text> element`, i);
      }
      i += text.length;
      continue;
    }
    if (closedRoot) fail('markup after the closing </svg>', i);

    if (svg.startsWith('<![CDATA[', i)) {
      if (stack[stack.length - 1] !== 'style') fail('a CDATA section outside <style>', i);
      const end = svg.indexOf(']]>', i + 9);
      if (end === -1) fail('a CDATA section that never closes', i);
      const body = svg.slice(i + 9, end);
      if (body.includes('<')) fail('a "<" inside the style body', i);
      styleBodies.push(body);
      i = end + 3;
      continue;
    }
    if (svg[i + 1] === '/') {
      const m = /^<\/([A-Za-z][A-Za-z0-9]*)>/.exec(svg.slice(i, i + 40));
      if (!m) fail('a malformed end tag', i);
      if (m![1] !== stack[stack.length - 1]) fail(`an end tag </${m![1]}> that does not match its start tag`, i);
      stack.pop();
      i += m![0].length;
      if (stack.length === 0) closedRoot = true;
      continue;
    }

    const nameMatch = /^<([A-Za-z][A-Za-z0-9]*)/.exec(svg.slice(i, i + 40));
    if (!nameMatch) fail('a "<" that does not begin an element (comment, doctype, processing instruction or stray)', i);
    const name = nameMatch![1]!;
    const tagStart = i;
    i += nameMatch![0].length;

    const seen = new Set<string>();
    const attrs: Array<[string, string, number]> = [];
    for (;;) {
      if (svg[i] === '>' || svg.startsWith('/>', i)) break;
      // zrender writes an attribute-less element as `<defs >`: one space, and
      // only where there is nothing else in the tag.
      if (svg.startsWith(' >', i) && attrs.length === 0) { i++; break; }
      if (svg[i] !== ' ') malformed(svg, tagStart, `an attribute not separated by exactly one space in <${name}>`, i);
      i++;
      const a = /^([A-Za-z_:][A-Za-z0-9_:.-]*)="/.exec(svg.slice(i, i + 80));
      if (!a) malformed(svg, tagStart, `an attribute that is not name="value" in <${name}>`, i);
      const attr = a![1]!;
      const valueStart = i + a![0].length;
      const valueEnd = svg.indexOf('"', valueStart);
      if (valueEnd === -1) fail('an attribute value that never closes', valueStart);
      if (seen.has(attr)) fail(`a duplicate attribute "${attr}"`, i);
      seen.add(attr);
      attrs.push([attr, svg.slice(valueStart, valueEnd), valueStart]);
      i = valueEnd + 1;
    }

    // Judge the element only after its attributes parsed, so a hostile
    // attribute is named for what it is rather than as a stray element.
    for (const [attr, , at] of attrs) {
      if (/^on/i.test(attr)) fail(`EXTERNAL: an event-handler attribute "${attr}"`, at);
      if (/^(?:xlink:)?href$/i.test(attr)) fail(`EXTERNAL: an href "${attr}"`, at);
    }
    if (/^(?:script|foreignobject|image)$/i.test(name)) fail(`EXTERNAL: a ${name} element`, tagStart);
    if (!ELEMENTS.has(name)) fail(`an element outside the allow-list (<${name}>)`, tagStart);
    for (const [attr, value, at] of attrs) {
      if (name === 'svg' && !ROOT_ATTRIBUTES.has(attr)) fail(`an attribute "${attr}" on the root <svg>`, at);
      if (name === 'svg' && (attr === 'width' || attr === 'height')
        && !(/^\d+(\.\d+)?(px)?$/.test(value) && parseFloat(value) <= ROOT_MAX_PX && parseFloat(value) > 0)) {
        fail(`a root ${attr} of ${JSON.stringify(value.slice(0, 20))}: a plain number of px, at most ${ROOT_MAX_PX}`, at);
      }
      if (!ATTRIBUTES.has(attr)) fail(`an attribute "${attr}" outside the allow-list`, at);
      checkValue(attr, value, at);
    }
    if (name === 'svg' && stack.length > 0) fail('a nested <svg>', tagStart);
    if (name !== 'svg' && stack.length === 0) fail('an element outside the root <svg>', tagStart);
    if (stack[stack.length - 1] === 'text' || stack[stack.length - 1] === 'style') {
      fail(`an element inside <${stack[stack.length - 1]}>`, tagStart);
    }

    if (svg.startsWith('/>', i)) {
      i += 2;
      if (stack.length === 0) closedRoot = true;
    } else {
      i += 1;
      stack.push(name);
    }
  }
  if (stack.length > 0) fail(`<${stack[stack.length - 1]}> is never closed`, n);
  if (!closedRoot) fail('no root <svg>', n);
  return { styleBodies };
}
