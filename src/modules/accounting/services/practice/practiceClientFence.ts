/**
 * Practice client tenant fence (R-073).
 *
 * Every column that points at `practice_clients` (`practice_client_contacts.client_id`,
 * `practice_jobs.practice_client_id`, `practice_entry_templates.practice_client_id`, …)
 * carries a tenant-agnostic FK, and each table's RLS WITH CHECK tests only the
 * row's OWN company_id. So a caller-supplied practice client id is never checked
 * against the caller's company unless the write path reads `practice_clients`
 * itself. Same contract as `assertCustomerInCompany` (R-067):
 *
 * - call it BEFORE the first write (withAuth COMMITs a 4xx returned after one);
 * - an absent id is not a refusal — the caller decides whether one is required;
 * - the read takes a SAVEPOINT, so a malformed id (22P02) is refused instead of
 *   aborting the request transaction; any other error propagates;
 * - it asks only about the tenant, not `status`: an update may keep pointing at
 *   the company's own archived client.
 */

import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/types/db';

/** Refusal raised when a practice client id is not this company's. Routes answer 400. */
export class PracticeClientNotInCompanyError extends Error {
  readonly code = 'PRACTICE_CLIENT_NOT_FOUND';
  constructor(clientId: string) {
    super(`Practice client ${clientId} was not found for this company`);
    this.name = 'PracticeClientNotInCompanyError';
  }
}

/** Sequenced: Postgres shadows a re-declared savepoint name. */
let fenceSeq = 0;

export async function assertPracticeClientInCompany(
  companyId: string,
  clientId: string | null | undefined,
): Promise<void> {
  if (!clientId) return;
  const owned = await withSavepoint(`pc_own_${++fenceSeq}`, async () => {
    const rows = (await sql`
      SELECT 1 FROM practice_clients WHERE id = ${clientId}::uuid AND company_id = ${companyId}::uuid LIMIT 1
    `) as DbRow[];
    return rows.length > 0;
  }).catch((err: unknown) => {
    // 22P02 invalid_text_representation — the id is not even a UUID.
    if ((err as { code?: string }).code === '22P02') return false;
    throw err;
  });
  if (!owned) throw new PracticeClientNotInCompanyError(clientId);
}
