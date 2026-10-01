/**
 * Type check for the body of an account update, before it reaches a service.
 *
 * The services decide on `isActive === true` / `=== false`. A JSON body can
 * carry `"true"`, `1` or `[true]` instead: none is strictly a boolean, so the
 * guards were skipped, and Postgres then cast the value and applied it — a
 * former role holder reactivated beside the current one, or the holder
 * switched off. Types only; every business rule stays in the service.
 */
const VAT_CODES = ['none', 'standard', 'zero_rated', 'exempt'];
const isText = (v: unknown) => v === undefined || v === null || typeof v === 'string';

/** Why `body` cannot be an account update, or null. */
export function accountUpdateBodyError(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'A JSON object body is required';
  const b = body as Record<string, unknown>;
  if (b.isActive !== undefined && typeof b.isActive !== 'boolean') return 'isActive must be true or false';
  if (b.vatInputDenied != null && typeof b.vatInputDenied !== 'boolean') return 'vatInputDenied must be true or false';
  for (const key of ['accountName', 'description', 'accountSubtype', 'parentAccountId', 'accountCode']) {
    if (!isText(b[key])) return `${key} must be text`;
  }
  if (b.defaultVatCode != null && b.defaultVatCode !== '' && !VAT_CODES.includes(b.defaultVatCode as string)) {
    return `defaultVatCode must be one of: ${VAT_CODES.join(', ')}`;
  }
  if (b.displayOrder != null && !(typeof b.displayOrder === 'number' && Number.isFinite(b.displayOrder))) {
    return 'displayOrder must be a number';
  }
  return null;
}

/**
 * Is this the service saying no, rather than something breaking?
 *
 * The chart services refuse with a bare `Error`. A driver error carries a
 * SQLSTATE `code`, and a bug is a TypeError/RangeError subclass — neither may
 * be answered 4xx, because `withAuth` COMMITS below 500.
 */
export function isServiceRefusal(err: unknown): err is Error {
  return err instanceof Error && Object.getPrototypeOf(err) === Error.prototype
    && (err as { code?: unknown }).code === undefined;
}
