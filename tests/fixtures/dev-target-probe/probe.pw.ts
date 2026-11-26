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
