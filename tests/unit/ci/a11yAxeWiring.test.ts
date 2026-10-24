// The Playwright-facing half of the a11y gate (helpers/axe.ts) against a fake page, a fake AxeBuilder and a fake
// test.info(): which selectors reach axe, how the baseline key defaults, that report mode annotates and enforce
// throws, and that only serious/critical nodes are described.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  includes: [] as string[], excludes: [] as string[], violations: [] as unknown[], annotations: [] as { type: string; description: string }[],
}));

vi.mock('@axe-core/playwright', () => ({
  default: class FakeAxeBuilder {
    include(s: string) { h.includes.push(s); return this; }
    exclude(s: string) { h.excludes.push(s); return this; }
    async analyze() { return { violations: h.violations }; }
  },
}));
vi.mock('@playwright/test', () => ({ expect: vi.fn(), test: { info: () => ({ annotations: h.annotations }) } }));

import { expectNoSeriousA11yViolations } from '../../e2e/golden-paths/helpers/axe';
import type { Page } from '@playwright/test';

/** A page whose `evaluate(describeTargets, targets)` answers `ctx(<first hop>)` for each target. */
const fakePage = (url: string, evaluated: string[][][] = []): Page => ({
  url: () => url,
  evaluate: async (_fn: unknown, targets: string[][]) => { evaluated.push(targets); return targets.map((t) => `ctx(${t[0]})`); },
}) as unknown as Page;

const node = (target: string) => ({ target: [target] });
const axeViolation = (id: string, impact: string, ...targets: string[]) => ({ id, impact, help: `${id} help`, nodes: targets.map(node) });

beforeEach(() => { h.includes = []; h.excludes = []; h.violations = []; h.annotations = []; delete process.env.A11Y_GATE; });
afterEach(() => { delete process.env.A11Y_GATE; });

describe('expectNoSeriousA11yViolations wiring', () => {
  it('passes include and exclude selectors to axe', async () => {
    await expectNoSeriousA11yViolations(fakePage('http://x/p'), { include: ['#a', '#b'], exclude: ['#chart'], baseline: { pages: {} } });
    expect(h.includes).toEqual(['#a', '#b']);
    expect(h.excludes).toEqual(['#chart']);
  });

  it('keys the baseline by the page path with ids collapsed, unless a key is given', async () => {
    h.violations = [axeViolation('label', 'critical', 'input')];
    const baseline = { pages: { '/accounting/x/:id': [{ rule: 'label', selector: 'ctx(input)', max: 1 }], custom: [{ rule: 'label', selector: 'ctx(input)', max: 1 }] } };
    await expect(expectNoSeriousA11yViolations(fakePage('http://x/accounting/x/0b2f3c4d-1111-4222-8333-444455556666?q=1'), { baseline })).resolves.toBeUndefined();
    await expect(expectNoSeriousA11yViolations(fakePage('http://x/anything'), { key: 'custom', baseline })).resolves.toBeUndefined();
    await expect(expectNoSeriousA11yViolations(fakePage('http://x/other'), { baseline })).rejects.toThrow(/on \/other/);
  });

  it('describes only serious and critical nodes, in one page round trip', async () => {
    const evaluated: string[][][] = [];
    h.violations = [axeViolation('a', 'serious', 'one'), axeViolation('b', 'moderate', 'two'), axeViolation('c', 'critical', 'three')];
    await expect(expectNoSeriousA11yViolations(fakePage('http://x/p', evaluated), { baseline: { pages: {} } })).rejects.toThrow(/ctx\(one\)[\s\S]*ctx\(three\)/);
    expect(evaluated).toEqual([[['one'], ['three']]]);
  });

  it('enforce (the default) throws with rule id, impact and the context target', async () => {
    h.violations = [axeViolation('label', 'critical', 'input')];
    await expect(expectNoSeriousA11yViolations(fakePage('http://x/p'), { baseline: { pages: {} } })).rejects.toThrow(/\[critical\] label[\s\S]*target: ctx\(input\)/);
  });

  it('A11Y_GATE=report never throws, and records the findings as test annotations', async () => {
    process.env.A11Y_GATE = 'report';
    h.violations = [axeViolation('label', 'critical', 'input')];
    await expect(expectNoSeriousA11yViolations(fakePage('http://x/p'), { baseline: { pages: {} } })).resolves.toBeUndefined();
    expect(h.annotations.map((a) => a.type)).toEqual(['a11y-gate-report', 'a11y-observed']);
    expect(h.annotations[0]!.description).toContain('label');
  });

  it('a stale baseline entry throws in enforce, and is annotated in report', async () => {
    const baseline = { pages: { '/p': [{ rule: 'gone', selector: 'ctx(x)', max: 1 }] } };
    await expect(expectNoSeriousA11yViolations(fakePage('http://x/p'), { baseline })).rejects.toThrow(/no longer occur/);
    process.env.A11Y_GATE = 'report';
    await expect(expectNoSeriousA11yViolations(fakePage('http://x/p'), { baseline })).resolves.toBeUndefined();
    expect(h.annotations.find((a) => a.type === 'a11y-gate-report')?.description).toContain('gone');
  });

  it('refuses an unknown A11Y_GATE value', async () => {
    process.env.A11Y_GATE = 'off';
    await expect(expectNoSeriousA11yViolations(fakePage('http://x/p'), { baseline: { pages: {} } })).rejects.toThrow(/A11Y_GATE must be/);
  });
});
