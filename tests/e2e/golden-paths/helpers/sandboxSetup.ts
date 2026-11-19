/**
 * What it takes to create a golden sandbox company through self-serve onboarding: the request body and the fixed key. Pure (no
 * Playwright), so the specs' find-or-create (../_migrationSandbox.ts) and the post-deploy verify company's provisioner
 * (scripts/deploy/verifyCompany) send the SAME request: the provisioner makes the migration sandbox once, and the spec then finds it.
 */

/** A dedicated sandbox company: found by name, created on first use under a fixed key. */
export interface SandboxSpec { name: string; onboardingId: string }

/** Fixed onboarding key of the migration-wizard sandbox: a repeat create returns the same company (migration 895). */
export const MIGRATION_SANDBOX_ONBOARDING_ID = '6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';

/** The body of POST /api/onboarding/complete-setup for `spec`: entity 'other' (the one with no proof document), the standard chart. */
export function sandboxSetupBody(spec: SandboxSpec): Record<string, unknown> {
  return {
    requestKey: spec.onboardingId,
    entityType: 'other',
    coaTemplate: 'isaflow_standard',
    company: { name: spec.name, vatPeriod: 'bi-monthly', vatNumber: '4000000000' },
    people: [],
    documents: [],
  };
}
