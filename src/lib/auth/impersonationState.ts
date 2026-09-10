/**
 * The session's impersonation state could not be established. It lives here, in
 * the auth graph, so the authenticated request path never has to import the
 * accounting controls module to name it.
 */
export const IMPERSONATION_UNVERIFIED = 'impersonation-state-unverified';
