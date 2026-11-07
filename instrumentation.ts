import * as Sentry from '@sentry/nextjs';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Fail-closed env validation: DATABASE_URL, JWT_SECRET, ENCRYPTION_KEY
    // must be present before the first request. encryptToken has a silent
    // plaintext fallback — without this boot check, it could land tokens
    // unencrypted in the DB.
    const { validateEnv } = await import('./src/lib/validateEnv');
    validateEnv();
    await import('./sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

// Server errors from route handlers, server components and middleware reach Sentry/Bugsink (Next.js onRequestError hook).
export const onRequestError = Sentry.captureRequestError;
