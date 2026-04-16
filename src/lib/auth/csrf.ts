import type { NextApiRequest } from 'next';

export const CSRF_COOKIE = 'isaflow_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export function generateCsrfToken(): string {
  // Web Crypto API — works in both Node.js and Edge runtime (middleware).
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function verifyCsrf(req: NextApiRequest): boolean {
  const cookie = req.cookies[CSRF_COOKIE];
  const headerVal = req.headers[CSRF_HEADER];
  const header = Array.isArray(headerVal) ? headerVal[0] : headerVal;
  if (!cookie || !header) return false;
  if (cookie.length < 32 || header.length < 32) return false;
  return cookie === header;
}
