/// <reference types="node" />
/**
 * Shared credential accessor for E2E tests and probe scripts.
 *
 * Pentest M5: fail loudly if the env vars are missing instead of falling back
 * to a hardcoded 'admin123'. Previously every test that logged in had the
 * literal password in source — grepping CI artefacts surfaced it, and a CI
 * runner without the env var would attempt to log into prod with that value.
 *
 * Set E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD in the environment before running
 * anything under tests/e2e/ or the pdf-qa-test*.ts probe scripts.
 */

export interface E2ECredentials {
  email: string;
  password: string;
}

export function getE2ECredentials(): E2ECredentials {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD must be set in the environment before running E2E tests or probe scripts. ' +
        'Set them in .env.local (and make sure your test runner loads it) or export them in your shell.',
    );
  }
  return { email, password };
}
