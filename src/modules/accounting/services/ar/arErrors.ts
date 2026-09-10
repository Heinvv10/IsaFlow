/**
 * Typed request errors for the AR services.
 *
 * Why this exists: the AR routes used to decide an HTTP status by matching the
 * error MESSAGE (`/not found/i`, `/not open/i`). That is unsound in both
 * directions. A failure raised deep below the service — `createCreditNote`
 * throws the bare literal `'Not found'` when a link target is missing — is
 * indistinguishable from the service's own precondition, so it was answered
 * with a 400. And `withAuth` COMMITs on any status below 500 (see
 * `src/lib/auth/withAuth.ts`), so a 400 returned AFTER a write commits that
 * write: a dispute claimed as `resolved` with no credit note behind it, and no
 * way to retry because the claim predicate wants `status = 'open'`.
 *
 * The rule this class enforces: a 4xx is a deliberate, caller-correctable
 * refusal that the service raises itself. Anything else must reach `withAuth`
 * as a 5xx so the transaction ROLLBACKs.
 */
export class ArRequestError extends Error {
  /** HTTP status the route should answer with. Always < 500. */
  readonly status: number;
  /** Machine-readable code for the client, when the route sends one. */
  readonly code: string;

  constructor(message: string, status = 400, code = 'AR_REQUEST_INVALID') {
    super(message);
    this.name = 'ArRequestError';
    this.status = status;
    this.code = code;
  }
}
