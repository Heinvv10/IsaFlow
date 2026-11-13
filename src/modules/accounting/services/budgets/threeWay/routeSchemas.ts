/**
 * Input schemas of the three-way routes (P6 spec §7). Snake-case on the wire,
 * as the spec names them. A shape failure is the routes' zod answer
 * (`apiResponse.zodValidationError`, 422, the grid save's precedent); the
 * assumptions DOCUMENT is validated by the service (`parseStoredDoc`), which
 * answers 400 BUDGET_ASSUMPTIONS_INVALID listing every issue by path.
 */
import { z } from 'zod';
import { UUID } from '@/lib/schemas/common';
import { isVersionToken } from '../gridErrors';
import { MAX_COMPARE_VERSIONS } from './compare';

/** The dark feature flag (migration 983): every route answers 403 without it. */
export const THREE_WAY_FEATURE = 'budgets_three_way';

/* A repeated query key reaches the handler as an array: every query field is a string, so it is refused. */
export const ThreeWayQuerySchema = z.object({
  version_id: UUID.optional(),
  fiscal_year: z.string().regex(/^\d{4}$/, 'fiscal_year must be a 4-digit year').transform(Number).optional(),
});

export const VersionQuerySchema = z.object({ version_id: UUID });

/** The row token (`updatedAt` as read), or null when no assumptions were stored yet. */
const RowToken = z.string().max(40).refine(isVersionToken, 'expected_updated_at must be the updatedAt the assumptions were read with');

export const AssumptionsPutSchema = z.object({
  version_id: UUID,
  doc: z.record(z.string(), z.unknown()),
  expected_updated_at: RowToken.nullable(),
}).strict();

export const DeriveBodySchema = z.object({ version_id: UUID }).strict();

export const CompareQuerySchema = z.object({
  version_ids: z.string().max(200).transform((s) => s.split(',').map((x) => x.trim()).filter((x) => x !== ''))
    .pipe(z.array(UUID).min(1).max(MAX_COMPARE_VERSIONS)),
});
