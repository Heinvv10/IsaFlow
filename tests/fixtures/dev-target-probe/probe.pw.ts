// Fixture of tests/unit/e2e/devTargetRunner.test.ts: says which of a guarded file's hooks and tests ran. No browser.
import { test } from '@playwright/test';
import { guardDevTarget } from '../../e2e/helpers/devTarget';

guardDevTarget(test);

const ran = (what: string): void => { process.stdout.write(`PROBE-RAN ${what}\n`); };

test.beforeAll(() => ran('first-beforeAll'));
test.beforeAll(({ baseURL }) => ran(baseURL === process.env.PROBE_BASE_URL ? 'second-beforeAll' : 'wrong-base-url'));
test.afterAll(() => ran('afterAll'));
test('plain', () => ran('test'));
test.describe('nested', () => {
  test.beforeAll(() => ran('nested-beforeAll'));
  test.afterAll(() => ran('nested-afterAll'));
  test('inside', () => ran('nested-test'));
});

// A later override, and a saved session for another host. After the refusal no hook that holds a request, a context or a
// page may run, whatever its kind or position.
const eachHooks = (name: string): void => {
  // Optional: a refused beforeAll skips everything after it, which would hide a leak through the each hooks.
  if (process.env.PROBE_BEFORE_ALL) test.beforeAll(() => ran(`${name}-beforeAll`));
  test.beforeEach(({ request }) => ran(request ? `${name}-beforeEach` : 'no-request'));
  test.beforeEach(({ request }) => ran(request ? `${name}-beforeEach-second` : 'no-request'));
  // Browser fixtures only where they are expected to be refused: the unit run need not have a browser.
  if (process.env.PROBE_BROWSER_HOOKS) {
    test.beforeEach(({ context }) => ran(context ? `${name}-beforeEach-context` : 'no-context'));
    test.afterEach(({ page }) => ran(page ? `${name}-afterEach-page` : 'no-page'));
  }
  test.afterEach(({ request }) => ran(request ? `${name}-afterEach` : 'no-request'));
  test(name, () => ran(`${name}-test`));
};
const override = process.env.PROBE_OVERRIDE_URL;
if (override) {
  test.describe('overridden', () => {
    test.use({ baseURL: override });
    eachHooks('overridden');
  });
}
const cookieDomain = process.env.PROBE_COOKIE_DOMAIN;
if (cookieDomain) {
  test.describe('session', () => {
    test.use({ storageState: { cookies: [{ name: 'sb-access-token', value: 'probe', domain: cookieDomain, path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [] } });
    eachHooks('session');
  });
}
