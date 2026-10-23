/**
 * The service pool's URL (S-07b). The `sql` fallback pool and the rate-limit
 * pool serve every statement with no request transaction (crons, after-commit
 * work, public routes, login), so in production they log in as isaflow_service
 * (migration 915), not as the request pools' isaflow_app. Falls back to
 * DATABASE_URL until the env names it; validateEnv refuses the fallback once
 * DATABASE_URL is isaflow_app.
 */
export function serviceDatabaseUrl(): string {
  const url = process.env.SERVICE_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set. Please configure it in your environment.');
  }
  return url;
}
