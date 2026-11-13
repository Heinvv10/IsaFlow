/**
 * Limits shared by the transfer link log reader (server) and its drawer (client). No imports: the drawer bundles
 * this file, and anything that reaches `@/lib/neon` would pull pg into the browser.
 */

/** The drawer shows at most this many batches (runs), newest first. */
export const TRANSFER_LINK_MAX_BATCHES = 50;
