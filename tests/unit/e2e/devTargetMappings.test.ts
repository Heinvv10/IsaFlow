/** The two places outside the Playwright guard that steer writes: z22's admin host mapping and the acceptance script's BASE. */
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('z22 admin host mapping', () => {
  const rule = async (baseUrl: string, skipA11y: string, postDeploy: string): Promise<string | undefined> => {
    vi.stubEnv('BASE_URL', baseUrl);
    vi.stubEnv('GOLDEN_SKIP_A11Y', skipA11y);
    vi.stubEnv('GOLDEN_POST_DEPLOY', postDeploy);
    vi.resetModules();
    const { LAUNCH_ARGS } = await import('../../e2e/golden-paths/helpers/adminConsole');
    return LAUNCH_ARGS[0];
  };

  it.each([['', ''], ['1', ''], ['', '1']])('sends every port of the admin host to the dev server under test (switches "%s", "%s")', async (skip, post) => {
    expect(await rule('http://localhost:3457', skip, post)).toBe('--host-resolver-rules=MAP admin.isaflow.co.za 127.0.0.1:3457');
  });

  it('leaves the post-deploy mapping as it was', async () => {
    expect(await rule('http://localhost:3111', '1', '1')).toBe('--host-resolver-rules=MAP admin.isaflow.co.za 127.0.0.1');
  });
});

describe('entity-onboarding acceptance', () => {
  it.each(['http://localhost:3101', 'http://localhost:3111', 'http://127.0.0.1:3112', 'https://app.isaflow.co.za'])(
    'refuses BASE=%s as it loads', async (base) => {
      vi.stubEnv('BASE', base);
      await expect(import('../../../scripts/acceptance/entity-onboarding-support')).rejects.toThrow(/dev-target guard/);
    });

  it("refuses the shared stack's Postgres port as it loads", async () => {
    vi.stubEnv('BASE', 'http://localhost:3200');
    vi.stubEnv('PORT', '7772');
    vi.stubEnv('PGPASSWORD', 'x');
    vi.stubEnv('JWT', 'x');
    await expect(import('../../../scripts/acceptance/entity-onboarding-support')).rejects.toThrow(/holds production/);
  });
});
