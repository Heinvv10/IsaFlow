/**
 * Shared Zod schema primitives for AFS (Annual Financial Statements) endpoints.
 *
 * Hoisted from per-handler inline schemas to give a single source of truth
 * for AFS enums and the shapes that recur across endpoints.
 */

import { z } from 'zod';
import { UUID } from './common';

/** Document type — drives the discriminated-union refines on POST /afs. */
export const DocumentTypeEnum = z.enum(['afs', 'management_pack']);

/** Reporting framework — used by AFS create + section regenerate. */
export const ReportingFrameworkEnum = z.enum(['ifrs_smes', 'full_ifrs']);

/** Portal contact role — used by portal-contacts create + update endpoints. */
export const PortalRoleEnum = z.enum([
  'director',
  'cfo',
  'shareholder_readonly',
  'external_auditor',
]);

/** Entity type for PIS score (Public Interest Score). */
export const EntityTypeEnum = z.enum(['pty', 'cc', 'trust']);

/** Pack-style options for management pack PDF rendering. */
export const PackStyleEnum = z.enum(['executive', 'detailed', 'board']);

/** Comparison-mode options for management pack columns. */
export const ComparisonModeEnum = z.enum([
  'prior_month',
  'prior_year',
  'budget',
  'all_three',
]);

/** Currency-display granularity in management pack output. */
export const CurrencyDisplayEnum = z.enum(['full', 'thousands', 'millions']);

/** Recipient delivery filter — which generation tier(s) they receive. */
export const RecipientReceivesEnum = z.enum(['draft', 'final', 'both']);

/** A single account-mapping pair for the bulk and per-account endpoints. */
export const AfsAccountMappingSchema = z.object({
  glAccountId: UUID,
  afsLineCode: z.string().min(1).max(50),
}).strict();

/** A pack-config recipient. */
export const PackRecipientSchema = z.object({
  email: z.string().email().max(254),
  role: z.string().min(1).max(100),
  receives: RecipientReceivesEnum,
}).strict();
