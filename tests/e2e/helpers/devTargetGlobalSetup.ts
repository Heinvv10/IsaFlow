/**
 * Global setup of every Playwright config but the golden one (which does the same in _global-setup.ts): nothing runs
 * unless every project points at a dev or CI target (devTarget.ts).
 */
import type { FullConfig } from '@playwright/test';
import { assertDevOrCiTarget } from './devTarget';

export default function devTargetGlobalSetup(config: FullConfig): void {
  if (config.projects.length === 0) assertDevOrCiTarget(undefined);
  for (const project of config.projects) assertDevOrCiTarget(project.use.baseURL);
}
