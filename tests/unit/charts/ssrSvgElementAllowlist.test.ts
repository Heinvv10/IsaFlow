/**
 * THE CHART GUARD IS AN ALLOWLIST OF ELEMENTS, NOT ONLY A DENYLIST.
 *
 * The denylist (script, foreignObject, image, handlers, href) refuses what
 * someone thought of. `<use>`, `<animate>`, `<animateTransform>`, `<set>` and
 * `<a>` are the SVG constructs that can load, navigate or rewrite an
 * attribute to a URL and were not on it; `url(https://…)` in a `style` or
 * presentation attribute fetches with no element involved at all. The real
 * output of every pack chart is a narrow, known element set, so anything
 * outside it is refused.
 */
import { describe, expect, it } from 'vitest';
import { assertNoExternalReferences } from '@/lib/charts/trustedChartSvg';
import { ATTRIBUTES } from '@/lib/charts/svgGrammar';
import { adoptTrustedChartSvg } from '@/lib/charts/ssrSvg';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { brightsphereInput, demoInput } from '../services/packs/fixtures/boardPackInputs';
import { liveDemoRenderedInput } from '../services/packs/fixtures/liveDemoBoardPack';

const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`;

describe('elements outside the allowlist are refused', () => {
  const HOSTILE: Array<[string, string, RegExp]> = [
    ['a use element with no href', '<use x="1"/>', /allow-list \(<use>\)/],
    ['an animate element', '<rect><animate attributeName="x" to="9"/></rect>', /allow-list \(<animate>\)/],
    ['an animateTransform element', '<g><animateTransform attributeName="transform" to="1"/></g>', /allow-list \(<animateTransform>\)/],
    ['a set element', '<rect><set attributeName="fill" to="red"/></rect>', /allow-list \(<set>\)/],
    ['an anchor element', '<a><text>x</text></a>', /allow-list \(<a>\)/],
    ['an uppercase USE', '<USE x="1"/>', /allow-list \(<USE>\)/],
    ['an element after an early </style>', '<style><![CDATA[.zr1-0:hover{fill:#000}]]></style><use x="1"/>', /allow-list \(<use>\)/],
    ['a comment that could hide an element', '<!-- <use x="1"/> -->', /comment, doctype, processing instruction/],
  ];
  for (const [what, body, message] of HOSTILE) {
    it(`refuses ${what}`, () => {
      expect(() => assertNoExternalReferences(svg(body))).toThrow(message);
    });
  }
});

describe('url() must be a same-document reference', () => {
  it('refuses an external url in a style attribute', () => {
    expect(() => assertNoExternalReferences(svg('<rect style="fill:url(https://evil.example/p.svg#a)"/>')))
      .toThrow(/external reference.*url/i);
  });
  it('refuses an external url in a presentation attribute', () => {
    expect(() => assertNoExternalReferences(svg('<rect fill="url(//evil.example/p.svg#a)"/>')))
      .toThrow(/external reference.*url/i);
  });
  it('refuses a data: url', () => {
    expect(() => assertNoExternalReferences(svg('<rect style="fill:url(data:image/svg+xml;base64,AAAA)"/>')))
      .toThrow(/external reference.*url/i);
  });
  it('admits the same-document clip reference zrender writes', () => {
    expect(() => assertNoExternalReferences(svg('<defs><clipPath id="zr1-0"><rect/></clipPath></defs><g clip-path="url(#zr1-0)"><path d="M0 0"/></g>')))
      .not.toThrow();
  });
  it('does not read a url sitting in label text', () => {
    expect(() => assertNoExternalReferences(svg('<text>see url(https://acme.example/inv)</text>'))).not.toThrow();
  });
});

describe('handlers at any attribute boundary', () => {
  it.each([
    ['after a slash', '<svg/onload="alert(1)"></svg>'],
    ['straight after a closing quote', '<rect x="1"onload="alert(1)"/>'],
    ['after a single quote', "<rect x='1'onclick='alert(1)'/>"],
  ])('refuses a handler %s', (_what, markup) => {
    expect(() => assertNoExternalReferences(markup.startsWith('<svg') ? markup : svg(markup)))
      .toThrow(/event-handler attribute/);
  });
  it('does not read an attribute that merely begins with "on" inside a value', () => {
    expect(() => assertNoExternalReferences(svg('<g id="onion"><path d="M0 0"/></g>'))).not.toThrow();
  });
});

describe('no reference of any kind inside an attribute value', () => {
  it.each([
    ['image-set() in a style', '<rect style="fill:image-set(\'https://x\' 1x)"/>'],
    ['image-set() with no scheme', '<rect style="background:image-set(a 1x)"/>'],
    ['an https scheme in a presentation attribute', '<rect fill="https://evil.example/a.svg#f"/>'],
    ['a data: scheme', '<rect style="mask:data:image/svg+xml;base64,AAAA"/>'],
    ['a javascript: scheme', '<rect fill="javascript:alert(1)"/>'],
    ['a protocol-relative reference', '<rect style="cursor://evil.example/c"/>'],
  ])('refuses %s', (_what, body) => {
    expect(() => assertNoExternalReferences(svg(body))).toThrow(/external reference/i);
  });
});

describe('the gradient elements the allowlist admits', () => {
  it('passes a linear and a radial gradient referenced by url(#id)', () => {
    const body = '<defs><linearGradient id="zr1-0"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient>'
      + '<radialGradient id="zr1-1"><stop offset="0" stop-color="#fff"/></radialGradient></defs>'
      + '<path d="M0 0L1 1" fill="url(#zr1-0)"/><rect fill="url(#zr1-1)"/>';
    expect(() => assertNoExternalReferences(svg(body))).not.toThrow();
  });
});

describe('every chart the board pack produces passes', () => {
  function walk(v: unknown, out: string[]): void {
    if (typeof v === 'string') { if (v.startsWith('<svg')) out.push(v); }
    else if (Array.isArray(v)) v.forEach((x) => walk(x, out));
    else if (v && typeof v === 'object') Object.values(v).forEach((x) => walk(x, out));
  }

  it('draws only the elements the allowlist names, and every one is adopted', () => {
    const seen = new Set<string>();
    let charts = 0;
    for (const input of [demoInput, brightsphereInput, liveDemoRenderedInput]) {
      const svgs: string[] = [];
      walk(buildBoardPackPages(input).pages, svgs);
      for (const chart of svgs) {
        charts++;
        expect(() => adoptTrustedChartSvg(chart)).not.toThrow();
        const stripped = chart.replace(/(<text\b(?:"[^"]*"|'[^']*'|[^>"'])*>)[^<]*(<\/text>)/gi, '$1$2');
        for (const m of stripped.matchAll(/<([a-zA-Z][\w:.-]*)/g)) seen.add(m[1]!);
      }
    }
    expect(charts, 'no chart was produced, so nothing was tested').toBeGreaterThan(20);
    expect([...seen].sort()).toEqual(['clipPath', 'defs', 'g', 'path', 'rect', 'style', 'svg', 'text']);
  });

  it('uses only attribute names the grammar lists, and lists none that carry a reference', () => {
    const names = new Set<string>();
    for (const input of [demoInput, brightsphereInput, liveDemoRenderedInput]) {
      const svgs: string[] = [];
      walk(buildBoardPackPages(input).pages, svgs);
      for (const chart of svgs) {
        const stripped = chart.replace(/(<text\b(?:"[^"]*"|'[^']*'|[^>"'])*>)[^<]*(<\/text>)/gi, '$1$2');
        for (const m of stripped.matchAll(/\s([A-Za-z_:][\w:.-]*)="/g)) names.add(m[1]!);
      }
    }
    expect([...names].sort()).toEqual([
      'baseProfile', 'class', 'clip-path', 'd', 'dominant-baseline', 'ecmeta_data_index', 'ecmeta_series_index',
      'ecmeta_silent', 'ecmeta_ssr_type', 'fill', 'fill-opacity', 'height', 'id', 'pointer-events', 'stroke',
      'stroke-linecap', 'stroke-linejoin', 'stroke-width', 'style', 'text-anchor', 'transform', 'version',
      'viewBox', 'width', 'x', 'xml:space', 'xmlns', 'xmlns:xlink', 'y',
    ]);
    for (const name of names) expect(ATTRIBUTES.has(name), name).toBe(true);
    for (const forbidden of ['href', 'xlink:href', 'src', 'onload', 'onclick', 'onerror']) {
      expect(ATTRIBUTES.has(forbidden), forbidden).toBe(false);
    }
  });
});
