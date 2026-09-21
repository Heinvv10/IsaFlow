# K-141 — a rule pattern must not act as an ILIKE wildcard

**Trigger.** A bank rule whose `match_pattern` contains `_` or `%`. Underscores
are common in bank references (`EFT_PAYMENT`, `DEBIT_ORDER`).

**Before.** `toSqlPattern` wrapped the raw pattern in `%` and handed it to
`description ILIKE ${pattern}`. The operator's own `_` matched any single
character and `%` any run, so a rule keyed on `SALARY_JAN` also claimed
`SALARYXJAN` and the `exact` match type was not exact. `applyRules` auto-posts a
journal for every row matched, so an over-match is a posted misallocation.

**After.** `escapeLikeLiteral` escapes `\`, `%` and `_` (backslash first, since
it is ILIKE's default escape character) before the wrapping. Patterns with no
metacharacter are byte-for-byte unchanged.

**Files.** `src/modules/accounting/services/bank/bankRulesMatchingHelpers.ts`.

**Tests.** `tests/integration/k141-rule-pattern-like-metacharacters.int.test.ts`
— 6 passed against a real database. Mutation proof in `green.log`.

**Migration.** None.

**Historical-data impact.** Real. Rules that over-matched have already posted
journals. Read-only census (not run here):
`SELECT id, rule_name, match_type, match_pattern FROM bank_rules
 WHERE match_pattern ~ '[%_]' AND is_active;`
then per rule, the lines it should never have claimed:
`SELECT id, description, allocation_rule_id FROM bank_transactions
 WHERE allocation_rule_id = $1 AND description NOT ILIKE <escaped pattern>;`

**Limits.** Escaping changes what existing rules match. A rule whose author
relied on the wildcard will stop matching; the census above lists them, and the
owners should be told before this ships.
