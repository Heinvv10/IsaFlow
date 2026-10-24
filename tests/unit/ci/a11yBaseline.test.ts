// The comparison behind expectNoSeriousA11yViolations: what counts as a violation, how a page is keyed, what the
// baseline excuses (by count), when a run fails in enforce mode and when it only reports. Pure functions; the
// Playwright wiring is tests/unit/ci/a11yAxeWiring.test.ts and the golden specs.
import { describe, expect, it } from 'vitest';
import {
  diffAgainstBaseline, evaluateGate, formatViolations, gateMode, pageKeyOf, screenMismatch, seriousViolations,
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

describe('perRow entries (violations inside table rows / list items)', () => {
  const baseline: BaselineFile = { pages: { '/p': [{ rule: 'select-name', selector: 'table > tbody > tr > td > select', max: 46, perRow: true }] } };
  const row = (count: number) => found('select-name', 'table > tbody > tr > td > select', count);

  it('allow any number of rows, however many the data has', () => {
    expect(diffAgainstBaseline('/p', [row(3)], baseline).added).toEqual([]);
    expect(diffAgainstBaseline('/p', [row(500)], baseline).added).toEqual([]);
  });
  it('are never stale or shrunk: an empty table has no rows', () => {
    const d = diffAgainstBaseline('/p', [], baseline);
    expect(d.stale).toEqual([]);
    expect(diffAgainstBaseline('/p', [row(1)], baseline).shrunk).toEqual([]);
    expect(evaluateGate('enforce', '/p', [], baseline).failure).toBeNull();
  });
  it('excuse only their own rule + selector', () => {
    expect(diffAgainstBaseline('/p', [found('select-name', 'table > tbody > tr > td > input')], baseline).added).toHaveLength(1);
    expect(diffAgainstBaseline('/p', [found('label', 'table > tbody > tr > td > select')], baseline).added).toHaveLength(1);
  });
});

describe('gateMode', () => {
  it('defaults to enforce, accepts report, and refuses a typo rather than silently enforcing or skipping', () => {
    expect(gateMode(undefined)).toBe('enforce');
    expect(gateMode('')).toBe('enforce');
    expect(gateMode('enforce')).toBe('enforce');
    expect(gateMode('report')).toBe('report');
    expect(() => gateMode('reprot')).toThrow(/A11Y_GATE must be/);
  });
});

describe('evaluateGate', () => {
  const baseline: BaselineFile = { pages: { '/p': [{ rule: 'label', selector: 'a', max: 1 }, { rule: 'old', selector: 'gone', max: 1 }] } };
  const withNew = [found('label', 'a'), found('critical-new', 'b', 1, 'critical')];

  it('enforce: a new violation throws, naming rule, impact and target', () => {
    const r = evaluateGate('enforce', '/p', withNew, baseline);
    expect(r.failure).toContain('critical-new');
    expect(r.failure).toContain('[critical]');
    expect(r.failure).toContain('target: b');
  });
  it('enforce: a stale entry throws, telling the author to delete it', () => {
    const r = evaluateGate('enforce', '/p', [found('label', 'a')], baseline);
    expect(r.failure).toMatch(/no longer occur - delete from a11y-baseline\.json/);
    expect(r.failure).toContain('old: gone');
  });
  it('enforce: exactly the baseline passes', () => {
    expect(evaluateGate('enforce', '/p', [found('label', 'a'), found('old', 'gone')], baseline).failure).toBeNull();
  });
  it('report: the same findings never throw, and are annotated instead', () => {
    const r = evaluateGate('report', '/p', withNew, baseline);
    expect(r.failure).toBeNull();
    const report = r.annotations.find((a) => a.type === 'a11y-gate-report');
    expect(report?.description).toContain('critical-new');
    expect(report?.description).toContain('old: gone'); // the stale one too
  });
  it('report: attaches what was observed (for re-recording the baseline), with counts', () => {
    const r = evaluateGate('report', '/p', [found('label', 'a', 4)], baseline);
    const obs = r.annotations.find((a) => a.type === 'a11y-observed');
    expect(JSON.parse(obs!.description)).toEqual({ key: '/p', found: [{ rule: 'label', selector: 'a', count: 4 }] });
  });
  it('enforce does not attach the observed set', () => {
    expect(evaluateGate('enforce', '/p', [found('label', 'a'), found('old', 'gone')], baseline).annotations).toEqual([]);
  });
  it('shrunk entries are annotated in both modes', () => {
    const b: BaselineFile = { pages: { '/p': [{ rule: 'label', selector: 'a', max: 5 }] } };
    for (const mode of ['enforce', 'report'] as const) {
      expect(evaluateGate(mode, '/p', [found('label', 'a', 2)], b).annotations.some((a) => a.type === 'a11y-baseline-shrunk')).toBe(true);
    }
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
