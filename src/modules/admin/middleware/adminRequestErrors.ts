/**
 * Admin API status codes (admin audit 2026-11-14, section 6).
 *
 * A request transaction COMMITS on any answer below 500 (withPlatformAdmin), so an admin route may answer 4xx
 * only for a KNOWN refusal, raised before anything was written. Everything unexpected must propagate:
 * withErrorHandler answers 500 and withPlatformAdmin rolls the request back. The known refusal is
 * AdminRequestError (bad input, or a domain refusal: not found, conflict), thrown before any write; withAdmin
 * answers it (respondIfAdminRequestError), so routes need no catch of their own. A Postgres integrity refusal is
 * NOT mapped here: only a route that knows the failing statement was its first write may answer it as a 4xx
 * (isPgError), because a later savepointed failure would let the COMMIT keep the writes before it.
 *
 * Input helpers (adminUuid, adminPaging, adminDate) validate what reaches a SQL cast BEFORE any SQL runs: a
 * malformed id or page is the caller's mistake (400), not a 500 from Postgres.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { isRealCalendarDate, isRealTimestamp, UUID_RE } from '@/lib/validation';

const CODE_FOR_STATUS = {
  400: ErrorCode.BAD_REQUEST,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  409: ErrorCode.CONFLICT,
} as const;

export type AdminRefusalStatus = keyof typeof CODE_FOR_STATUS;

/** A known refusal of an admin request, raised before anything was written. withAdmin answers it. */
export class AdminRequestError extends Error {
  constructor(readonly status: AdminRefusalStatus, message: string) {
    super(message);
    this.name = 'AdminRequestError';
  }
}

/** Answers a known refusal and returns true; returns false for anything else, which the caller must rethrow. */
export function respondIfAdminRequestError(res: NextApiResponse, err: unknown): boolean {
  if (err instanceof AdminRequestError) {
    apiResponse.error(res, CODE_FOR_STATUS[err.status], err.message);
    return true;
  }
  return false;
}

/**
 * A Postgres error with this SQLSTATE (e.g. '23505' unique violation) on one of these constraints: a route maps only
 * the refusal it expects (review #1405 L1), never another constraint's failure (that stays a 500).
 */
export function isPgError(err: unknown, sqlState: string, constraint: string | readonly string[]): boolean {
  const e = err as { code?: unknown; constraint?: unknown } | null;
  const names: readonly string[] = typeof constraint === 'string' ? [constraint] : constraint;
  return e?.code === sqlState && typeof e.constraint === 'string' && names.includes(e.constraint);
}

/**
 * `handler` with its AdminRequestErrors answered (respondIfAdminRequestError) and everything else rethrown. withAdmin
 * wraps every admin route in it; a unit test that mocks withAdmin away can wrap the route in it the same way.
 */
export function withAdminRefusals<Req extends NextApiRequest>(
  handler: (req: Req, res: NextApiResponse) => Promise<void> | void,
): (req: Req, res: NextApiResponse) => Promise<void> {
  return async (req, res) => {
    try {
      assertCleanAdminQuery(req.query);
      await handler(req, res);
    } catch (err) {
      if (respondIfAdminRequestError(res, err)) return;
      throw err;
    }
  };
}

/**
 * Every admin query parameter, before any route reads one (breaker #1405 B3/B4): a repeated parameter (an array)
 * reached services typed as a string (a TypeError, or an array bound as text), and a NUL byte reached Postgres as
 * "invalid byte sequence 0x00". Both are the caller's mistake: 400. No admin route takes a repeated parameter.
 */
export function assertCleanAdminQuery(query: NextApiRequest['query'] | undefined): void {
  for (const [key, value] of Object.entries(query ?? {})) {
    if (Array.isArray(value)) throw new AdminRequestError(400, `${key} must be given once`);
    if (typeof value === 'string' && value.includes('\u0000')) throw new AdminRequestError(400, `${key} must not contain a NUL character`);
  }
}

/** A required UUID (a path id): throws a 400 AdminRequestError when it is missing, repeated or malformed. */
export function adminUuid(value: unknown, name = 'id'): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw new AdminRequestError(400, `Invalid ${name}`);
  return value;
}

/**
 * A user id from the path. users.id is TEXT (GoTrue's ids are UUIDs, but the column admits others), so no cast
 * can fail on it and a strict UUID check could lock a legacy row out of the console: this refuses only what can
 * never be an id (missing, repeated, empty, over 255 characters, or outside [A-Za-z0-9._:@-]).
 */
export function adminUserId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:@-]{1,255}$/.test(value)) throw new AdminRequestError(400, 'Invalid user id');
  return value;
}

/** An optional UUID filter: undefined when absent or empty, else as adminUuid. */
export function adminOptionalUuid(value: unknown, name: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  return adminUuid(value, name);
}

/** An optional calendar date filter (YYYY-MM-DD, a real date): undefined when absent or empty. */
export function adminOptionalDate(value: unknown, name: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !isRealCalendarDate(value)) throw new AdminRequestError(400, `${name} must be a date (YYYY-MM-DD)`);
  return value;
}

/** An optional timestamp filter (ISO 8601 or a calendar date) for a TIMESTAMPTZ cast. */
export function adminOptionalTimestamp(value: unknown, name: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !(isRealTimestamp(value) || isRealCalendarDate(value))) {
    throw new AdminRequestError(400, `${name} must be a date or timestamp`);
  }
  return value;
}

/** Postgres int4's largest value: the default ceiling, so a number never overflows an integer column or bind. */
export const INT4_MAX = 2147483647;

/** One optional positive whole number from the query string (page, limit, ...), at most `max` (default int4). */
export function adminPositiveInt(value: unknown, name: string, max = INT4_MAX): number | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) {
    throw new AdminRequestError(400, `${name} must be a whole number from 1 to ${max}`);
  }
  return Number(value);
}

/** One optional whole number of at least 0 from the query string (an offset). */
export function adminNonNegativeInt(value: unknown, name: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) > INT4_MAX) {
    throw new AdminRequestError(400, `${name} must be a whole number from 0 to ${INT4_MAX}`);
  }
  return Number(value);
}

/** `page` and `limit` from the query string: absent stays undefined (the service default), garbage is a 400. */
export function adminPaging(query: Record<string, unknown>): { page?: number; limit?: number } {
  return { page: adminPositiveInt(query.page, 'page'), limit: adminPositiveInt(query.limit, 'limit') };
}
