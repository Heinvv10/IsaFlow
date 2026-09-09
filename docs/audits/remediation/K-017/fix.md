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

**A transfer rule is still not RECORDED as a transfer — named, not fixed.** The amounts are now
right (`gl/bankContraVat.ts` drops the VAT code on a `bank`-subtype contra, and both rule forms stop
offering one), but `bank_categorisation_rules` has no transfer column, so the sweep posts such a rule
with `source: 'auto_bank_recon'` and `allocation_type = 'account'`, with no `counterparty_account_id`
and no `transfer_journal_entry_id`, and it does not run the duplicate-transfer guard that
`allocateTransaction`'s transfer arm has. The same movement can therefore still be posted a second
time from the counterparty bank's own feed. Pre-existing and untouched by this branch; giving rules a
transfer shape is a schema change and its own piece of work, not part of a VAT correction.

**Limits.** Rules whose `vat_code` was set deliberately change behaviour on the next sweep — the
intent. Existing rule ROWS are not rewritten by any migration, so a `vat_code` stored before this
change still shows on the rules list until someone edits that rule. BOTH authoring forms are fixed:
`CreateRuleModal` (the bank screen) and `BankRuleForm` (the rules page, which is also the EDIT
path — it clears a stale code on load, so re-saving an old rule does now drop it). The drop is now
reported —
`RuleVatDecision.settlementDropped`, a `log.info` on both posters, and `reason: 'settlement'` on the
MCP `vat_coerced` payload — but it raises no sweep counter alongside `autoPostVatDenied` and
`autoPostNonSupply`, so bulk evidence is in the log rather than in `RuleApplyResult`.
