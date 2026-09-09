import { provisionForensicFixture, type FixtureConfig } from '../../tests/integration/forensic-fixture';

/** Dedicated environment names prevent accidental use of application/production URLs. */
export function fixtureConfigFromEnv(env: NodeJS.ProcessEnv): FixtureConfig {
  return {
    optIn: env.ISAFLOW_FORENSIC_FIXTURE_OPT_IN,
    databaseUrl: env.ISAFLOW_FORENSIC_FIXTURE_URL,
    generatedPort: env.ISAFLOW_FORENSIC_FIXTURE_PORT,
    fixtureLabel: env.ISAFLOW_FORENSIC_FIXTURE_LABEL,
  };
}

/** Import this for HTTP tests; returned PAT plaintext is never printed by the CLI. */
export async function bootstrapFixture(env: NodeJS.ProcessEnv = process.env) {
  return provisionForensicFixture(fixtureConfigFromEnv(env));
}

if (process.argv[1]?.endsWith('/fixture-bootstrap.ts')) {
  bootstrapFixture().then(fixture => {
    process.stdout.write(JSON.stringify({ runId: fixture.runId, companyA: fixture.companyA,
      companyB: fixture.companyB, userIds: [fixture.u1.id, fixture.u2.id, fixture.u3.id],
      tokenCount: 4, note: 'Synthetic token plaintext is available only to programmatic callers.' }) + '\n');
  }).catch(() => {
    // Driver errors may contain connection details; do not echo them or environment values.
    process.stderr.write('Forensic fixture provisioning failed; check disposable target and schema.\n');
    process.exitCode = 1;
  });
}
