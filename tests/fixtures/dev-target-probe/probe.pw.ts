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

// A later override, and a saved session for another host: both are judged by the automatic fixture.
const override = process.env.PROBE_OVERRIDE_URL;
if (override) {
  test.describe('overridden', () => {
    test.use({ baseURL: override });
    test.beforeAll(() => ran('overridden-beforeAll'));
    test('overridden', () => ran('overridden-test'));
  });
}
const cookieDomain = process.env.PROBE_COOKIE_DOMAIN;
if (cookieDomain) {
  test.describe('session', () => {
    test.use({ storageState: { cookies: [{ name: 'sb-access-token', value: 'probe', domain: cookieDomain, path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [] } });
    test.beforeAll(() => ran('session-beforeAll'));
    test('session', () => ran('session-test'));
  });
}
