/**
 * The wave-6 golden QA user: golden-qa-w6@isaflow.dev, owner of its own sandbox "0W6 Golden Sandbox" and of nothing
 * else (dev GoTrue / isaflow_dev only; scripts/ci/golden/provision-w6-qa.ts makes it and writes the login to
 * ~/.secrets/isaflow-dev-golden-qa.env). A wave-6 golden that writes signs in as it, so it never shares a session or an
 * active company with the reporting-qa users other work switches around. Existing goldens are unchanged.
 *
 * Load the variables first: `set -a; . ~/.secrets/isaflow-dev-golden-qa.env; set +a`.
 */
import { Api } from '../_api';
import type { GoldenSlot } from './goldenSlot';

const KEYS = ['GOLDEN_QA_W6_EMAIL', 'GOLDEN_QA_W6_PASSWORD', 'GOLDEN_QA_W6_COMPANY_ID'] as const;

/** @throws naming every missing variable: a half-set login must not fall back to another user's company. */
export function readW6Qa(env: Record<string, string | undefined>): GoldenSlot {
  const missing = KEYS.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`the wave-6 golden QA login needs ${KEYS.join(', ')}; missing: ${missing.join(', ')}. `
      + 'Load ~/.secrets/isaflow-dev-golden-qa.env (bun scripts/ci/golden/provision-w6-qa.ts makes it).');
  }
  return { email: env.GOLDEN_QA_W6_EMAIL!, password: env.GOLDEN_QA_W6_PASSWORD!, companyId: env.GOLDEN_QA_W6_COMPANY_ID! };
}

/** An API context logged in as the QA user, scoped to its sandbox (the switch is read back by loginGolden). */
export function loginW6Qa(baseURL: string, env: Record<string, string | undefined> = process.env): Promise<Api> {
  return Api.loginAs(baseURL, readW6Qa(env));
}
