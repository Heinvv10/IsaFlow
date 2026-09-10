# GL eight CI fixture remediation

Base: `6dc61f273`. Tests only; no production, schema or authority changes.

Focused baseline: `deactivateAccountWithBalance.test.ts` and
`gl/accountSubtypeRequired.test.ts`: 8 failures, 10 passes, 18 tests,
394 ms (`gl-eight-red.log`). Seven update fixtures and one create fixture
call newly controlled writers without an issued request context.

Owned files: those two unit files, new `tests/integration/controls/glEightFixture.ts`
and `glEightControl.int.test.ts`, and this plan.

Preserve the two existing balance query tests verbatim and every passing
subtype/import/template test. Retain sub-cent tolerance as a pure real-helper
check: persisted journal money has two decimal places, so a fabricated 0.004
posted line is not a PostgreSQL proof.

Before replacing obsolete update mocks, prove with current issued cookie
contexts and actual shared journal creation/posting: debit R130000 refusal
including account name; credit R450 refusal; refusal changes neither account
nor history/version/evidence; actual offsetting R5000 postings permit
deactivation; a live-balance legacy inactive account may reactivate;
metadata-only rename leaves money unchanged; system account refusal occurs
before balance lookup; expense without subtype refuses without account/event
insertion; valid subtype creation succeeds. Observe real client queries by a
forwarding spy, never substitute results or kernel authority. Include owned
foreign-account refusal. Actual journal posting uses independent approval
when seeded policy requires it.

Unit replacements will cover unissued ingress rejection before SQL and exact
real tolerance boundaries; original economic assertions move to the actual
PG tests. Only adapt after the PG scenarios pass. Request exclusive PG/static
lease from root; close all fixture pools. Then rerun focused units, source and
dedicated test TypeScript plus typed scoped ESLint. Root reviews named commits
before integration. Full CI remains root-owned and required.

## Actual producer verification progress

`90890`: nine actual PG cases, 8 pass/1 fixture assertion failure (3.47s).
Debit/credit refusal, no mutation, reactivation, rename, system protection,
subtype refusal/create and foreign account assertions pass. Real approval
already records `baseline_observed` v1 for used accounts; zero-balance
mutation correctly retains `updated` v2. Initial one-event assumption was
wrong. The strengthened assertion preserves both versions and exact decrypted
updated before/after rows.

`28054`: exact image comparison exposed JS Date millisecond truncation in the
fixture; retained evidence correctly contains actual microseconds. Use SQL
`to_jsonb` and exact bank-opening decimal text for expected persisted rows.
`20980`: corrected SQL fixture mistakenly returned its `material` wrapper;
`b70dc8bb1` unwraps it. Exact-image retry remains required before retiring old
writer fixtures. All three processes terminal and fixture pools closed;
PG/static slot released to root. No production defect inferred or changed.

## Assertion traceability and corrected verification

`81232` terminal 0: corrected zero-balance case passed in 827 ms (2.80 s
runner); eight cases filtered by the command, not committed skips. Full exact
before/after and both baseline v1/update v2 retained. Combined with `90890`, all
nine actual cases have passed. Pools closed and lease released before units.

| Original writer assertion | Preserved proof |
| --- | --- |
| Named R130000 debit refusal | PG parameterized 130000 case, name + exact money + complete unchanged state |
| Credit R450 refusal | PG parameterized -450 case, exact signed money + complete unchanged state |
| No UPDATE on refusal | Both PG money cases inspect real forwarded queries and entire persisted state |
| Used zero-balance account may deactivate | Two real R5000 opposite postings; exact baseline/update history and images |
| 0.004 rounding dust allowed | Direct real `holdsMoney(1000-1000.004)` plus both signed half-cent boundaries |
| Live-balance reactivation, no balance lookup | PG legacy inactive row, real R130000 posted money; query absence + resulting balance |
| Metadata rename, no balance lookup | PG real R130000 posted money; query absence + unchanged resulting balance |
| System deactivation refuses before balance query | PG real system row, query absence + entire unchanged state |
| Expense subtype required | PG real issued create refuses with no domain/history/version/evidence mutation; valid explicit subtype positive |

The two original balance-query test bodies and all seven originally passing
subtype/import/template bodies remain unchanged. Unissued writer unit cases
now explicitly assert the current control-context boundary without a mock
that grants authority. Adapted focused units passed; source/dedicated test
TypeScript and typed scoped lint remain queued, no full-CI claim.
