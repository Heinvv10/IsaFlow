// The Playwright-facing half of the a11y gate (helpers/axe.ts) against a fake page, a fake AxeBuilder and a fake
// test.info(): which selectors reach axe, how the baseline key defaults, how a screen's data table is scanned
// apart, and what openScreen waits for and refuses.
import { runInNewContext } from 'node:vm';
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
function screenPage(opts: { landsOn: string; headingVisible?: boolean; h1Fails?: boolean | string; responseFails?: boolean; log?: string[] }): Page {
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
      first: () => ({ waitFor: async () => { log.push('h1'); if (opts.h1Fails) throw new Error(typeof opts.h1Fails === 'string' ? opts.h1Fails : 'Timeout 30000ms exceeded waiting for h1'); } }),
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
    ['a page whose h1 never shows', screenPage({ landsOn: 'http://x/accounting/assets', h1Fails: true }), /a11y screen "assets" \(\/accounting\/assets\): no <h1> showed within 30s\nTimeout 30000ms/],
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
    await expect(openScreen(screenPage({ landsOn: 'http://x/accounting/assets' }), { ...SCREEN, settled: async () => { throw new Error('rows never rendered'); } })).rejects.toThrow(/a11y screen "assets" \(\/accounting\/assets\): the screen never settled\nrows never rendered/);
  });
});

describe('the generic spinner wait names the screen too', () => {
  it('a page that never stops spinning fails with the screen and what it waited for', async () => {
    const page = screenPage({ landsOn: 'http://x/accounting/assets' });
    (page as unknown as { locator: (s: string) => unknown }).locator = (sel: string) => ({
      first: () => ({ waitFor: async () => {} }),
      count: async () => (sel.includes('animate') ? 2 : 0),
    });
    await expect(openScreen(page, SCREEN)).rejects.toThrow(/a11y screen "assets" \(\/accounting\/assets\): the page still shows a spinner or skeleton after 30s\n.*count != 0/);
  });
});

describe('inScreen keeps what went wrong', () => {
  const multiLine = () => new Error('expect(locator).toHaveCount(expected) failed\n\nExpected: 0\nReceived: 2\nTimeout: 30000ms');

  it('keeps the whole underlying message, Expected/Received lines included, with colour codes stripped', async () => {
    const original = new Error(`\u001b[2mexpect(\u001b[22m\u001b[31mlocator\u001b[39m\u001b[2m)\u001b[22m failed\n\nExpected: 0\nReceived: 2`);
    const err = await openScreen(screenPage({ landsOn: 'http://x/accounting/assets' }), { ...SCREEN, settled: async () => { throw original; } }).catch((e: Error) => e);
    expect((err as Error).message).toBe('a11y screen "assets" (/accounting/assets): the screen never settled\nexpect(locator) failed\n\nExpected: 0\nReceived: 2');
  });

  it('rethrows with the original as `cause`, so its stack survives', async () => {
    const original = multiLine();
    const err = await openScreen(screenPage({ landsOn: 'http://x/accounting/assets' }), { ...SCREEN, settled: async () => { throw original; } }).catch((e: Error) => e);
    expect((err as Error).cause).toBe(original);
  });

  it('a thrown non-Error is still named and kept as the cause', async () => {
    const err = await openScreen(screenPage({ landsOn: 'http://x/accounting/assets' }), { ...SCREEN, settled: async () => { throw 'boom'; } }).catch((e: Error) => e);
    expect((err as Error).message).toContain('the screen never settled');
    expect((err as Error).message).toContain('boom');
    expect((err as Error).cause).toBe('boom');
  });

  it('the h1 and spinner waits keep the full message and cause too', async () => {
    const body = "locator.waitFor: Timeout 30000ms exceeded.\nCall log:\n  - waiting for locator('h1').first() to be visible";
    const h1 = await openScreen(screenPage({ landsOn: 'http://x/accounting/assets', h1Fails: body }), SCREEN).catch((e: Error) => e);
    expect((h1 as Error).message).toBe(`a11y screen "assets" (/accounting/assets): no <h1> showed within 30s\n${body}`);
    expect((h1 as Error).cause).toBeInstanceOf(Error);
    const page = screenPage({ landsOn: 'http://x/accounting/assets' });
    (page as unknown as { locator: (s: string) => unknown }).locator = (sel: string) => ({
      first: () => ({ waitFor: async () => {} }),
      count: async () => (sel.includes('animate') ? 2 : 0),
    });
    const spin = await openScreen(page, SCREEN).catch((e: Error) => e);
    expect((spin as Error).message).toMatch(/count != 0/);
    expect((spin as Error).cause).toBeInstanceOf(Error);
  });

  it('strips every terminal control sequence, not only colours', async () => {
    const err = await openScreen(screenPage({ landsOn: 'http://x/accounting/assets' }), { ...SCREEN, settled: async () => { throw new Error('\u001b[2K\u001b[1Arow \u001b]8;;http://x\u0007link\u001b]8;;\u0007 \u001b[31mred\u001b[39m'); } }).catch((e: Error) => e);
    expect((err as Error).message).toContain('row link red');
    expect((err as Error).message).not.toContain('\u001b');
  });

  it('shows a thrown plain object as JSON, falling back to String for one that cannot be serialised', async () => {
    const asObject = await openScreen(screenPage({ landsOn: 'http://x/accounting/assets' }), { ...SCREEN, settled: async () => { throw { code: 'E_ROWS', rows: 0 }; } }).catch((e: Error) => e);
    expect((asObject as Error).message).toContain('{"code":"E_ROWS","rows":0}');
    expect((asObject as Error).message).not.toContain('[object Object]');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const asString = await openScreen(screenPage({ landsOn: 'http://x/accounting/assets' }), { ...SCREEN, settled: async () => { throw circular; } }).catch((e: Error) => e);
    expect((asString as Error).message).toContain('[object Object]');
    expect((asString as Error).cause).toBe(circular);
  });

  it('an error with an empty message leaves no trailing newline', async () => {
    const err = await openScreen(screenPage({ landsOn: 'http://x/accounting/assets' }), { ...SCREEN, settled: async () => { throw new Error(''); } }).catch((e: Error) => e);
    expect((err as Error).message).toBe('a11y screen "assets" (/accounting/assets): the screen never settled');
  });

  it('a whitespace-only message gets no newline either', async () => {
    for (const blank of [' ', '\n', '  \n\t ']) {
      const err = await openScreen(screenPage({ landsOn: 'http://x/accounting/assets' }), { ...SCREEN, settled: async () => { throw new Error(blank); } }).catch((e: Error) => e);
      expect((err as Error).message).toBe('a11y screen "assets" (/accounting/assets): the screen never settled');
    }
  });

  it('an Error from another realm (not instanceof Error) keeps its message instead of becoming "{}"', async () => {
    const foreign = runInNewContext('new Error("cross realm failure\\nReceived: 2")') as Error;
    expect(foreign instanceof Error).toBe(false);
    const err = await openScreen(screenPage({ landsOn: 'http://x/accounting/assets' }), { ...SCREEN, settled: async () => { throw foreign; } }).catch((e: Error) => e);
    expect((err as Error).message).toBe('a11y screen "assets" (/accounting/assets): the screen never settled\ncross realm failure\nReceived: 2');
    expect((err as Error).cause).toBe(foreign);
  });

  it('nothing throws out of the wrapper: a thrown value whose String() throws still yields the named Error', async () => {
    const bare = Object.create(null) as object; // String(bare) throws a TypeError; JSON gives {}
    Object.defineProperty(bare, 'toJSON', { value: () => { throw new Error('no json'); } });
    const err = await openScreen(screenPage({ landsOn: 'http://x/accounting/assets' }), { ...SCREEN, settled: async () => { throw bare; } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('a11y screen "assets" (/accounting/assets): the screen never settled\n[object Object]');
    expect((err as Error).cause).toBe(bare);
  });

  it('is total: a revoked Proxy, or an object whose message getter throws, still gives the named wrapper and keeps the cause', async () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const hostile = { get message(): string { throw new Error('getter boom'); } };
    for (const thrown of [proxy, hostile]) {
      const err = await openScreen(screenPage({ landsOn: 'http://x/accounting/assets' }), { ...SCREEN, settled: async () => { throw thrown; } }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe('a11y screen "assets" (/accounting/assets): the screen never settled\n[unprintable thrown value]');
      expect((err as Error).cause).toBe(thrown);
    }
  });

  it('reads `message` once (a getter may be expensive or change)', async () => {
    let reads = 0;
    const counted = { get message(): string { reads += 1; return `read ${reads}`; } };
    const err = await openScreen(screenPage({ landsOn: 'http://x/accounting/assets' }), { ...SCREEN, settled: async () => { throw counted; } }).catch((e: Error) => e);
    expect(reads).toBe(1);
    expect((err as Error).message).toContain('\nread 1');
  });

  it('an object whose JSON is undefined (toJSON returns nothing) falls through to String', async () => {
    const err = await openScreen(screenPage({ landsOn: 'http://x/accounting/assets' }), { ...SCREEN, settled: async () => { throw { toJSON: () => undefined }; } }).catch((e: Error) => e);
    expect((err as Error).message).toBe('a11y screen "assets" (/accounting/assets): the screen never settled\n[object Object]');
  });

  it('a thrown function is printed as a function, not mined for a message property', async () => {
    const fn = Object.assign(() => 'fn-body-marker', { message: 'looks like an Error' });
    const err = await openScreen(screenPage({ landsOn: 'http://x/accounting/assets' }), { ...SCREEN, settled: async () => { throw fn; } }).catch((e: Error) => e);
    expect((err as Error).message).not.toContain('looks like an Error');
    expect((err as Error).message).toContain('fn-body-marker'); // String(fn) is its source: that is what was printed
    expect((err as Error).cause).toBe(fn);
  });

  it('a non-string `message` getter is read twice (once by us, once by JSON.stringify): "read once" holds for string messages only', async () => {
    let reads = 0;
    const numeric = { get message(): number { reads += 1; return 42; } };
    const err = await openScreen(screenPage({ landsOn: 'http://x/accounting/assets' }), { ...SCREEN, settled: async () => { throw numeric; } }).catch((e: Error) => e);
    expect(reads).toBe(2);
    expect((err as Error).message).toContain('{"message":42}');
  });

  it('a throwing toJSON, or a circular object, falls through to String(): the object\'s own text, never the sentinel', async () => {
    class Named { toString(): string { return 'named-by-string'; } toJSON(): never { throw new Error('toJSON boom'); } }
    class Loop { self = this; toString(): string { return 'loop-by-string'; } }
    for (const [thrown, text] of [[new Named(), 'named-by-string'], [new Loop(), 'loop-by-string']] as const) {
      const err = await openScreen(screenPage({ landsOn: 'http://x/accounting/assets' }), { ...SCREEN, settled: async () => { throw thrown; } }).catch((e: Error) => e);
      expect((err as Error).message).toBe(`a11y screen "assets" (/accounting/assets): the screen never settled\n${text}`);
      expect((err as Error).message).not.toContain('unprintable');
      expect((err as Error).cause).toBe(thrown);
    }
  });

  it('a throwing `message` getter yields only the sentinel: the fallbacks are not tried', async () => {
    const hostile = { get message(): string { throw new Error('getter boom'); }, toString: () => 'would-be-fallback' };
    const err = await openScreen(screenPage({ landsOn: 'http://x/accounting/assets' }), { ...SCREEN, settled: async () => { throw hostile; } }).catch((e: Error) => e);
    expect((err as Error).message).toBe('a11y screen "assets" (/accounting/assets): the screen never settled\n[unprintable thrown value]');
    expect((err as Error).message).not.toContain('would-be-fallback');
  });
});
