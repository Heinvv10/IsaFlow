/**
 * The migration template download URL. The templates API is keyed by the
 * session's source system; five wizard pages called it without one and got a
 * validation error instead of a file. Always send one — `other` (the generic
 * template) when the session has none.
 */
export function templateUrl(step: string, sourceSystem: string | null | undefined): string {
  const source = sourceSystem && sourceSystem.trim() ? sourceSystem.trim() : 'other';
  return `/api/accounting/migration/templates?sourceSystem=${encodeURIComponent(source)}&step=${encodeURIComponent(step)}`;
}
