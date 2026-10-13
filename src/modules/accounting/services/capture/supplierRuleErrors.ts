/** Refusals of the supplier coding rules service, kept apart so the service stays under the file-size cap. */

/** autoPublish was asked for on a rule that has no default GL account to publish with. A 400, raised before any write. */
export class AutoPublishNeedsAccountError extends Error {
  constructor() {
    super('Auto-publish needs a default GL account: choose one for this supplier, or leave auto-publish off.');
    this.name = 'AutoPublishNeedsAccountError';
  }
}
