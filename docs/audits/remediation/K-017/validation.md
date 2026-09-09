# K-017 — Bank rules reproduce the net/gross VAT split, unattended

**Claim.** The same VAT split as K-016 is applied automatically across a whole sweep with no human
in the loop.

**Corrected trigger.** `buildAutoCreateLines` debits AP with `netAmount` for a supplier rule
(bankRulesMatchingHelpers.ts:132; the customer arm is :148/:151 against AR) while
`autoPostRuleLine` credits the bank with `totalAmount` (:133 of the same builder) and creates the
supplier payment document for `totalAmount` (bankRuleAutoPostLine.ts:245). `resolveRuleVatCode`
returns the rule's `vat_code` verbatim for any alloc type that is not `account`
(ruleVatResolution.ts:57), so the s17(2)(a) denial and non-supply guards protecting the account arm
never run here. One misconfigured rule carries the error across every line it matches, up to the
500-candidate cap per run.

**Disposition: confirmed.** Same root cause as K-016 in a second builder; not a duplicate — a
separate file with a separate reachable entry point, and the unattended one.

**Evidence.** File unchanged 5661d6f0..ebeac9ca. RED integration test drives the real sweep
(`applyRules`) over two matching statement lines: 2 entries posted, bank credited R230, payment
documents R230, AP debited **R200**, VAT input debited R30.

**Reachability.** A `bank_categorisation_rules` row with `auto_create_entry = true`,
`supplier_id` set and `vat_code = 'standard'`. `allocType` is derived from `supplier_id`
(bankRulesMatchingService.ts:192). Fires on every sweep with no confirmation step.

**RED test.** `tests/integration/k017-bank-rule-vat-net-control-account.int.test.ts` —
1 failed / 1. Log: `docs/audits/remediation/K-017/red.log`.

**Proposed minimal fix.** In `buildAutoCreateLines`, treat `hasVat` as false for
`allocType === 'supplier' | 'customer'` — post the AP/AR leg at `totalAmount` and emit no VAT line —
matching the K-016 fix so the attended and unattended paths cannot diverge again. Better still,
force it upstream in `bankRuleAutoPostLine` where `hasVat` is computed (:131), so one expression
governs both.

**Historical-data impact.** Larger than K-016 by volume: sweeps post in bulk. The K-016 impact
query already returns these rows (`source = 'auto_supplier_payment' | 'auto_payment'`); narrow to
the sweep with `bank_transactions.allocation_rule_id IS NOT NULL` on the matched line.

**Risks.** Rules whose `vat_code` was set deliberately will change behaviour on the next sweep —
that is the intent. Existing journals are unaffected by the code change and need their own
correction decision.
