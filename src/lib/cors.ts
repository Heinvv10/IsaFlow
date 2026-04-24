// src/lib/cors.ts
// Single source of truth for CORS allow-lists. Pentest M11 — previously
// duplicated in api-error-handler.ts and apiResponse.ts.

export const CORS_ALLOWED_ORIGINS: readonly string[] = Object.freeze([
  'https://app.isaflow.co.za',
  'https://admin.isaflow.co.za',
  'https://isaflow.co.za',
  ...(process.env.NODE_ENV === 'development'
    ? ['http://localhost:3101', 'http://localhost:3004']
    : []),
]);

/** Returns the safe echo origin, or '' if the caller's Origin is not in the allow-list. */
export function safeCorsOrigin(origin: string | undefined): string {
  if (!origin) return '';
  return CORS_ALLOWED_ORIGINS.includes(origin) ? origin : '';
}
