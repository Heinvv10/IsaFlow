// The comparison behind expectNoSeriousA11yViolations: what counts as a violation, how a page and a selector are
// keyed, and what the baseline excuses. Pure functions; the Playwright wiring is exercised by the golden specs.
import { describe, expect, it } from 'vitest';
import {
  diffAgainstBaseline, formatViolations, normalizeSelector, pageKeyOf, seriousViolations,
  type AxeViolationLike, type BaselineFile,
} from '../../e2e/golden-paths/helpers/a11yBaseline';

const v = (id: string, impact: AxeViolationLike['impact'], ...targets: string[][]): AxeViolationLike => ({
  id, impact, help: `${id} help`, nodes: targets.map((target) => ({ target })),
});

describe('seriousViolations', () => {
  it('keeps serious and critical, drops minor, moderate and unrated', () => {
    const out = seriousViolations([
      v('a', 'critical', ['#x']), v('b', 'serious', ['#y']), v('c', 'moderate', ['#z']), v('d', 'minor', ['#w']), v('e', null, ['#q']),
    ]);
    expect(out.map((o) => o.rule)).toEqual(['a', 'b']);
  });

  it('emits one entry per failing node', () => {
    const out = seriousViolations([v('label', 'critical', ['#a'], ['#b'])]);
    expect(out.map((o) => o.selector)).toEqual(['#a', '#b']);
  });
});

describe('normalizeSelector', () => {
  it('joins iframe / shadow-DOM hops', () => {
    expect(normalizeSelector(['iframe', '#in'])).toBe('iframe >> #in');
  });
  it('drops positional indices and React-generated ids that change between renders', () => {
    expect(normalizeSelector(['tbody > tr:nth-child(7) > td:nth-child(2)'])).toBe('tbody > tr:nth-child(*) > td:nth-child(*)');
    expect(normalizeSelector(['#\\:r1a\\: > input'])).toBe('#:r*: > input');
    expect(normalizeSelector(['[id="radix-\\:r3\\:-trigger"]'])).toBe('[id="radix-:r*:-trigger"]');
  });
});

describe('pageKeyOf', () => {
  it('uses the path only, with ids collapsed', () => {
    expect(pageKeyOf('http://localhost:3216/accounting/supplier-payments/0b2f3c4d-1111-4222-8333-444455556666?x=1#h')).toBe('/accounting/supplier-payments/:id');
    expect(pageKeyOf('http://localhost:3216/accounting/customer-invoices/12345')).toBe('/accounting/customer-invoices/:id');
  });
});

describe('diffAgainstBaseline', () => {
  const found = [
    { rule: 'label', selector: '#a', impact: 'critical', help: 'h' },
    { rule: 'color-contrast', selector: '.b', impact: 'serious', help: 'h' },
  ];
  const baseline: BaselineFile = { pages: { '/p': [{ rule: 'label', selector: '#a' }] } };

  it('flags only violations the baseline does not list', () => {
    expect(diffAgainstBaseline('/p', found, baseline).added.map((x) => x.rule)).toEqual(['color-contrast']);
  });
  it('a page absent from the baseline excuses nothing', () => {
    expect(diffAgainstBaseline('/other', found, baseline).added).toHaveLength(2);
  });
  it('the same rule on a different selector is new', () => {
    const d = diffAgainstBaseline('/p', [{ ...found[0]!, selector: '#different' }], baseline);
    expect(d.added).toHaveLength(1);
  });
  it('lists a violation once however many rows of a table share it', () => {
    const row = { rule: 'link-name', selector: 'tr:nth-child(*) > a', impact: 'serious', help: 'h' };
    expect(diffAgainstBaseline('/p', [row, row, row], { pages: {} }).added).toEqual([row]);
  });
  it('reports baseline entries that no longer occur, so they can be deleted', () => {
    const d = diffAgainstBaseline('/p', [], baseline);
    expect(d.added).toEqual([]);
    expect(d.stale).toEqual([{ rule: 'label', selector: '#a' }]);
  });
});

describe('formatViolations', () => {
  it('prints rule id, impact and target for each', () => {
    const text = formatViolations('/p', [{ rule: 'label', selector: '#a', impact: 'critical', help: 'Form elements must have labels' }]);
    expect(text).toContain('/p');
    expect(text).toContain('label');
    expect(text).toContain('critical');
    expect(text).toContain('#a');
  });
});
