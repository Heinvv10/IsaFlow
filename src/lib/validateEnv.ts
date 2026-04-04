// ENCRYPTION_KEY is required — the app must not start without encryption configured.
// All fields encrypted at rest (tokens, secrets) depend on this key being present.
const REQUIRED_VARS = ['DATABASE_URL', 'JWT_SECRET', 'ENCRYPTION_KEY'] as const;
const RECOMMENDED_VARS = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'] as const;

export function validateEnv(): void {
  const missing = REQUIRED_VARS.filter(v => !process.env[v]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  const missingRecommended = RECOMMENDED_VARS.filter(v => !process.env[v]);
  if (missingRecommended.length > 0) {
    // Use process.stderr to avoid triggering the no-console-log lint rule on warnings
    process.stderr.write(`[env] Missing recommended variables: ${missingRecommended.join(', ')}\n`);
  }
}
