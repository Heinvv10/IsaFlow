/**
 * What one bank-rule sweep did. Moved verbatim from bank.types.ts (file-size
 * cap), which re-exports it.
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
   * Number of auto-post attempts that failed because the transaction date
   * falls in a closed/locked fiscal period. We swallow per-tx and count so
   * one historical date doesn't abort the whole apply.
   */
  autoPostSkippedClosedPeriod?: number;
  /**
   * Number of auto-post attempts skipped because no fiscal_periods row covers
   * the transaction date — the fiscal year hasn't been created. Reported
   * separately from `autoPostSkippedClosedPeriod` so the UI can prompt the
   * user to create the missing year (different remedy than re-opening).
   */
  autoPostSkippedNoPeriod?: number;
  /**
   * Auto-post attempts skipped because the journal moves a VAT figure and its
   * date is inside a locked (filed) VAT period. Remedy: an owner/admin unlocks
   * the period, or the line is allocated by hand on another date.
   */
  autoPostSkippedVatLocked?: number;
  /**
   * Auto-post attempts skipped because the rule's account is a balance-sheet
   * header (an asset, liability or equity account below level 3 with
   * sub-accounts, gl/headerAccountGuard). Remedy: point the rule at a sub-account.
   */
  autoPostSkippedHeaderAccount?: number;
  /**
   * R-035 PR5 (D2): supplier-rule auto-posts skipped because the line was keyed
   * by hand and an enforced supplier_payment rule governs the amount — a payment
   * instruction, recorded through a supplier payment and its approval instead.
   */
  autoPostSkippedApprovalRequired?: number;
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
}
