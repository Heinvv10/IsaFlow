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
