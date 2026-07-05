/**
 * Golden-paths global setup — logs in ONCE per suite run and saves the
 * storage state (session + CSRF cookies) for every spec to reuse.
 *
 * One login per run matters: /api/auth/login is rate-limited to 10 attempts
 * per email per 15 minutes. Eleven specs logging in individually would spend
 * the whole window on a single run (and break post-deploy verification
 * against prod Demo).
 */
import { request as pwRequest, type FullConfig } from '@playwright/test';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { getE2ECredentials } from '../_creds';

export const GOLDEN_STATE_FILE = 'tests/e2e/.auth/golden-session.json';

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use?.baseURL;
  if (!baseURL) throw new Error('golden config must define use.baseURL');

  const { email, password } = getE2ECredentials();
  const ctx = await pwRequest.newContext({ baseURL });
  const res = await ctx.post('/api/auth/login', { data: { email, password } });
  if (res.status() !== 200) {
    throw new Error(`golden-paths login failed: ${res.status()} ${await res.text()}`);
  }
  // Middleware issues the CSRF cookie on any routed request.
  await ctx.get('/accounting');

  mkdirSync(dirname(GOLDEN_STATE_FILE), { recursive: true });
  await ctx.storageState({ path: GOLDEN_STATE_FILE });
  await ctx.dispose();
}
