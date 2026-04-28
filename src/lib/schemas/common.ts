/**
 * Shared Zod schema primitives for Phase 4B MVP input validation (BL-33).
 *
 * These are the building blocks that per-handler schemas compose. If you find
 * yourself repeating the same shape across 3+ handlers, promote it here.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { apiResponse } from '@/lib/apiResponse';

/** A v4 UUID. */
export const UUID = z.string().uuid('Must be a valid UUID');

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
