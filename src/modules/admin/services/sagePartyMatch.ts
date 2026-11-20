/**
 * sagePartyMatch.ts
 *
 * Which existing IsaFlow supplier / customer a pulled Sage party is (#1655). The rules:
 *
 * 1. A row carrying the party's Sage id (`external_system = 'sage'`, `external_ref`) wins. Failing that, a
 *    live row of the same trimmed, case-folded name that is not already another Sage party's.
 * 2. The commit stamps the Sage id on every row it creates and on an unstamped row it matches by name
 *    (resolveSageSupplier / resolveSageCustomer: match, claim, and match again after a claim lost to a
 *    concurrent import), so a re-sync finds it by id and a second Sage party of that name gets its own row.
 * 3. A soft-deleted row is never matched, except a SUPPLIER merged away (`merged_into_id`, migration 1020):
 *    it resolves to its live survivor, at most MAX_MERGE_HOPS deep, never revisiting a row. A plainly deleted
 *    supplier (survivor included), a merge made before 1020, and every deleted customer are created again,
 *    live (customers: Hein's K-061 decision 4).
 *
 * Merged-away rows, by name only (a Sage-id hit always follows its merge):
 * - A merged-away row also matches by its name without the `[MERGED]` suffix the supplier-merge route adds.
 * - The Sage id is stamped on the merged-away row, never on the survivor (claimMatchedSupplier), so the
 *   survivor still matches its own Sage party and a later party of that name finds the row taken.
 * - When the pull carries a Sage id, a merged-away row holding any other external ref is not matched: it
 *   could never be stamped, so it would match every later party of that name.
 * - Unstamped same-name rows must lead to ONE survivor, else the party matches none and gets its own live row.
 *   Several rows to the same survivor are no ambiguity; each distinct Sage party takes the next unstamped one.
 * - The hit is dropped when another alias of that name reaching the same survivor carries a different Sage id.
 * - The hit is dropped when its chain passes a row (the survivor included) carrying a Sage id other than the
 *   pull's: that row belongs to another Sage party. A conflict row is kept whatever its chain passes, so the
 *   same-survivor check above still sees it.
 * - A 'sage' row with no external_ref is unstamped, never a conflict.
 * - A pull without a Sage id still reaches the survivor by name and stamps nothing.
 *
 * Known: a bill imported before its supplier sync throws "Supplier not found" where the name is ambiguous.
 */

import { sql } from '@/lib/neon';
import type { Row } from './sageMigrationTypes';

/** The Sage id as stored in external_ref, or null when the pull carried none. */
export function sageRef(sageId: number | string | null | undefined): string | null {
  if (sageId === null || sageId === undefined) return null;
  const ref = String(sageId).trim();
  return ref === '' ? null : ref;
}

/** How deep a chain of supplier merges (A into B, B into C, ...) is followed. */
export const MAX_MERGE_HOPS = 10;

/**
 * `id` is the live supplier. `viaMerge` is true when it was reached through a merged-away row, and
 * then `mergedAwayId` is that row (the start of the chain) and `byRef` says whether the Sage id (not
 * just the name) found it.
 */
export interface SageSupplierMatch { id: string; viaMerge: boolean; mergedAwayId: string | null; byRef: boolean }

/**
 * The supplier a Sage party is, and whether it was reached through a merge. Candidates are live rows
 * and merged-away rows (deleted with a survivor); each is followed to the live row at the end of its
 * merge chain. A Sage-id hit outranks a name hit, and a live hit outranks a merged one.
 */
export async function matchSageSupplier(
  companyId: string, party: { name: string; sageId?: number | string | null },
): Promise<SageSupplierMatch | null> {
  const ref = sageRef(party.sageId);
  // The merge route appends ' [MERGED]' to the stored (untrimmed) name: strip it before trimming, so a
  // row stored as 'Acme ' (now 'Acme  [MERGED]') still matches 'Acme'.
  const rows = (await sql`
    WITH RECURSIVE named AS (
      SELECT id, deleted_at, merged_into_id, created_at, external_system, external_ref,
             LOWER(BTRIM(name)) = LOWER(BTRIM(${party.name}))
             OR (deleted_at IS NOT NULL AND UPPER(name) LIKE '% [MERGED]'
                 AND LOWER(BTRIM(LEFT(name, LENGTH(name) - 9))) = LOWER(BTRIM(${party.name}))) AS name_hit
      FROM suppliers
      WHERE company_id = ${companyId}::UUID
        AND (deleted_at IS NULL OR merged_into_id IS NOT NULL)
    ), hit AS (
      SELECT id, deleted_at, merged_into_id, created_at,
             (external_system = 'sage' AND external_ref = ${ref}::TEXT) IS TRUE AS by_ref,
             (deleted_at IS NOT NULL AND name_hit AND ${ref}::TEXT IS NOT NULL
              AND external_system = 'sage' AND external_ref IS NOT NULL AND external_ref <> ${ref}::TEXT) IS TRUE AS conflict
      FROM named
      WHERE (external_system = 'sage' AND external_ref = ${ref}::TEXT)
         OR (name_hit
             AND (${ref}::TEXT IS NULL OR external_system IS DISTINCT FROM 'sage' OR external_ref IS NULL)
             AND (${ref}::TEXT IS NULL OR deleted_at IS NULL OR external_ref IS NULL))
         OR (deleted_at IS NOT NULL AND name_hit AND ${ref}::TEXT IS NOT NULL
             AND external_system = 'sage' AND external_ref IS NOT NULL AND external_ref <> ${ref}::TEXT)
    ), chain AS (
      SELECT h.id AS start_id, h.id, h.deleted_at, h.merged_into_id, 0 AS hops, ARRAY[h.id] AS seen, FALSE AS blocked FROM hit h
      UNION ALL
      SELECT c.start_id, s.id, s.deleted_at, s.merged_into_id, c.hops + 1, c.seen || s.id,
             c.blocked OR (${ref}::TEXT IS NOT NULL AND s.external_system = 'sage'
                           AND s.external_ref IS NOT NULL AND s.external_ref <> ${ref}::TEXT) IS TRUE
      FROM chain c
      JOIN suppliers s ON s.id = c.merged_into_id AND s.company_id = ${companyId}::UUID
      WHERE c.deleted_at IS NOT NULL AND c.hops < ${MAX_MERGE_HOPS} AND NOT (s.id = ANY (c.seen))
    )
    SELECT c.id, h.id AS hit_id, h.by_ref, h.deleted_at IS NOT NULL AS via_merge, h.conflict
    FROM chain c JOIN hit h ON h.id = c.start_id
    WHERE c.deleted_at IS NULL AND (h.by_ref OR h.conflict OR NOT c.blocked)
    ORDER BY h.conflict, h.by_ref DESC, (h.deleted_at IS NULL) DESC, h.created_at, h.id
  `) as Row[];
  // Merged-away rows of this name already stamped with ANOTHER Sage id: matched only to spot a conflict.
  const conflicts = rows.filter((r) => r.conflict === true);
  const matches = rows.filter((r) => r.conflict !== true);
  const first = matches[0];
  if (!first) return null;
  const viaMerge = first.via_merge === true;
  const byRef = first.by_ref === true;
  // Ranked first, a name-only merged hit means no Sage-id hit and no live hit exist: every row is a
  // name-only merged hit. They must all lead to one survivor, or the party matches none of them.
  if (viaMerge && !byRef && new Set(matches.map((r) => String(r.id))).size > 1) return null;
  // Another Sage party already claimed a same-name alias of this survivor: the remaining unstamped alias
  // could be either party, so it is not this one's (two Sage parties never share one survivor by name).
  if (viaMerge && !byRef && conflicts.some((r) => String(r.id) === String(first.id))) return null;
  return { id: String(first.id), viaMerge, byRef, mergedAwayId: viaMerge ? String(first.hit_id) : null };
}

/** How many times a resolve re-matches after a concurrent import stamped the row it matched. */
const MAX_CLAIM_ATTEMPTS = 5;

const sameMatch = (a: SageSupplierMatch, b: SageSupplierMatch) =>
  a.id === b.id && a.viaMerge === b.viaMerge && a.byRef === b.byRef && a.mergedAwayId === b.mergedAwayId;

/**
 * The supplier a Sage party is, stamped with its Sage id (claimMatchedSupplier). A claim that updates
 * nothing either lost to a concurrent import (the row now carries another Sage id, so a fresh match no
 * longer returns it) or hit a row that cannot be stamped (another system's ref: the fresh match is the
 * same, and stands). Null: no supplier matches.
 */
export async function resolveSageSupplier(
  companyId: string, party: { name: string; sageId?: number | string | null },
): Promise<SageSupplierMatch | null> {
  let match = await matchSageSupplier(companyId, party);
  for (let attempt = 0; match && attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
    if (await claimMatchedSupplier(companyId, match, party.sageId)) return match;
    const again = await matchSageSupplier(companyId, party);
    if (!again || sameMatch(again, match)) return again;
    match = again;
  }
  if (match) throw new Error(`Sage supplier ${party.name}: concurrent imports kept claiming its match; retry`);
  return null;
}

export async function findSageSupplier(
  companyId: string, party: { name: string; sageId?: number | string | null },
): Promise<string | null> {
  return (await matchSageSupplier(companyId, party))?.id ?? null;
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

/** resolveSageSupplier for customers: match, claim, and match again after a claim lost to a concurrent import. */
export async function resolveSageCustomer(
  companyId: string, party: { name: string; sageId?: number | string | null },
): Promise<string | null> {
  let id = await findSageCustomer(companyId, party);
  for (let attempt = 0; id && attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
    if (await claimSageCustomer(companyId, id, party.sageId)) return id;
    const again = await findSageCustomer(companyId, party);
    if (!again || again === id) return again;
    id = again;
  }
  if (id) throw new Error(`Sage customer ${party.name}: concurrent imports kept claiming its match; retry`);
  return null;
}

/**
 * Stamp the Sage id onto a supplier matched by name that carries no external ref yet, so the
 * next lookup finds it by id. A row already carrying a ref (Sage or another system) is left alone.
 * True when the row was stamped or there was nothing to stamp (no Sage id).
 */
export async function claimSageSupplier(companyId: string, id: string, sageId: number | string | null | undefined): Promise<boolean> {
  const ref = sageRef(sageId);
  if (!ref) return true;
  const rows = (await sql`
    UPDATE suppliers SET external_system = 'sage', external_ref = ${ref}
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID AND external_ref IS NULL AND deleted_at IS NULL
    RETURNING id
  `) as Row[];
  return rows.length > 0;
}

/**
 * Stamp the Sage id onto the MERGED-AWAY supplier a party reached its survivor through by name alone
 * (never the survivor: it may be a Sage party of its own). The next sync of that id then hits the
 * merged-away row by id, and a later, different Sage party of the same name no longer matches it (a
 * name match skips rows already carrying a Sage id) and gets its own row. Only a merged-away row with
 * no external ref is touched. No unique index covers suppliers.external_ref, so the stamp cannot collide.
 */
export async function claimMergedAwaySupplier(companyId: string, id: string, sageId: number | string | null | undefined): Promise<boolean> {
  const ref = sageRef(sageId);
  if (!ref) return true;
  const rows = (await sql`
    UPDATE suppliers SET external_system = 'sage', external_ref = ${ref}
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID AND external_ref IS NULL
      AND deleted_at IS NOT NULL AND merged_into_id IS NOT NULL
    RETURNING id
  `) as Row[];
  return rows.length > 0;
}

/**
 * Stamp what a supplier match calls for: the row itself, or the merged-away row it was reached through.
 * True when the match holds (a Sage-id hit, nothing to stamp, or the stamp landed); false when the
 * stamp updated nothing, so the caller matches again (resolveSageSupplier).
 */
export async function claimMatchedSupplier(
  companyId: string, match: SageSupplierMatch, sageId: number | string | null | undefined,
): Promise<boolean> {
  if (match.byRef) return true;
  if (!match.viaMerge) return claimSageSupplier(companyId, match.id, sageId);
  return match.mergedAwayId ? claimMergedAwaySupplier(companyId, match.mergedAwayId, sageId) : true;
}

/** claimSageSupplier for customers. */
export async function claimSageCustomer(companyId: string, id: string, sageId: number | string | null | undefined): Promise<boolean> {
  const ref = sageRef(sageId);
  if (!ref) return true;
  const rows = (await sql`
    UPDATE customers SET external_system = 'sage', external_ref = ${ref}
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID AND external_ref IS NULL AND deleted_at IS NULL
    RETURNING id
  `) as Row[];
  return rows.length > 0;
}
