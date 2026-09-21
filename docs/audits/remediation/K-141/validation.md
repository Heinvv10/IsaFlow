# K-141 — rule match_pattern is an unescaped ILIKE pattern

**Claim.** "Wildcards in the pattern are not escaped and the exact mode is not exact."

**Disposition: confirmed.** Not injection — the pattern is a bound parameter — but the user's own
`_` and `%` act as ILIKE wildcards.

**Evidence.**
- `toSqlPattern` (`src/modules/accounting/services/bank/bankRulesMatchingHelpers.ts:19-27`,
  origin/master) wraps the raw `match_pattern` in `%`; `exact` returns it untouched.
- It is handed to `description ILIKE ${pattern}` / `reference ILIKE ${pattern}` in `findMatchingTxs`
  (same file, lines 60, 73, 82).
- RED: `tests/integration/k141-rule-pattern-like-metacharacters.int.test.ts` — 4 failed of 4.
  `exact` on `SALARY_JAN` also returns `SALARYXJAN`; `contains` on `50% OFF` also returns
  `DISCOUNT 50ANYTHING OFF`. Log: `red.log`.

**Reachability and why it matters.** `applyRules` auto-posts a journal for every row `findMatchingTxs`
returns (`bankRulesMatchingService.ts:249`), so an over-match is a posted misallocation, not a
display glitch. Underscores are common in bank references (`EFT_PAYMENT`, `DEBIT_ORDER`), which is
the realistic trigger; `%` is rarer.

**Proposed minimal fix.** Escape the metacharacters before wrapping, and tell Postgres the escape
character:
```ts
const lit = matchPattern.replace(/([\\%_])/g, '\\$1');
```
then build `%lit%` / `lit%` / `%lit` / `lit` as now. The `ILIKE` calls need `ESCAPE '\'`
(Postgres's default backslash escape applies to `LIKE`/`ILIKE` already, so this is belt-and-braces
and should be verified against the actual query rather than assumed).

**Historical-data impact.** Real. Rules that over-matched have already posted journals. Read-only
census of the rules that can do it, then of what they posted:
`SELECT id, rule_name, match_type, match_pattern FROM bank_rules
 WHERE match_pattern ~ '[%_]' AND is_active;`
then, for each, `SELECT id, description, allocation_rule_id FROM bank_transactions
 WHERE allocation_rule_id = $1 AND description NOT ILIKE <escaped pattern>;` — those are the lines
the rule should never have claimed.

**Risks.** Escaping changes what existing rules match. A rule an operator built *relying* on the
wildcard (unlikely but possible) will stop matching. Worth listing the affected rules from the
census above before shipping, and telling the owners.
