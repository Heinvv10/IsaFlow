# K-078 — auto_publish promotes a supplier rule on its own output

**Claim.** The learning counter counts the rule confirming its own default, so a rule reaches the
auto-publish threshold on its own output.

**Corrected trigger.** `pages/api/accounting/capture/[id]/post.ts` calls
`autoPublishGateService.decide()`, which loads the supplier rule, and then feeds that same rule's
own defaults straight back into `recordCoding`:

```
glAccountId: codingRule?.defaultGlAccountId ?? null,
postedBy:    `human:${userId}`,
```

`recordCoding` decides `glMatches` by comparing `entry.glAccountId` to `rule.defaultGlAccountId`,
so on this path the comparison is the rule against itself and is unconditionally true.
`learned_sample_count` therefore climbs on every posting regardless of whether anyone confirmed
the coding, and at `PROMOTION_THRESHOLD = 5` the rule sets its own `auto_publish = true`. From then
on `decide()` returns `auto_publish` and invoices are inserted with `status = 'approved'` without
review. The user clicked Post, but never chose or saw a GL account — the `human:` stamp records a
confirmation that did not happen.

**Disposition: confirmed.**

**Evidence** (`git show origin/master:<path>`; unchanged since 5661d6f0):
- `pages/api/accounting/capture/[id]/post.ts:177-186` — the echo, and the `human:` stamp.
- `src/modules/accounting/services/capture/supplierRulesService.ts:197-199` `glMatches`;
  `:254-267` the increment and self-promotion; `:13` the threshold.
- `src/modules/accounting/services/capture/autoPublishGateService.ts:70,82-90,123-130` — the same
  rule object is returned to the caller and gates auto-publish.
- `src/modules/accounting/services/capture/supplierRulesService.ts:46` — `CodingEntry.postedBy`
  already documents a `'rule:<id>'` provenance. Nothing writes it and nothing reads it.

**Reachability.** Any company with a supplier rule carrying a non-null default GL account. Five
postings through the capture inbox for that supplier flip auto_publish on. The second call site,
`pages/api/accounting/ai-invoice-pipeline.ts:184`, passes `glAccountId: null`, which instead takes
the drift branch and wipes the learned default to null — a related defect worth its own item, not
covered by this one.

**Proposed minimal fix.** Two lines, in two files. In `post.ts`, stamp `postedBy` as
`rule:${codingRule.id}` when the coding came from the rule rather than from a human. In
`recordCoding`, take the increment/promotion branch only for human-sourced entries; record the
history row for the rest, as it already does for the AI path. That uses the provenance the type
already declares and leaves genuine human confirmations counting exactly as they do now.

**Historical-data impact.** Rules already promoted this way are auto-approving supplier invoices
today. Read-only impact query:

```sql
SELECT r.company_id, r.supplier_id, r.learned_sample_count, r.updated_at,
       count(h.id) FILTER (WHERE h.posted_by LIKE 'human:%') AS human_codings
FROM supplier_coding_rules r
LEFT JOIN supplier_coding_history h
  ON h.company_id = r.company_id AND h.supplier_id = r.supplier_id
WHERE r.auto_publish
GROUP BY r.company_id, r.supplier_id, r.learned_sample_count, r.updated_at;
```

`posted_by` cannot distinguish a rule echo from a real human coding on existing rows — both read
`human:<uid>` — so the count above is an upper bound on genuine confirmations, not a measurement.
Any rule whose history is dominated by capture-posted entries should be reset to
`auto_publish = false` and re-earned. NOT run against production.

**Risks.** Resetting auto_publish sends invoices back to the review inbox for suppliers whose users
have grown used to them posting automatically. That is the correct outcome but needs telling.
