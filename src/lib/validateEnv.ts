const REQUIRED_VARS = ['DATABASE_URL', 'JWT_SECRET'] as const;
const RECOMMENDED_VARS = ['ENCRYPTION_KEY', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'] as const;

export function validateEnv(): void {
  const missing = REQUIRED_VARS.filter(v => !process.env[v]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  const missingRecommended = RECOMMENDED_VARS.filter(v => !process.env[v]);
  if (missingRecommended.length > 0) {
    console.warn(`[env] Missing recommended variables: ${missingRecommended.join(', ')}`);
  }
}
