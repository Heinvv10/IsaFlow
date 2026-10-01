/**
 * Type check for the body of an account update, before it reaches a service.
 *
 * The services decide on `isActive === true` / `=== false`. A JSON body can
 * carry `"true"`, `1` or `[true]` instead: none is strictly a boolean, so the
 * guards were skipped, and Postgres then cast the value and applied it — a
 * former role holder reactivated beside the current one, or the holder
 * switched off. Types only; every business rule stays in the service.
 */
import { UUID_RE } from '@/lib/validation';
import { ChartRefusal } from '@/modules/accounting/services/gl/chartRefusal';

const isText = (v: unknown) => v === undefined || v === null || typeof v === 'string';

/** Why `body` cannot be an account update, or null. */
export function accountUpdateBodyError(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'A JSON object body is required';
  const b = body as Record<string, unknown>;
  if (b.isActive !== undefined && typeof b.isActive !== 'boolean') return 'isActive must be true or false';
  if (b.vatInputDenied != null && typeof b.vatInputDenied !== 'boolean') return 'vatInputDenied must be true or false';
  for (const key of ['accountName', 'description', 'accountSubtype', 'parentAccountId', 'accountCode', 'accountType', 'normalBalance', 'defaultVatCode']) {
    if (!isText(b[key])) return `${key} must be text`;
  }
  // Ids go into ::UUID casts after the role lock is taken: a malformed one was a 500.
  for (const key of ['id', 'parentAccountId']) {
    if (typeof b[key] === 'string' && b[key] !== '' && !UUID_RE.test(b[key] as string)) return `${key} must be an account id`;
  }
  if (b.displayOrder != null && !(typeof b.displayOrder === 'number' && Number.isFinite(b.displayOrder))) {
    return 'displayOrder must be a number';
  }
  return null;
}

/**
 * Is this the service saying no, rather than something breaking? By TYPE, never
 * by "it has no code": node-postgres raises code-less Errors for a dropped
 * connection or a read timeout, and answering those 4xx would COMMIT.
 */
export function isServiceRefusal(err: unknown): err is ChartRefusal {
  return err instanceof ChartRefusal;
}
