/**
 * Global setup of every Playwright config but the golden one (which does the same in _global-setup.ts): nothing runs
 * unless every project points at a dev or CI target (devTarget.ts) whose server says it is on a test database.
 */
import type { FullConfig } from '@playwright/test';
import { assertDevOrCiTarget, assertDevServer } from './devTarget';

export default async function devTargetGlobalSetup(config: FullConfig): Promise<void> {
  if (config.projects.length === 0) assertDevOrCiTarget(undefined);
  for (const project of config.projects) await assertDevServer(assertDevOrCiTarget(project.use.baseURL));
}
