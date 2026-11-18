/**
 * The sandbox companies the production verify run's specs create for themselves, and which the provisioner therefore makes
 * ahead (through the same request) and flags is_demo: a spec that creates a company the provisioner did not make would leave a
 * company that is not is_demo on the verify user, and the suite's global setup fails the run for it.
 * tests/unit/ci/verifyCompanySandboxCensus.test.ts keeps this list equal to the specs production verify actually runs.
 */
import { MIGRATION_SANDBOX_ONBOARDING_ID, type SandboxSpec } from '../../../tests/e2e/golden-paths/helpers/sandboxSetup';
import { MIGRATION_SANDBOX_NAME } from './identity';

export interface PrecreatedSandbox extends SandboxSpec {
  /** The non-dev-only spec (file name under tests/e2e/golden-paths) that uses it. */
  spec: string;
  /** The identifier through which that spec's code names the sandbox (found in the spec or what it imports). */
  symbol: string;
}

export const PRECREATED_SANDBOXES: readonly PrecreatedSandbox[] = [
  { spec: 'm-migration-wizard.spec.ts', symbol: 'MIGRATION_SANDBOX_NAME', name: MIGRATION_SANDBOX_NAME, onboardingId: MIGRATION_SANDBOX_ONBOARDING_ID },
];
