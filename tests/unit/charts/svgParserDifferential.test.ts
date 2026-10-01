/**
 * THE GUARD AND THE BROWSER MUST READ THE SAME STRING THE SAME WAY.
 *
 * The chart SVG reaches `dangerouslySetInnerHTML`, so the browser's HTML
 * parser — not the guard's regexes — decides what it contains. Each case here
 * is something an HTML parser reads differently from a regex over the string
 * (case, quoting, separators, character references, comments, CDATA, breakouts
 * from SVG foreign content, unterminated `<text>`, control characters) and
 * each must be REFUSED. The guard is a fail-closed grammar, so none of them is
 * a pattern anyone had to think of.
 */
import { describe, expect, it } from 'vitest';
import { assertNoExternalReferences } from '@/lib/charts/trustedChartSvg';
import { adoptTrustedChartSvg } from '@/lib/charts/ssrSvg';

const NS = 'xmlns="http://www.w3.org/2000/svg"';
const svg = (body: string) => `<svg ${NS}>${body}</svg>`;

const BREAKERS: Array<[string, string]> = [
  // case
  ['an uppercase script element', svg('<SCRIPT>alert(1)</SCRIPT>')],
  ['a mixed-case script element', svg('<ScRiPt>alert(1)</ScRiPt>')],
  ['an uppercase handler attribute', svg('<g ONLOAD="alert(1)"></g>')],
  ['a mixed-case handler attribute', svg('<rect OnClick="alert(1)"/>')],
  ['an uppercase root', `<SVG ${NS}></SVG>`],
  // quoting
  ['an unquoted attribute value', svg('<rect x=1 y=2/>')],
  ['an unquoted handler', svg('<rect x=1 onload=alert(1)>')],
  ['a single-quoted attribute value', svg("<rect x='1'/>")],
  ['a single-quoted handler', svg("<g onload='alert(1)'></g>")],
  // separators
  ['attributes separated by a slash', svg('<rect x="1"/y="2"/>')],
  ['attributes with no separator', svg('<rect x="1"y="2"/>')],
  ['a slash straight after the tag name', svg('<g/onload="alert(1)"></g>')],
  ['a tab as the attribute separator', svg('<rect\tx="1"/>')],
  ['two spaces between attributes', svg('<rect x="1"  y="2"/>')],
  ['a space around the equals sign', svg('<rect x = "1"/>')],
  // character references
  ['a numeric reference in an attribute name', svg('<g &#111;nload="alert(1)"></g>')],
  ['a hex reference in a handler value scheme', svg('<rect fill="jav&#x61;script:alert(1)"/>')],
  ['an encoded colon in a scheme', svg('<rect fill="https&#58;//evil.example/a"/>')],
  ['an entity that is not one of the five', svg('<text>&copy; &#x3c;script&#x3e;</text>')],
  ['a bare ampersand in text', svg('<text>Smith & Co</text>')],
  ['a bare ampersand in a value', svg('<rect fill="a&b"/>')],
  ['an encoded < in an attribute name position', svg('<g &lt;x="1"></g>')],
  // comments, cdata, PIs, doctype
  ['a comment', svg('<!-- hidden -->')],
  ['a comment that hides a tag from a text strip', svg('<!--<text>--><script>x</script><!--</text>-->')],
  ['a CDATA section outside style', svg('<text><![CDATA[<script>x</script>]]></text>')],
  ['a CDATA section in a group', svg('<g><![CDATA[x]]></g>')],
  ['a processing instruction', svg('<?xml-stylesheet href="https://evil.example/s.css"?>')],
  ['a doctype', `<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>${svg('')}`],
  // text hiding markup
  ['an unterminated text element', svg('<text x="1">hello<script>alert(1)</script>')],
  ['a nested text element hiding markup', svg('<text><text>a</text><script>alert(1)</script></text>')],
  ['markup inside a text element', svg('<text>a<script>alert(1)</script>b</text>')],
  ['a text element with a > in its open tag hiding a handler', svg('<text data="a>" onload="alert(1)">x</text>')],
  // structure
  ['markup after the closing svg', `${svg('')}<script>alert(1)</script>`],
  ['a second root', `${svg('')}${svg('')}`],
  ['a nested svg', svg(svg(''))],
  ['text outside the root', `hello${svg('')}`],
  ['a mismatched close tag', svg('<g><rect/></path></g>')],
  ['an unclosed group', svg('<g><rect/>').replace('</svg>', '')],
  ['an end tag with attributes', svg('<g></g x="1">')],
  ['text directly inside a group', svg('<g>hello</g>')],
  // HTML breakouts from SVG foreign content
  ['a p element', svg('<p>x</p><script>alert(1)</script>')],
  ['a br element', svg('<br><img src=x onerror=alert(1)>')],
  ['an img element', svg('<img src="https://evil.example/a.png">')],
  ['a table element', svg('<table><tr><td>x</td></tr></table>')],
  ['a font element with a colour', svg('<font color="red">x</font>')],
  ['an iframe element', svg('<iframe src="https://evil.example"></iframe>')],
  ['a title element carrying markup', svg('<title><img src=x onerror=alert(1)></title>')],
  ['a desc element carrying markup', svg('<desc><script>x</script></desc>')],
  ['a math element', svg('<math><mi>x</mi></math>')],
  // style
  ['a style whose body breaks out with </style>', svg('<style><![CDATA[.zr1-0:hover{fill:#000}]]></style><script>x</script>')],
  ['a style body outside CDATA', svg('<style>.zr1-0:hover{fill:#000}</style>')],
  ['a style with @import', svg('<style><![CDATA[@import url(https://evil.example/x.css);]]></style>')],
  ['a style with a url(', svg('<style><![CDATA[.zr1-0:hover{fill:url(https://evil.example/a)}]]></style>')],
  ['a style CDATA that never closes', svg('<style><![CDATA[.zr1-0:hover{fill:#000}</style><script>x</script>')],
  ['a style CDATA containing a tag', svg('<style><![CDATA[<script>x</script>]]></style>')],
  // control characters and obfuscation
  ['a null byte in a tag name', svg('<scr\u0000ipt>x</scr\u0000ipt>')],
  ['a null byte in an attribute value', svg('<rect fill="a\u0000b"/>')],
  ['a vertical tab in text', svg('<text>a\u000bb</text>')],
  ['a unicode line separator in a value', svg('<rect fill="a b"/>')],
  ['a CSS escape hiding url(', svg('<rect style="fill:u\\72l(https://evil.example/a)"/>')],
  ['a CSS comment inside a value', svg('<rect style="fill:ur/**/l(#a)"/>')],
  ['an attribute value with a raw < in it', svg('<rect fill="a<b"/>')],
  ['an attribute name outside the allowlist', svg('<rect data-x="1"/>')],
  ['an href attribute', svg('<rect href="#a"/>')],
  ['an xlink:href attribute', svg('<rect xlink:href="#a"/>')],
  ['a src attribute', svg('<rect src="#a"/>')],
  ['a duplicate attribute', svg('<rect x="1" x="2"/>')],
  ['a leading BOM', `﻿${svg('')}`],
];

const ROUND3: Array<[string, string]> = [
  ['an unterminated url( with a tab-split //', svg("<rect style=\"background-image:url('/\t/evil.example/b.png'\"/>")],
  ['an unterminated url( with a newline-split //', svg("<rect style=\"mask-image:url('/\n/evil.example/b.png'\"/>")],
  ['a tab inside any value', svg('<rect fill="#0\t00"/>')],
  ['a CR inside any value', svg('<rect fill="#0\r00"/>')],
  ['an unterminated url(', svg('<rect fill="url(#a"/>')],
  ['an unterminated relative url(', svg('<rect style="background:url(/x.png"/>')],
  ['an uppercase URL(', svg('<rect style="background:URL(x.png)"/>')],
  ['a CSS-escaped u\\72l(', svg('<rect style="background:u\\72l(x.png)"/>')],
  ['a url followed by a space before the paren', svg('<rect style="background:url (x.png)"/>')],
  ['a second, non-id url( beside a valid one', svg('<rect style="fill:url(#a);background:url(x.png)"/>')],
  ['url( in a style body declaration', svg('<style><![CDATA[.zr1-0:hover{background:url(x)}]]></style>')],
  ['an unterminated url( in a style body', svg('<style><![CDATA[.zr1-0:hover{background:url(#a}]]></style>')],
  ['a style attribute on the root', `<svg ${NS} style="position:fixed;inset:0"></svg>`],
  ['a class attribute on the root', `<svg ${NS} class="fixed inset-0"></svg>`],
];

describe('round 3 breakers', () => {
  for (const [what, markup] of ROUND3) {
    it(`refuses ${what}`, () => {
      expect(() => assertNoExternalReferences(markup)).toThrow();
      expect(() => adoptTrustedChartSvg(markup)).toThrow();
    });
  }
  it('still admits url(#id) with its paren, in a value and in a style body', () => {
    expect(() => assertNoExternalReferences(svg('<g clip-path="url(#zr1-0)"><path d="M0 0"/></g>'))).not.toThrow();
    expect(() => assertNoExternalReferences(svg('<style><![CDATA[.zr1-0:hover{fill:url(#zr1-g0)}]]></style>'))).not.toThrow();
  });
});

describe('every parser-differential breaker is refused', () => {
  for (const [what, markup] of BREAKERS) {
    it(`refuses ${what}`, () => {
      expect(() => assertNoExternalReferences(markup)).toThrow();
    });
  }
  it('refuses them through adoptTrustedChartSvg too', () => {
    for (const [, markup] of BREAKERS) expect(() => adoptTrustedChartSvg(markup)).toThrow();
  });
});
