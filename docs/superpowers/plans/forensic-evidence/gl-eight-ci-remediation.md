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
