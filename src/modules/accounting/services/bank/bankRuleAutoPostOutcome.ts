/** What one auto-post rule line did (moved out of bankRuleAutoPostLine, its line cap; re-exported there). */

export type AutoPostOutcome =
  | { kind: 'posted'; journalEntryId: string; vatDenied: boolean; nonSupplyCoerced: boolean }
  /** The row was allocated (or removed) between the candidate query and the lock. */
  | { kind: 'raced' }
  /** Its date falls in a closed/locked period - re-open the period to post it. */
  | { kind: 'closed_period' }
  /** No fiscal period covers its date - the year has not been created. */
  | { kind: 'no_period' }
  /** Its journal moves a VAT figure and its date is inside a locked (filed) VAT period. */
  | { kind: 'vat_period_locked' }
  /** A hand-keyed line would pay a supplier past an enforced supplier_payment rule (R-035 PR5, D2), or post to an
   *  account past a manual_journal one (PR6 H2) — or the sweep's own user imported the line (step 2). */
  | { kind: 'approval_required' };
