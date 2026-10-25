// The comparison behind expectNoSeriousA11yViolations: what counts as a violation, how a page is keyed, what the
// baseline excuses (by count) and when a run fails. Pure functions; the
// Playwright wiring is tests/unit/ci/a11yAxeWiring.test.ts and the golden specs.
import { describe, expect, it } from 'vitest';
import {
  diffAgainstBaseline, evaluateGate, formatViolations, pageKeyOf, screenMismatch, seriousViolations,
  type AxeViolationLike, type BaselineFile, type Violation,
} from '../../e2e/golden-paths/helpers/a11yBaseline';

const v = (id: string, impact: AxeViolationLike['impact'], ...targets: string[][]): AxeViolationLike => ({
  id, impact, help: `${id} help`, nodes: targets.map((target) => ({ target })),
});
const same = (t: unknown[]) => t.join(' >> ');
const found = (rule: string, selector: string, count = 1, impact = 'serious'): Violation => ({ rule, selector, impact, help: `${rule} help`, count });

describe('seriousViolations', () => {
  it('keeps serious and critical, drops minor, moderate and unrated', () => {
    const out = seriousViolations([
      v('a', 'critical', ['#x']), v('b', 'serious', ['#y']), v('c', 'moderate', ['#z']), v('d', 'minor', ['#w']), v('e', null, ['#q']),
    ], same);
    expect(out.map((o) => o.rule)).toEqual(['a', 'b']);
  });

  it('counts the nodes that share a rule and a selector instead of listing each', () => {
    const out = seriousViolations([v('link-name', 'serious', ['#r1'], ['#r2'], ['#r3'], ['#other'])], (t) => (t[0] === '#other' ? 'other' : 'row'));
    expect(out).toEqual([
      { rule: 'link-name', selector: 'row', impact: 'serious', help: 'link-name help', count: 3 },
      { rule: 'link-name', selector: 'other', impact: 'serious', help: 'link-name help', count: 1 },
    ]);
  });

  it('keeps the same selector under two rules apart', () => {
    expect(seriousViolations([v('a', 'serious', ['#x']), v('b', 'serious', ['#x'])], same)).toHaveLength(2);
  });
});

describe('pageKeyOf', () => {
  it('uses the path only, with ids collapsed', () => {
    expect(pageKeyOf('http://localhost:3216/accounting/supplier-payments/0b2f3c4d-1111-4222-8333-444455556666?x=1#h')).toBe('/accounting/supplier-payments/:id');
    expect(pageKeyOf('http://localhost:3216/accounting/customer-invoices/12345')).toBe('/accounting/customer-invoices/:id');
  });
});

describe('screenMismatch', () => {
  it('accepts the expected path, ignoring a query the screen did not ask for', () => {
    expect(screenMismatch('http://x/accounting/assets?tab=all', '/accounting/assets')).toBeNull();
  });
  it('fails a redirect to the login page', () => {
    expect(screenMismatch('http://x/login?reason=session-expired', '/accounting/assets')).toMatch(/expected \/accounting\/assets but the browser is on \/login\?reason=session-expired/);
  });
  it('fails a redirect to another screen that has a heading of its own', () => {
    expect(screenMismatch('http://x/accounting?tab=journal-entries', '/accounting/journal-entries')).toMatch(/expected \/accounting\/journal-entries but the browser is on \/accounting\?tab=journal-entries/);
  });
  it('requires an expected query to be present', () => {
    expect(screenMismatch('http://x/accounting?tab=journal-entries', '/accounting?tab=journal-entries')).toBeNull();
    expect(screenMismatch('http://x/accounting?tab=dashboard', '/accounting?tab=journal-entries')).toMatch(/expected \?tab=journal-entries/);
    expect(screenMismatch('http://x/accounting', '/accounting?tab=journal-entries')).toMatch(/expected \?tab=journal-entries/);
  });
});

describe('diffAgainstBaseline', () => {
  const baseline: BaselineFile = { pages: { '/p': [{ rule: 'label', selector: 'form > input[name="a"]', max: 2 }] } };

  it('excuses a recorded violation up to its max', () => {
    expect(diffAgainstBaseline('/p', [found('label', 'form > input[name="a"]', 2)], baseline).added).toEqual([]);
  });
  it('flags one node more than the recorded max, saying what was allowed', () => {
    expect(diffAgainstBaseline('/p', [found('label', 'form > input[name="a"]', 3)], baseline).added).toEqual([
      expect.objectContaining({ rule: 'label', count: 3, max: 2 }),
    ]);
  });
  it('flags a new rule or a new selector, and a page absent from the baseline excuses nothing', () => {
    expect(diffAgainstBaseline('/p', [found('color-contrast', 'form > input[name="a"]')], baseline).added).toHaveLength(1);
    expect(diffAgainstBaseline('/p', [found('label', 'form > input[name="b"]')], baseline).added).toHaveLength(1);
    expect(diffAgainstBaseline('/other', [found('label', 'form > input[name="a"]')], baseline).added).toHaveLength(1);
  });
  it('reports a recorded entry that no longer occurs as stale', () => {
    const d = diffAgainstBaseline('/p', [], baseline);
    expect(d.added).toEqual([]);
    expect(d.stale).toEqual([{ rule: 'label', selector: 'form > input[name="a"]', max: 2 }]);
  });
  it('reports fewer nodes than the max as shrunk, not stale', () => {
    const d = diffAgainstBaseline('/p', [found('label', 'form > input[name="a"]', 1)], baseline);
    expect(d.stale).toEqual([]);
    expect(d.shrunk).toEqual([{ rule: 'label', selector: 'form > input[name="a"]', max: 2, count: 1 }]);
  });
});

describe('dataDriven entries (presence and count follow the data, not the markup)', () => {
  const source = { source: '/api/accounting/bank-transactions', why: 'one select per table row' };
  const baseline: BaselineFile = { pages: { '/p': [
    { rule: 'select-name', selector: 'table[data-testid="t"] > tbody > tr > td > select', max: 46, dataDriven: source },
    { rule: 'label', selector: 'table[data-testid="t"] > tbody > tr > td > input', max: 25, maxHint: 25, dataDriven: source },
  ] } };
  const rows = (count: number) => found('select-name', 'table[data-testid="t"] > tbody > tr > td > select', count);
  const boxes = (count: number) => found('label', 'table[data-testid="t"] > tbody > tr > td > input', count);

  it('allow any number of matches when there is no hard cap', () => {
    expect(diffAgainstBaseline('/p', [rows(3)], baseline).added).toEqual([]);
    expect(diffAgainstBaseline('/p', [rows(500)], baseline).added).toEqual([]);
  });
  it('a maxHint is a hard cap: one match over it fails, saying what was allowed', () => {
    expect(diffAgainstBaseline('/p', [boxes(25)], baseline).added).toEqual([]);
    expect(diffAgainstBaseline('/p', [boxes(26)], baseline).added).toEqual([expect.objectContaining({ rule: 'label', count: 26, max: 25 })]);
  });
  it('are never stale or shrunk: with no data there is nothing to match', () => {
    expect(diffAgainstBaseline('/p', [], baseline).stale).toEqual([]);
    expect(diffAgainstBaseline('/p', [rows(1)], baseline).shrunk).toEqual([]);
    expect(evaluateGate('/p', [], baseline).failure).toBeNull();
  });
  it('excuse only their own rule + selector', () => {
    expect(diffAgainstBaseline('/p', [found('select-name', 'table[data-testid="t"] > tbody > tr > td > input')], baseline).added).toHaveLength(1);
    expect(diffAgainstBaseline('/p', [found('label', 'table[data-testid="t"] > tbody > tr > td > select')], baseline).added).toHaveLength(1);
  });
});

describe('evaluateGate', () => {
  const baseline: BaselineFile = { pages: { '/p': [{ rule: 'label', selector: 'a', max: 1 }, { rule: 'old', selector: 'gone', max: 1 }] } };

  it('a new violation fails, naming rule, impact and target', () => {
    const r = evaluateGate('/p', [found('label', 'a'), found('critical-new', 'b', 1, 'critical')], baseline);
    expect(r.failure).toContain('critical-new');
    expect(r.failure).toContain('[critical]');
    expect(r.failure).toContain('target: b');
  });
  it('a stale entry fails, telling the author to delete it', () => {
    const r = evaluateGate('/p', [found('label', 'a')], baseline);
    expect(r.failure).toMatch(/no longer occur - delete from a11y-baseline\.json/);
    expect(r.failure).toContain('old: gone');
  });
  it('exactly the baseline passes, with no annotations', () => {
    const r = evaluateGate('/p', [found('label', 'a'), found('old', 'gone')], baseline);
    expect(r.failure).toBeNull();
    expect(r.annotations).toEqual([]);
  });
  it('an entry with fewer nodes than its max is annotated, not failed', () => {
    const b: BaselineFile = { pages: { '/p': [{ rule: 'label', selector: 'a', max: 5 }] } };
    const r = evaluateGate('/p', [found('label', 'a', 2)], b);
    expect(r.failure).toBeNull();
    expect(r.annotations.map((a) => a.type)).toEqual(['a11y-baseline-shrunk']);
  });
});

describe('formatViolations', () => {
  it('prints rule id, impact, help and target; and the count against the allowance', () => {
    const text = formatViolations('/p', [{ ...found('label', '#a', 3, 'critical'), max: 2 }]);
    expect(text).toContain('/p');
    expect(text).toContain('[critical] label: label help (3 nodes, baseline allows 2)');
    expect(text).toContain('target: #a');
  });
});
