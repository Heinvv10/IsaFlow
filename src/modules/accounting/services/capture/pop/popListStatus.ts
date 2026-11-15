/**
 * The status vocabulary of the POP list (`popListService`, MCP `list_proofs_of_payment`). Pure, no imports: the tool
 * validates its arguments against these and its tests mock the service without losing them.
 *
 * A POP's match status is its `proof_of_payment_matches` outcome (991), 'pending' when the matcher has not decided
 * yet (no row), and 'attached_manually' when the matcher did not attach it but its document is linked to a bank line
 * anyway (a person attached it in the app; the matcher never looks at a POP whose document is linked). Its archive
 * status is its `pop_archive_copies` outcome (992), 'pending' when not settled (no row: not tried yet, retrying, or
 * the company has no archive target).
 */
export const POP_MATCH_STATUSES = ['attached', 'attached_manually', 'ambiguous', 'not_found', 'refused', 'pending'] as const;
export type PopMatchStatus = (typeof POP_MATCH_STATUSES)[number];

/** A filter takes every status, and 'unmatched': every POP on no bank line (neither 'attached' nor 'attached_manually'). */
export const POP_MATCH_FILTERS = [...POP_MATCH_STATUSES, 'unmatched'] as const;
export type PopMatchFilter = (typeof POP_MATCH_FILTERS)[number];

export const POP_ARCHIVE_STATUSES = ['archived', 'too_large', 'failed', 'pending'] as const;
export type PopArchiveStatus = (typeof POP_ARCHIVE_STATUSES)[number];
