/**
 * sagePartyMatch.ts
 *
 * Which existing IsaFlow supplier / customer a pulled Sage party is (#1655).
 * The Sage commit used to match on `LOWER(name) = LOWER(<sage name>)` alone, over
 * every row, deleted or not. Three ways that lost a Sage party:
 *
 * - a SOFT-DELETED row of the same name matched, so the party was counted as
 *   "skipped" and stayed invisible in IsaFlow;
 * - two distinct Sage parties whose names differ only in case or surrounding
 *   spaces collapsed into the first one;
 * - the insert stored the trimmed name but the match compared the untrimmed one,
 *   so a name with a trailing space was re-created on every re-sync.
 *
 * Now: a live row carrying the same Sage id (`external_system = 'sage'`,
 * `external_ref = <Sage ID>`) wins; failing that, a live row whose trimmed,
 * case-folded name is the same and which is not already another Sage party's.
 * The commit stamps the Sage id on every row it creates, and on an unstamped row
 * it matched by name (claimSageSupplier / claimSageCustomer), so a re-sync finds
 * it by id and a second Sage party of the same name gets its own row. A soft-deleted (or merged-away) row is never matched: the party is created
 * again, live, as the K-061 decision already does for merged customers.
 */

import { sql } from '@/lib/neon';
import type { Row } from './sageMigrationTypes';

/** The Sage id as stored in external_ref, or null when the pull carried none. */
export function sageRef(sageId: number | string | null | undefined): string | null {
  if (sageId === null || sageId === undefined) return null;
  const ref = String(sageId).trim();
  return ref === '' ? null : ref;
}

export async function findSageSupplier(
  companyId: string, party: { name: string; sageId?: number | string | null },
): Promise<string | null> {
  const ref = sageRef(party.sageId);
  const rows = (await sql`
    SELECT id FROM suppliers
    WHERE company_id = ${companyId}::UUID AND deleted_at IS NULL
      AND (
        (external_system = 'sage' AND external_ref = ${ref}::TEXT)
        OR (LOWER(BTRIM(name)) = LOWER(BTRIM(${party.name}))
            AND (${ref}::TEXT IS NULL OR external_system IS DISTINCT FROM 'sage' OR external_ref IS NULL))
      )
    ORDER BY (external_system = 'sage' AND external_ref = ${ref}::TEXT) IS TRUE DESC, created_at, id
    LIMIT 1
  `) as Row[];
  return rows.length ? String(rows[0]!.id) : null;
}

export async function findSageCustomer(
  companyId: string, party: { name: string; sageId?: number | string | null },
): Promise<string | null> {
  const ref = sageRef(party.sageId);
  const rows = (await sql`
    SELECT id FROM customers
    WHERE company_id = ${companyId}::UUID AND deleted_at IS NULL
      AND (
        (external_system = 'sage' AND external_ref = ${ref}::TEXT)
        OR (LOWER(BTRIM(name)) = LOWER(BTRIM(${party.name}))
            AND (${ref}::TEXT IS NULL OR external_system IS DISTINCT FROM 'sage' OR external_ref IS NULL))
      )
    ORDER BY (external_system = 'sage' AND external_ref = ${ref}::TEXT) IS TRUE DESC, created_at, id
    LIMIT 1
  `) as Row[];
  return rows.length ? String(rows[0]!.id) : null;
}

/**
 * Stamp the Sage id onto a supplier matched by name that carries no external ref yet, so the
 * next lookup finds it by id. A row already carrying a ref (Sage or another system) is left alone.
 */
export async function claimSageSupplier(companyId: string, id: string, sageId: number | string | null | undefined): Promise<void> {
  const ref = sageRef(sageId);
  if (!ref) return;
  await sql`
    UPDATE suppliers SET external_system = 'sage', external_ref = ${ref}
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID AND external_ref IS NULL AND deleted_at IS NULL
  `;
}

/** claimSageSupplier for customers. */
export async function claimSageCustomer(companyId: string, id: string, sageId: number | string | null | undefined): Promise<void> {
  const ref = sageRef(sageId);
  if (!ref) return;
  await sql`
    UPDATE customers SET external_system = 'sage', external_ref = ${ref}
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID AND external_ref IS NULL AND deleted_at IS NULL
  `;
}
