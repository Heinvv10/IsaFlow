/**
 * Who may READ the report-sharing surfaces.
 *
 * `withWriteAccess` gates mutating methods only — GET, HEAD and OPTIONS pass
 * straight through it, by design. So `withWriteAccess(handler, { allowedRoles:
 * ['owner', 'admin'] })` on the share-links route said nothing at all about its
 * GET arm, and every member of the company including a viewer could list the
 * links: who a pack was shared with (the label), when it expires, who minted
 * it, and how many times a third party has opened it. The commentary list is
 * the same shape of problem — it returns DRAFT text, sentences about the
 * company's numbers that nobody has approved yet.
 *
 * Neither is a figure a viewer is barred from seeing. Both are facts about the
 * company's dealings with outsiders, and about work in progress, which is a
 * narrower audience than "anyone who can read the ledger".
 *
 * Deliberately NOT applied to annotations: those are colleagues' working notes
 * on a row, a viewer is expected to read them, and a test says so.
 *
 * This is a read gate and cannot be expressed by widening `withWriteAccess` —
 * that helper's contract is "mutating methods", and changing it would silently
 * re-gate every GET on the platform.
 *
 * Deliberately import-free. The packs page uses the same predicate to decide
 * whether to MOUNT the commentary panel at all — a surface that would only
 * answer 403 should not be drawn — so this module is reached from the browser
 * bundle and must not drag a server helper along with it. The 403 itself is
 * written by each route, which already has `apiResponse` to hand.
 */

/** Manager is in: a manager already generates commentary drafts and runs the
 *  month-end pack. Minting a link stays narrower (owner/admin) because handing
 *  a third party the figures is a different decision from reading who already
 *  has them. */
export const SHARING_READ_ROLES: readonly string[] = ['owner', 'admin', 'manager'];

export function canReadSharingSurface(companyRole: unknown): boolean {
  return SHARING_READ_ROLES.includes(String(companyRole));
}
