/**
 * Shared Zod schema primitives for Phase 4B MVP input validation (BL-33).
 *
 * These are the building blocks that per-handler schemas compose. If you find
 * yourself repeating the same shape across 3+ handlers, promote it here.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { apiResponse } from '@/lib/apiResponse';

/**
 * An id in `uuid` shape — 8-4-4-4-12 hex.
 *
 * `z.guid()`, NOT `z.uuid()`. Zod 4 made `.uuid()` enforce the RFC 4122 version
 * and variant nibbles, and that is stricter than the database this validates
 * for: Postgres's `uuid` type stores any 128-bit value and cares nothing for
 * version bits. An API stricter than its own storage layer can refuse a row
 * that legitimately exists.
 *
 * Which is exactly what happened. `00000000-0000-0000-0000-000000000001` — the
 * seeded ISAFlow Demo company — is version 0 and not the nil UUID, the one
 * shape Zod 4 refuses (it blesses nil and max as RFC 9562 special cases). Every
 * endpoint validating a company_id with this schema returned 400 for that
 * tenant, including the tenant-facing company-logo and AFS
 * management-pack-config routes. Zod 3's `.uuid()` accepted it, so the
 * behaviour changed with the Zod 4 upgrade rather than with any code change —
 * which is why it went unnoticed.
 *
 * `z.guid()` still rejects anything malformed; it only drops the version check.
 */
export const UUID = z.guid('Must be a valid UUID');

/**
 * Extract a UUID from `req.query[name]` or return null after sending a 400.
 * Removes the inline `UUID.safeParse(req.query.X)` boilerplate from handlers.
 *
 * Usage:
 *   const documentId = requireUuidParam(req, res, 'documentId');
 *   if (!documentId) return;
 */
export function requireUuidParam(
  req: NextApiRequest,
  res: NextApiResponse,
  name: string,
): string | null {
  const parsed = UUID.safeParse(req.query[name]);
  if (!parsed.success) {
    apiResponse.badRequest(res, `${name} must be a valid UUID`);
    return null;
  }
  return parsed.data;
}

/** A date string in `YYYY-MM-DD` format (SA accounting convention). */
export const ISODate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');

/** A non-negative currency amount with at most 2 decimal places. */
export const Currency = z.number().nonnegative().multipleOf(0.01);

/** A non-empty string. */
export const NonEmptyString = z.string().min(1);

/** An RFC-compliant email address. */
export const Email = z.string().email();

/** A VAT rate as a percentage (0–100). */
export const VatRate = z.number().min(0).max(100);

/** An optional free-text reference, capped at 100 chars. */
export const Reference = z.string().max(100).optional();
