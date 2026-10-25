// @vitest-environment happy-dom
// describeTargets names a node by where it sits, in terms that survive a rebuild and a data change: the nearest
// anchor and the tags/names between it and the node. Never classes, :nth-child, generated ids or values.
import { beforeEach, describe, expect, it } from 'vitest';
import { describeTargets } from '../../e2e/golden-paths/helpers/a11yDescribe';

const one = (selector: string) => describeTargets([[selector]])[0];
const page = (html: string) => { document.body.innerHTML = html; };

beforeEach(() => { document.body.innerHTML = ''; });

describe('describeTargets', () => {
  it('stops at the nearest landmark and names inputs by name and type', () => {
    page('<div><main><form><div class="mt-6 text-center"><input name="taxRate" type="number"></div></form></main></div>');
    expect(one('input')).toBe('form > div > input[name="taxRate"][type="number"]');
  });

  it('never emits classes or :nth-child, so rows and restyles do not change the key', () => {
    page('<table><tbody><tr class="a"><td><a class="hover:x" href="/x">1</a></td></tr><tr class="b"><td><a class="hover:y" href="/x">2</a></td></tr></tbody></table>');
    const [first, second] = describeTargets([['tr:nth-child(1) a'], ['tr:nth-child(2) a']]);
    expect(first).toBe('table > tbody > tr > td > a[href="/x"]');
    expect(second).toBe(first);
    expect(first).not.toMatch(/nth|\.[a-z]/);
  });

  it('anchors on a stable id or a data-testid, and ignores a generated id', () => {
    page('<div id="invoice-form"><span data-testid="tot"><b>1</b></span></div><div id=":r1a:"><i>x</i></div><div id="radix-:r3:-trigger"><u>y</u></div>');
    expect(one('b')).toBe('span[data-testid="tot"] > b');
    expect(one('span')).toBe('span[data-testid="tot"]');
    expect(one('i')).toBe('body > div > i'); // no anchor in sight: climbs to body
    expect(one('u')).not.toContain('radix');
  });

  it('ignores ids a library or a database made up, even when they look like names', () => {
    page('<main><div id="headlessui-menu-button-12"><b>1</b></div><div id="radix-r3-trigger"><i>2</i></div><div id="row-98765"><u>3</u></div>'
      + '<div id="a1b2c3d4-0000-4000-8000-000000000000"><s>4</s></div><div id="invoice-form"><em>5</em></div></main>');
    expect(describeTargets([['b'], ['i'], ['u'], ['s'], ['em']])).toEqual([
      'main > div > b', 'main > div > i', 'main > div > u', 'main > div > s', 'div#invoice-form > em',
    ]);
  });

  it('anchors on a labelled container (a named list), but not on a control\'s own aria-label', () => {
    page('<main><section><div><ul aria-label="Auto-post runs"><li><button type="button">Undo</button></li></ul></div></section></main>'
      + '<div><div><button aria-label="Close" type="button"><b>x</b></button></div></div>');
    expect(one('li > button')).toBe('ul[aria-label="Auto-post runs"] > li > button[type="button"]'); // no copy: it is a list row
    expect(one('b')).toBe('body > div > div > button[type="button"][aria-label="Close"] > b');
  });

  it('collapses ids in hrefs and drops the query string', () => {
    page('<nav><a href="/accounting/customers/0b2f3c4d-1111-4222-8333-444455556666?tab=a">x</a><a href="/invoices/1234">y</a></nav>');
    expect(describeTargets([['nav > a:nth-child(1)'], ['nav > a:nth-child(2)']])).toEqual([
      'nav > a[href="/accounting/customers/:id"]{x}', 'nav > a[href="/invoices/:id"]{y}',
    ]);
  });

  it('keeps aria-label and role, and not the value', () => {
    page('<div role="dialog"><button aria-label="Close" type="button">x</button><input value="2026-09-01" type="date"></div>');
    expect(one('button')).toBe('div[role="dialog"] > button[type="button"][aria-label="Close"]{x}');
    expect(one('input')).toBe('div[role="dialog"] > input[type="date"]');
  });

  it('describes the document itself as html', () => {
    expect(one('html')).toBe('html');
  });

  it('gives up after six levels rather than printing a whole tree', () => {
    page('<div><div><div><div><div><div><div><p>deep</p></div></div></div></div></div></div></div>');
    expect(one('p').split(' > ')).toHaveLength(6);
  });

  it('names a short leaf by its copy, with digits normalised, but not row data', () => {
    page('<main><div><button type="button">Create Invoice</button><a href="/z">13 tasks remaining</a><p>' + 'x'.repeat(31) + '</p><div><b>nested</b> text</div></div>'
      + '<table><tbody><tr><td><span>ACME Ltd</span></td></tr></tbody></table><ul><li><button>Row action</button></li></ul></main>');
    expect(one('button[type="button"]')).toBe('main > div > button[type="button"]{Create Invoice}');
    expect(one('a')).toBe('main > div > a[href="/z"]{# tasks remaining}');
    expect(describeTargets([['main > div > span']]).length).toBe(1);
    expect(one('p')).toBe('main > div > p'); // longer than 30 characters: copy is not a name
    expect(one('td > span')).toBe('table > tbody > tr > td > span'); // a data row (the table is the anchor)
    expect(one('li > button')).toBe('main > ul > li > button'); // a list row
  });

  it('normalises digits in an aria-label (a live count is not part of the name)', () => {
    page('<header><button aria-label="Setup guide — 13 tasks remaining" type="button"><span>13</span></button></header>');
    expect(one('button')).toBe('header > button[type="button"][aria-label="Setup guide — # tasks remaining"]');
  });

  it('returns axe\'s own target for an iframe hop, a selector that no longer resolves, or an invalid one', () => {
    page('<p>x</p>');
    expect(describeTargets([['iframe', '#in'], ['.gone'], ['!!bad']])).toEqual(['iframe >> #in', '.gone', '!!bad']);
  });
});
