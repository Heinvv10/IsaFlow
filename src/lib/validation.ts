export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidDate(s: string): boolean {
  return DATE_RE.test(s) && !isNaN(Date.parse(s));
}

export function isValidUUID(s: string): boolean {
  return UUID_RE.test(s);
}

export function safeInt(value: unknown, fallback: number, max = 1000): number {
  const n = parseInt(String(value), 10);
  return isNaN(n) ? fallback : Math.min(Math.max(n, 1), max);
}
