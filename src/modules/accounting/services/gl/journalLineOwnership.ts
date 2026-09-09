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
 * - `project_id`, `cost_center_id`, `bu_id`: these carry NO foreign key at all,
 *   so a line can be tagged to a dimension this company cannot see or manage,
 *   invisible to every dimension filter and to `costCentreService`'s
 *   company-scoped usage guard — which lets the OWNING tenant delete the row
 *   out from under it. There is no read-side disclosure (the reports filter on
 *   these columns, none joins the dimension table for a name), so this is
 *   integrity, not exposure — but it is the same defect on the same INSERT.
 */

import { sql } from '@/lib/neon';
import { accountsBelongToCompany } from './chartOfAccountsService';
import type { JournalLineInput } from '../../types/gl.types';

type Dimension = 'project' | 'cost centre' | 'business unit';

/** How many of `ids` (already unique, non-empty) belong to companyId. */
async function ownedCount(dimension: Dimension, companyId: string, ids: string[]): Promise<number> {
  const rows = (dimension === 'project'
    ? await sql`SELECT id FROM projects WHERE company_id = ${companyId}::uuid AND id = ANY(${ids}::uuid[])`
    : dimension === 'cost centre'
      ? await sql`SELECT id FROM cost_centres WHERE company_id = ${companyId}::uuid AND id = ANY(${ids}::uuid[])`
      : await sql`SELECT id FROM business_units WHERE company_id = ${companyId}::uuid AND id = ANY(${ids}::uuid[])`
  ) as { id: string }[];
  return rows.length;
}

async function assertDimensionOwned(
  dimension: Dimension,
  companyId: string,
  values: (string | undefined)[],
): Promise<void> {
  const unique = [...new Set(values.filter((v): v is string => typeof v === 'string' && v !== ''))];
  if (unique.length === 0) return;
  if ((await ownedCount(dimension, companyId, unique)) !== unique.length) {
    throw new Error(`One or more journal lines name a ${dimension} outside this company`);
  }
}

/**
 * Throws before anything is written if any line names a GL account, project,
 * cost centre or business unit belonging to another company.
 */
export async function assertJournalLinesOwned(companyId: string, lines: JournalLineInput[]): Promise<void> {
  if (!(await accountsBelongToCompany(companyId, lines.map((l) => l.glAccountId)))) {
    throw new Error('One or more journal lines name a GL account outside this company');
  }
  await assertDimensionOwned('project', companyId, lines.map((l) => l.projectId));
  await assertDimensionOwned('cost centre', companyId, lines.map((l) => l.costCenterId));
  await assertDimensionOwned('business unit', companyId, lines.map((l) => l.buId));
}
