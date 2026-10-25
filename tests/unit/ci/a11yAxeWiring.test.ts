// The Playwright-facing half of the a11y gate (helpers/axe.ts) against a fake page, a fake AxeBuilder and a fake
// test.info(): which selectors reach axe, how the baseline key defaults, how a screen's data table is scanned
// apart, and what openScreen waits for and refuses.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  includes: [] as string[], excludes: [] as string[], violations: [] as unknown[], annotations: [] as { type: string; description: string }[],
  runs: [] as { includes: string[]; excludes: string[] }[],
}));

vi.mock('@axe-core/playwright', () => ({
  default: class FakeAxeBuilder {
    private inc: string[] = [];
    private exc: string[] = [];
    include(s: string) { h.includes.push(s); this.inc.push(s); return this; }
    exclude(s: string) { h.excludes.push(s); this.exc.push(s); return this; }
    async analyze() { h.runs.push({ includes: this.inc, excludes: this.exc }); return { violations: h.violations }; }
  },
}));
// A minimal `expect` with the matchers openScreen uses; a failing one throws like Playwright's does.
vi.mock('@playwright/test', () => ({
  expect: (value: unknown, message?: string) => ({
    toBeNull: () => { if (value !== null) throw new Error(`${message ?? ''} expected null, got ${String(value)}`); },
    toBeVisible: async () => { if (!(await (value as { isVisible(): Promise<boolean> }).isVisible())) throw new Error(`${message ?? ''} not visible`); },
    toHaveCount: async (n: number) => { if ((await (value as { count(): Promise<number> }).count()) !== n) throw new Error(`${message ?? ''} count != ${n}`); },
  }),
  test: { info: () => ({ annotations: h.annotations }) },
}));

import { expectNoSeriousA11yViolations, expectScreenClean, openScreen, SETUP_GUIDE_BUTTON } from '../../e2e/golden-paths/helpers/axe';
import type { A11yScreen } from '../../e2e/golden-paths/helpers/a11yScreens';
import type { Page } from '@playwright/test';

/** A page whose `evaluate(describeTargets, targets)` answers `ctx(<first hop>)` for each target. */
const fakePage = (url: string, evaluated: string[][][] = []): Page => ({
  url: () => url,
  evaluate: async (_fn: unknown, targets: string[][]) => { evaluated.push(targets); return targets.map((t) => `ctx(${t[0]})`); },
}) as unknown as Page;

const node = (target: string) => ({ target: [target] });
const axeViolation = (id: string, impact: string, ...targets: string[]) => ({ id, impact, help: `${id} help`, nodes: targets.map(node) });

beforeEach(() => { h.includes = []; h.excludes = []; h.violations = []; h.annotations = []; h.runs = []; });

describe('expectNoSeriousA11yViolations wiring', () => {
  it('passes include and exclude selectors to axe, after the shell excludes', async () => {
    await expectNoSeriousA11yViolations(fakePage('http://x/p'), { include: ['#a', '#b'], exclude: ['#chart'], baseline: { pages: {} } });
    expect(h.includes).toEqual(['#a', '#b']);
    expect(h.excludes).toEqual([SETUP_GUIDE_BUTTON, '#chart']);
  });

  it('leaves the app shell\'s data-dependent Setup-guide button out of the scan unless asked for', async () => {
    await expectNoSeriousA11yViolations(fakePage('http://x/p'), { baseline: { pages: {} } });
    expect(h.excludes).toContain(SETUP_GUIDE_BUTTON);
    h.excludes = [];
    await expectNoSeriousA11yViolations(fakePage('http://x/p'), { baseline: { pages: {} }, includeShell: true, include: [SETUP_GUIDE_BUTTON] });
    expect(h.excludes).toEqual([]);
    expect(h.includes).toEqual([SETUP_GUIDE_BUTTON]);
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

  it('throws with rule id, impact and the context target', async () => {
    h.violations = [axeViolation('label', 'critical', 'input')];
    await expect(expectNoSeriousA11yViolations(fakePage('http://x/p'), { baseline: { pages: {} } })).rejects.toThrow(/\[critical\] label[\s\S]*target: ctx\(input\)/);
  });

  it('a stale baseline entry throws', async () => {
    const baseline = { pages: { '/p': [{ rule: 'gone', selector: 'ctx(x)', max: 1 }] } };
    await expect(expectNoSeriousA11yViolations(fakePage('http://x/p'), { baseline })).rejects.toThrow(/no longer occur/);
  });

  it('an axe run that itself errors is an error, not a pass', async () => {
    const broken = { url: () => 'http://x/p', evaluate: async () => { throw new Error('Execution context was destroyed'); } } as unknown as Page;
    h.violations = [axeViolation('label', 'critical', 'input')];
    await expect(expectNoSeriousA11yViolations(broken, { baseline: { pages: {} } })).rejects.toThrow(/Execution context was destroyed/);
  });

  it('a shrunk entry is annotated on the test, not failed', async () => {
    h.violations = [axeViolation('label', 'critical', 'input')];
    await expect(expectNoSeriousA11yViolations(fakePage('http://x/p'), { baseline: { pages: { '/p': [{ rule: 'label', selector: 'ctx(input)', max: 3 }] } } })).resolves.toBeUndefined();
    expect(h.annotations.map((a) => a.type)).toEqual(['a11y-baseline-shrunk']);
  });
});

describe('expectScreenClean', () => {
  const plain: A11yScreen = { name: 'p', path: '/p', heading: 'P' };
  const withTable: A11yScreen = { ...plain, path: '/t', rowsTable: '[data-testid="tbl"]' };

  it('a plain screen is one page scan', async () => {
    await expectScreenClean(fakePage('http://x/p'), plain, { pages: {} });
    expect(h.runs).toEqual([{ includes: [], excludes: [SETUP_GUIDE_BUTTON] }]);
  });

  it('a screen with a data table is scanned twice: the page without the table, then the table alone under <page>#rows', async () => {
    h.violations = [axeViolation('select-name', 'critical', 'select')];
    const baseline = { pages: { '/t#rows': [{ rule: 'select-name', selector: 'ctx(select)', max: 9 }] } };
    // the page scan sees the violation too (the fake ignores include/exclude), so it fails under key /t...
    await expect(expectScreenClean(fakePage('http://x/t'), withTable, baseline)).rejects.toThrow(/on \/t:/);
    expect(h.runs[0]).toEqual({ includes: [], excludes: [SETUP_GUIDE_BUTTON, '[data-testid="tbl"]'] });
    // ...and with the page key baselined as well, both scans run and the second is keyed /t#rows
    h.runs = [];
    await expectScreenClean(fakePage('http://x/t'), withTable, { pages: { ...baseline.pages, '/t': [{ rule: 'select-name', selector: 'ctx(select)', max: 9 }] } });
    expect(h.runs).toEqual([
      { includes: [], excludes: [SETUP_GUIDE_BUTTON, '[data-testid="tbl"]'] },
      { includes: ['[data-testid="tbl"]'], excludes: [SETUP_GUIDE_BUTTON] },
    ]);
  });
});

/** A page that can be driven through openScreen, recording the order of what happens. */
function screenPage(opts: { landsOn: string; headingVisible?: boolean; h1Fails?: boolean; responseFails?: boolean; log?: string[] }): Page {
  const log = opts.log ?? [];
  return {
    waitForResponse: (match: (r: { url(): string }) => boolean) => {
      log.push('listen');
      return match({ url: () => 'http://x/api/accounting/bank-accounts' }) && !opts.responseFails ? Promise.resolve({}) : Promise.reject(new Error('Timeout 30000ms exceeded waiting for response'));
    },
    goto: async () => { log.push('goto'); return null; },
    waitForLoadState: async () => {},
    url: () => opts.landsOn,
    locator: (sel: string) => ({
      first: () => ({ waitFor: async () => { log.push('h1'); if (opts.h1Fails) throw new Error('Timeout 30000ms exceeded waiting for h1'); } }),
      count: async () => { log.push(sel.includes('animate') ? 'spinner-check' : 'count'); return 0; },
    }),
    getByRole: () => ({ isVisible: async () => opts.headingVisible !== false }),
  } as unknown as Page;
}
const SCREEN: A11yScreen = { name: 'assets', path: '/accounting/assets', heading: 'Fixed Assets' };

describe('openScreen throws on anything but the screen, with its data', () => {
  const failures: Array<[string, Page, RegExp]> = [
    ['a redirect', screenPage({ landsOn: 'http://x/login?reason=session-expired' }), /expected \/accounting\/assets but the browser is on \/login/],
    ['a missing heading', screenPage({ landsOn: 'http://x/accounting/assets', headingVisible: false }), /not visible/],
    ['a page whose h1 never shows', screenPage({ landsOn: 'http://x/accounting/assets', h1Fails: true }), /Timeout 30000ms/],
  ];

  it('resolves on the right screen', async () => {
    await expect(openScreen(screenPage({ landsOn: 'http://x/accounting/assets' }), SCREEN)).resolves.toBeUndefined();
  });

  it.each(failures)('%s throws', async (_name, page, message) => {
    await expect(openScreen(page, SCREEN)).rejects.toThrow(message);
  });

  it('listens for the screen\'s responses BEFORE navigating, and fails if one never arrives', async () => {
    const log: string[] = [];
    await openScreen(screenPage({ landsOn: 'http://x/accounting/assets', log }), { ...SCREEN, responses: [/bank-accounts/] });
    expect(log.indexOf('listen')).toBeGreaterThanOrEqual(0);
    expect(log.indexOf('listen')).toBeLessThan(log.indexOf('goto'));
    await expect(openScreen(screenPage({ landsOn: 'http://x/accounting/assets', responseFails: true }), { ...SCREEN, responses: [/bank-accounts/] }))
      .rejects.toThrow(/a11y screen "assets": no response matching \/bank-accounts\/ within 30s \(Timeout 30000ms exceeded waiting for response\)/);
  });

  it('a screen\'s own settled-wait replaces the generic spinner wait', async () => {
    const log: string[] = [];
    const settled = vi.fn(async () => { log.push('settled'); });
    await openScreen(screenPage({ landsOn: 'http://x/accounting/assets', log }), { ...SCREEN, settled });
    expect(settled).toHaveBeenCalledTimes(1);
    expect(log).not.toContain('spinner-check');
    log.length = 0;
    await openScreen(screenPage({ landsOn: 'http://x/accounting/assets', log }), SCREEN);
    expect(log).toContain('spinner-check');
  });

  it('a settled-wait that fails fails the screen', async () => {
    await expect(openScreen(screenPage({ landsOn: 'http://x/accounting/assets' }), { ...SCREEN, settled: async () => { throw new Error('rows never rendered'); } })).rejects.toThrow(/rows never rendered/);
  });
});
