/**
 * Errors `executeRecurring` raises BEFORE it writes anything.
 *
 * The distinction matters to the route, not to the caller's logic: `withAuth`
 * COMMITs the request transaction on a 4xx and only ROLLBACKs on a 5xx, so a
 * 4xx returned after a partial write persists that write. Only a failure
 * raised before the first INSERT may be answered with a 4xx; everything else
 * must propagate and become a 500.
 */
export class RecurringTemplateNotFoundError extends Error {
  constructor(templateId: string) {
    super(`Recurring template not found or inactive: ${templateId}`);
    this.name = 'RecurringTemplateNotFoundError';
  }
}

/**
 * The template's schedule has not come round yet.
 *
 * This is what makes a double-click, a client retry or a re-POST a no-op: the
 * first run advances `next_run_date` past today under the row lock taken in
 * recurringTemplateLock, so the second run sees a future date and is refused.
 * Nothing has been written when it is raised, so the route may answer 409.
 */
export class RecurringTemplateNotDueError extends Error {
  readonly code = 'RECURRING_TEMPLATE_NOT_DUE';
  constructor(templateId: string, public readonly nextRunDate: string) {
    super(`Recurring template ${templateId} is not due until ${nextRunDate}.`);
    this.name = 'RecurringTemplateNotDueError';
  }
}

/**
 * The template's stored aggregate and its `lines` disagree.
 *
 * Raised before the first INSERT of the run (the mint functions assert on the
 * template data before they touch anything), so the route may answer 4xx.
 * Refusing beats minting: the header is what the GL is posted from and the
 * lines are what the customer sees, so a document built from both halves of a
 * disagreement is wrong on the face of it in one of the two places.
 */
export class RecurringTemplateTotalsMismatchError extends Error {
  readonly code = 'RECURRING_TEMPLATE_TOTALS_MISMATCH';
  constructor(public readonly templateId: string, message: string) {
    super(message);
    this.name = 'RecurringTemplateTotalsMismatchError';
  }
}
