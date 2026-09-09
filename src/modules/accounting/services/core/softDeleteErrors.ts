/**
 * Refusals the soft-delete API turns into a 400, as a TYPE rather than a
 * substring.
 *
 * The route used to decide with `message.includes('not found')`, which the undo
 * path inherited when it was wired to the same helper. Faults raised inside
 * reverseJournalEntry read `Journal entry <id> not found`, and getSystemAccount
 * raises "... account not found": both matched, so a genuine data fault came
 * back as a 400 carrying the raw internal message and never reached the
 * log.error branch. A thrown SoftDeleteRefusalError is a refusal the caller can
 * act on; anything else is a fault and must surface as one.
 */
export class SoftDeleteRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SoftDeleteRefusalError';
  }
}
