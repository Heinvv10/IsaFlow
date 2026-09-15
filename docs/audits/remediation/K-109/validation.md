# K-109 — Approval requests accept a cross-tenant rule id

**Claim.** `requestApproval` does not check rule ownership and the later join is unscoped, returning another tenant's rule name.

**Disposition: confirmed on the first half; the name leak is blocked by RLS.**

**Corrected trigger.** `src/modules/accounting/services/gl/approvalService.ts:186-192` inserts `${input.ruleId}::UUID` with no ownership predicate, and `pages/api/accounting/approval-requests.ts:57-63` takes `ruleId` straight from the body. The foreign key `approval_requests_rule_id_fkey REFERENCES approval_rules(id)` is global, and a foreign-key check bypasses RLS, so the insert succeeds with another tenant's rule id.

The second half does not reproduce. `approval_rules` carries forced RLS `tenant_isolation USING (company_id IN auth.user_companies())` (verified in the fixture), so the `LEFT JOIN approval_rules rl ON rl.id = ar.rule_id` in `listRequests:209` and `checkApproval:122` sees no row and yields a NULL `rule_name`. No cross-tenant name is returned. What the tenant gets instead is an approval request whose rule is permanently invisible: `ruleName` is undefined in the UI and no rule can be re-derived.

**Evidence.** Files above via `git show origin/master:<path>`; policy text and FK definition read from the fixture with `\d approval_requests` and `pg_policy`.

**RED test.** `tests/integration/k108-k109-approval-rules.int.test.ts`, test "K-109" — failed. Observed `{status: 200, storedRuleId: '<beta rule uuid>'}` against expected `{status: 400, storedRuleId: null}`. Log: `red.log`.

**Reachability.** Any user with write access who can guess or obtain a rule uuid; also reachable accidentally after a company switch.

**Proposed minimal fix (3-6 lines).** In `requestApproval`, resolve the rule first and refuse when it is absent:
```ts
const [rule] = await sql`SELECT id FROM approval_rules WHERE id=${input.ruleId}::UUID AND company_id=${companyId}`;
if (!rule) throw new Error('Approval rule not found for this company');
```
Then scope the joins as `LEFT JOIN approval_rules rl ON rl.id = ar.rule_id AND rl.company_id = ar.company_id`, so the correctness does not depend on RLS being on.

**Historical-data impact.** Requests pointing at a foreign rule display no rule name and cannot be reasoned about. Read-only impact SQL:
```sql
SELECT ar.company_id, ar.id, ar.rule_id FROM approval_requests ar
JOIN approval_rules r ON r.id = ar.rule_id
WHERE r.company_id IS DISTINCT FROM ar.company_id;
```
Not run against production.

**Risks.** Low. The fix is additive validation; existing bad rows are left for the impact query to enumerate.
