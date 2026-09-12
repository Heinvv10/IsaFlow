/**
 * What `applyRules` reports: what posted, and every line a rule matched but
 * did not post, by reason. Split from bank.types.ts (300-line cap).
 */

export interface RuleApplyResult {
  applied: number;
  skipped: number;
  entries: Array<{ bankTxId: string; ruleName: string; journalEntryId?: string; suggestion?: boolean }>;
  /**
   * Number of active auto-post rules that were skipped because the bank
   * account has no linked GL account. When > 0 the UI must surface this
   * loudly — the user expects auto-post to fire and silent skipping is the
   * single most common cause of "rules aren't working" support reports.
   */
  autoPostRulesSkippedNoBankGl?: number;
  /**
   * Number of auto-post attempts the controlled allocation refused because the
   * transaction date falls in a closed/locked fiscal period. Per line, so one
   * historical date doesn't abort the whole apply.
   */
  autoPostSkippedClosedPeriod?: number;
  /** Lines no fiscal period covers — the year has not been created. Known before any attempt; never re-attempted. */
  autoPostSkippedNoPeriod?: number;
  /**
   * Number of auto-post attempts skipped because the transaction had been
   * allocated (or otherwise moved off `imported`) by another request between
   * the rule's candidate query and the row lock. Counted rather than silently
   * dropped: a rule run that quietly did less than it matched is exactly the
   * kind of thing that reads as "rules aren't working".
   */
  autoPostSkippedRaced?: number;
  /**
   * Number of lines this sweep posted GROSS because the rule asked to claim
   * input tax against an account flagged `vat_input_denied` (s17(2)(a)
   * entertainment). The line still posts — only the claim is dropped. Reported
   * because a rule set to claim on an entertainment account is a configuration
   * mistake, and leaving it silent is how R43,008.01 accumulated unnoticed.
   */
  autoPostVatDenied?: number;
  /**
   * Number of lines this sweep posted GROSS because the rule asked to claim
   * VAT against an account on which NO SUPPLY CAN ARISE — salaries, statutory
   * deductions, taxes, distributions, depreciation, donations, exempt
   * financial services. A different statute from `autoPostVatDenied` above:
   * there a supply happened and the claim is refused, here nothing was
   * supplied at all. Reported for the same reason: R400,388.14 of input tax
   * accumulated on Velocity's salary account unnoticed, and R237,021.60 again
   * when the ledger was rebuilt.
   */
  autoPostNonSupply?: number;
  /**
   * Number of auto-post attempts skipped because another request held the
   * transaction's row lock for longer than the 5s timeout. Retryable: nothing
   * was posted for these, and a re-run picks them up.
   */
  autoPostSkippedLocked?: number;
  /**
   * Number of RULES whose candidate set hit the 500-row cap, so this run left
   * matching transactions unprocessed. Deliberately a rule count and not a row
   * count — knowing how many were left over would mean a COUNT over the whole
   * table for a number nobody acts on. Non-zero means "re-run to continue".
   */
  autoPostTruncatedRules?: number;
  /**
   * Number of auto-post attempts the company's approval policy refused: an
   * allocation of that amount needs an independent approval, which an
   * unattended sweep cannot supply. Nothing was written for these. The line
   * stays `imported` for a person to allocate from the screen with an approval.
   */
  autoPostSkippedApprovalRequired?: number;
  /** Supplier rules whose supplier has no verified beneficiary (or a pending hold): verify it, then re-run. */
  autoPostSkippedBeneficiaryUnverified?: number;
  /** Lines dated on or before the company lockdown date. */
  autoPostSkippedLockdown?: number;
  /** Lines that would claim or declare VAT in a period whose return has been filed. */
  autoPostSkippedVatPeriodFiled?: number;
  /** Lines the running person lacked permission to allocate or post. */
  autoPostSkippedPermissionDenied?: number;
  /**
   * Any other refusal of the controlled allocation (no covering fiscal period,
   * ambiguous VAT system account, a non-ZAR bank, …). Nothing was written for
   * these; the distinct reasons come back in `autoPostRefusalReasons`.
   */
  autoPostSkippedRefused?: number;
  autoPostRefusalReasons?: string[];
  /**
   * Matched lines this request did not attempt because it had reached the
   * per-request bound on posted or attempted lines (authorityHoldLimits.ts).
   * Nothing is wrong with them: run again and they are picked up.
   */
  autoPostDeferred?: number;
}
