# K-017 — fix

**Trigger.** A `bank_categorisation_rules` row with `auto_create_entry = true`, `supplier_id` (or
`client_id`) set and `vat_code = 'standard'`. Fires on every `applyRules` sweep, unattended.

**Before → after.** `resolveRuleVatCode` returned the rule's code verbatim for any alloc type that
is not `account`, so `buildAutoCreateLines` debited AP with the NET while the bank leg and the
payment document carried the GROSS — K-016 in bulk. It now drops the code to `'none'` for supplier
and customer, so `hasVat` is false, `netAmount` equals `totalAmount`, no VAT line is built.
`denied` and `nonSupplyCoerced` stay false: neither statutory guard is what dropped it, so the
sweep's `autoPostVatDenied` / `autoPostNonSupply` counters keep meaning what they meant.

**Files.** `src/.../gl/settlementVat.ts` (new, shared with K-016) and `src/.../gl/ruleVatResolution.ts`
— the settlement branch, ahead of the `allocType !== 'account'` passthrough. `bankRulesMatchingHelpers.ts`
and `bankRuleAutoPostLine.ts` need no change: both already derive everything from `hasVat`/`vatType`.

**Other callers checked.** `autoPostGateService` and `provisionalPostingService` pass
`allocType: 'account'` literally. `src/lib/mcp/tools/allocationVatGuard.ts` returns the caller's code
untouched when no guard flag is set, so it stays a no-op; the MCP path is corrected inside
`allocateTransaction` by K-016.

**Tests.** `tests/integration/k017-bank-rule-vat-net-control-account.int.test.ts` 1/1 real DB, drives
`applyRules`. `tests/integration/k016-k017-settlement-vat-adjacent.int.test.ts` 5/5 — includes an
account-type rule that must still split. `tests/unit/services/ruleVatResolution.test.ts` 11/11: the
supplier passthrough case asserted the defect and now asserts the drop for both settlement types,
with a transfer case pinning the other boundary.

**Mutation.** Shared with K-016 — one predicate. See `green.log`.

**Migration.** None. Rollback: `git revert`.

**Historical data.** The K-016 query covers these rows. To isolate the sweep, add to it:
`JOIN bank_transactions bt ON bt.company_id = je.company_id AND bt.matched_journal_line_id IN
(SELECT id FROM gl_journal_lines WHERE journal_entry_id = je.id)` with
`AND bt.allocation_rule_id IS NOT NULL`. Verified to run; existing journals are not corrected.

**Limits.** Rules whose `vat_code` was set deliberately change behaviour on the next sweep — the
intent. Existing rule ROWS are not rewritten, so a `vat_code` stored before this change still shows
on the rules list for a supplier or customer rule that ignores it; `CreateRuleModal` no longer lets
a new one be created that way, and re-saving such a rule clears it. The drop is now reported —
`RuleVatDecision.settlementDropped`, a `log.info` on both posters, and `reason: 'settlement'` on the
MCP `vat_coerced` payload — but it raises no sweep counter alongside `autoPostVatDenied` and
`autoPostNonSupply`, so bulk evidence is in the log rather than in `RuleApplyResult`.
