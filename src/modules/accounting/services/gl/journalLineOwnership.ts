/**
 * Every caller-supplied id on a journal line must name a row of the SESSION's
 * company — the account and the three dimensions alike.
 *
 * `validateJournalEntry` is pure — it sees only debits and credits — and
 * `pages/api/accounting/journal-entries.ts` passes `lines` through from the
 * request body untouched, while `createJournalEntry` stamps `company_id` from
 * the session. So every id on a line arrives unchecked from the caller:
 *
 * - `gl_account_id`: `gl_journal_lines_gl_account_id_fkey` is a SINGLE-column
 *   FK to `gl_accounts(id)`, so another tenant's account satisfied it and the
 *   row was written with a `company_id` that disagreed with its own account's.
 *   RI checks bypass RLS, so nothing else stopped it — a cross-tenant write on
 *   the ledger. `create_draft_journal` (`writeJournals.ts`) has always refused
 *   it; this is the same refusal on the REST path. Migration 664 adds the
 *   composite FK that makes the pair unrepresentable.
 * - `cc1_id` / `cc2_id`: the two analysis columns, checked by
 *   `assertJournalCostCentres` (`journalCostCentreValidation.ts`) and delegated
 *   to from here so `createJournalEntry` has ONE assertion to call and no id on
 *   a new line can be added to the INSERT without a home in this module. That
 *   check deliberately does NOT require `is_active`: withdrawing a cost centre
 *   from the picker must not block correcting the history coded to it.
 * - `project_id`, `cost_center_id`, `bu_id`: these carry NO foreign key at all,
 *   so a line can be tagged to a dimension this company cannot see or manage,
 *   invisible to every dimension filter and to `costCentreService`'s
 *   company-scoped usage guard — which lets the OWNING tenant delete the row
 *   out from under it. Mostly integrity rather than exposure — the reports
 *   filter on these columns — with one exception: `projectProfitabilityService`
 *   enumerates `DISTINCT jl.project_id` and LEFT JOINs `projects` for a name,
 *   so a foreign tag rendered another company's project name until that join
 *   was scoped (same shape in `ar/invoicePdfBuilder`). Either way it is the
 *   same defect on the same INSERT.
 *
 * THE BOUNDARY. This is a check on what a CALLER ASSERTS about a new line. TWO
 * writers assert nothing — they COPY the three dimensions off a HISTORICAL
 * posted line, which may already hold a foreign id, the very rows this defect
 * created:
 *
 * - `reclassification/journals.ts` — refusing would unwind a whole remediation
 *   batch over one legacy tag. See `reclassification/dimensions.ts`.
 * - `journalEntryPostingService#reverseJournalEntry` — refusing would leave the
 *   entry permanently un-reversible, and reversal is the ONLY correction
 *   mechanism in this schema (supplier-invoice cancel, credit-note cancel, the
 *   MCP `reverse_journal_entry` tool and nine other callers all route through
 *   it). See `reversalLines.ts`.
 *
 * Both resolve ownership themselves through `ownedDimensions` and drop what
 * they do not own, per line and per dimension, with a `log.warn` and a warning
 * the operator sees. Every other caller stays refused — including these two on
 * the ACCOUNT arm, which cannot be dropped (a line needs an account) and which
 * migration 664's composite FK refuses on the new row regardless.
 */

import { sql } from '@/lib/neon';
import { accountsBelongToCompany } from './chartOfAccountsService';
import { assertJournalCostCentres } from './journalCostCentreValidation';
import type { JournalLineInput } from '../../types/gl.types';

type Dimension = 'project' | 'cost centre' | 'business unit';

/** Which of `ids` (already unique, non-empty) belong to companyId. */
async function ownedIds(dimension: Dimension, companyId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = (dimension === 'project'
    ? await sql`SELECT id FROM projects WHERE company_id = ${companyId}::uuid AND id = ANY(${ids}::uuid[])`
    : dimension === 'cost centre'
      ? await sql`SELECT id FROM cost_centres WHERE company_id = ${companyId}::uuid AND id = ANY(${ids}::uuid[])`
      : await sql`SELECT id FROM business_units WHERE company_id = ${companyId}::uuid AND id = ANY(${ids}::uuid[])`
  ) as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

const present = (values: readonly (string | null | undefined)[]): string[] =>
  [...new Set(values.filter((v): v is string => typeof v === 'string' && v !== ''))];

async function assertDimensionOwned(
  dimension: Dimension,
  companyId: string,
  values: (string | undefined)[],
): Promise<void> {
  const unique = present(values);
  if (unique.length === 0) return;
  if ((await ownedIds(dimension, companyId, unique)).size !== unique.length) {
    throw new Error(`One or more journal lines name a ${dimension} outside this company`);
  }
}

export interface DimensionRefs {
  project: readonly (string | null | undefined)[];
  costCentre: readonly (string | null | undefined)[];
  businessUnit: readonly (string | null | undefined)[];
}

export interface OwnedDimensions {
  project: ReadonlySet<string>;
  costCentre: ReadonlySet<string>;
  businessUnit: ReadonlySet<string>;
}

/**
 * Which of the ids in `refs` this company actually owns — the same three reads
 * as the assertion above, without the refusal.
 *
 * For the two callers that do not assert a caller's claim but carry a
 * HISTORICAL value forward: see `reclassification/dimensions.ts` and
 * `reversalLines.ts`. Resolved once for the whole batch, so a 400-journal
 * reclassification pays three SELECTs and not three per journal.
 */
export async function ownedDimensions(companyId: string, refs: DimensionRefs): Promise<OwnedDimensions> {
  return {
    project: await ownedIds('project', companyId, present(refs.project)),
    costCentre: await ownedIds('cost centre', companyId, present(refs.costCentre)),
    businessUnit: await ownedIds('business unit', companyId, present(refs.businessUnit)),
  };
}

/**
 * The id when this company owns it, `null` when it does not or there is none —
 * the one decision both copy-forward paths make, so they cannot drift apart on
 * what counts as "owned".
 */
export function ownedOrNull(owned: ReadonlySet<string>, id: string | null | undefined): string | null {
  return typeof id === 'string' && id !== '' && owned.has(id) ? id : null;
}

/**
 * Throws before anything is written if any line names a GL account, project,
 * cost centre, business unit or CC1/CC2 analysis code belonging to another
 * company.
 */
export async function assertJournalLinesOwned(companyId: string, lines: JournalLineInput[]): Promise<void> {
  if (!(await accountsBelongToCompany(companyId, lines.map((l) => l.glAccountId)))) {
    throw new Error('One or more journal lines name a GL account outside this company');
  }
  await assertDimensionOwned('project', companyId, lines.map((l) => l.projectId));
  await assertDimensionOwned('cost centre', companyId, lines.map((l) => l.costCenterId));
  await assertDimensionOwned('business unit', companyId, lines.map((l) => l.buId));
  await assertJournalCostCentres(companyId, lines);
}
