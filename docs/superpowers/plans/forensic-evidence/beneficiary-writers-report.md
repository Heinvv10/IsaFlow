# Supplier bank writer and merge closure

Base: named 7515bdb8. Isolated branch feat/mcp-forensic-beneficiary-writers-20260909. Kernel prerequisite is separate commit 030955f9. No migrations, Netcash/payment release files, employee association services or configured-policy facade were changed.

## Executing boundaries

- `core/supplierWriteService.ts` now obtains the authenticated ControlTx, checks current write:contacts and asserted company, locks existing supplier rows, and detects actual bank deltas. Omitted/null/blank bank fields retain the previous COALESCE meaning; identical normalized banking does not create a proposal or require maintenance permission. Changed banking requires current write:beneficiaries before any contact UPDATE.
- Banking create inserts a bankless contact and invokes proposeBeneficiaryChange in the same savepoint/request transaction. The encrypted proposal creates a pending hold; no verified history is fabricated. Proposal creation may omit evidence because a new contact cannot already own a matched-invoice document. Verification still requires nonempty independently reviewed exact parent-bound evidence and rechecks any original evidence.
- Banking update preserves active bank columns and creates a pending proposal. Contact writes and their mandatory encrypted/redacted history share the transaction; a failure poisons the request even if a route catches it. Supplier material versions increment with create/update/merge events.
- Shared write projections omit active bank fields and return `beneficiary_review: { proposalId, status: 'pending' }` when pending. No bank HMAC or proposal ciphertext is returned. Existing MCP and REST create/update callers already delegate to the shared writer, so they cannot overwrite active banking through contact arguments. Root still owns transport/UI wording and evidence-collection adapters.
- `core/migrationContactService.ts` supplier create/overwrite branches delegate to the same guarded writer. Pending references return in beneficiaryReviews. A denied or failed write rolls back the complete import, including earlier rows and session progress. Invalid empty-name rows retain their explicit skipped/error behavior. Customer imports are unchanged.
- Migration `billingAddress` input maps to the existing suppliers.address column. Committed migration000 and the synthetic schema have no suppliers.billing_address; the old importer referenced that nonexistent column. No schema was invented to preserve the obsolete SQL.
- `core/duplicateMergeService.ts` supplier branch and the actual supplier-merge REST handler converge on `core/supplierMergeControl.ts`. Sorted parent locks precede dependency checks. Any payment (including approved/processed), invoice, PO, verified beneficiary version, pending/verified proposal or bound operation approval on either supplier refuses with SUPPLIER_MERGE_REQUIRES_REVIEW before mutation. Only financially unreferenced contacts merge; no historical/prepared payment supplier_id is rewritten. The changed source receives a material event/version; the untouched target does not receive a fabricated change. Customer/item merge branches are unchanged.

## Executed evidence

Node22.23.1, isolated synthetic PostgreSQL localhost:33149/isaflow_schema_fixture, explicit fixture opt-in, app_user role and real tenant GUCs/withControlRequest/ControlTx.

- Kernel RED: a new bankless contact's empty-evidence proposal failed EVIDENCE_REQUIRED. Separate 030955f9 permits maintenance-only empty proposals; verification's empty-evidence refusal remains tested. All 27 then-existing kernel tests passed.
- Writer RED: existing contact writes never called the proposal kernel and ignored missing beneficiary permission; import did direct supplier SQL; affected merge succeeded and issued reassignment SQL against mocked queries. New tests reproduced these before implementation.
- Existing strategy suite initially had 10 failures because its SQL-only fixture bypassed the now-required transaction boundary. The fixture now mocks the independently tested bank adapter for that strategy-only suite, preserving all 10 strategy semantics and correcting SQL parameter positions after removing four bank UPDATE values. No production bypass was added.
- First 7 writer PostgreSQL cases passed. Expanded billing-address probe produced 5 failures out of 9 because the obsolete suppliers.billing_address column does not exist. Corrected the input mapping to address; no DDL or weaker banking rule was used.
- Final 9 PostgreSQL cases passed (2.17s total, 968ms tests): bankless create/encrypted proposal/material events; nonempty verification requirement; contacts-only unchanged save and atomic changed-bank denial; import create/overwrite, address retention and later-row rollback; approved and processed payment identity through both service and actual REST handler; empty-contact merge/version increment; actual supplier POST safe pending projection; merge/proposal concurrency; and approval sourceVersions dependency with no payment yet.
- The two actual REST business handlers are imported unchanged except the owned merge delegation. Auth/CSRF/error-wrapper functions are test passthroughs because admission is supplied by the real synthetic withControlRequest/RLS transaction. This proves handler business adaptation and DB semantics, not cookie/HTTP admission, browser UX or deployed behavior.
- Final focused verification: 43 unit tests passed across eight suites, including all 10 existing strategy assertions. Full source tsc --noEmit passed during implementation; the final compiler API check explicitly included all six relevant test files and their imported source, with zero owned diagnostics. ESLint passed on all seven changed source files. No full CI/build ran.
- DB lease released after the final run. No provider, external communication or production request ran. Synthetic rows are retained in the dedicated disposable fixture for review.

## Reproduction

Run from the isolated writer worktree, with Node22.23.1 on PATH and the root-provided synthetic PGPASSWORD:

```sh
./node_modules/.bin/vitest run tests/unit/services/controls/beneficiary*.test.ts tests/unit/services/supplierWriteAutoAllocateStrategy.test.ts
ISAFLOW_FORENSIC_FIXTURE_OPT_IN=1 ISAFLOW_FORENSIC_FIXTURE_URL=postgresql://postgres@127.0.0.1:33149/isaflow_schema_fixture DATABASE_SSL=disable ./node_modules/.bin/vitest run --config vitest.integration.config.ts tests/integration/controls/beneficiaryWriters.int.test.ts
```

## Required remaining programme integration

- Root transport/UI adapters must display the safe pending reference, collect authorized evidence, and map structured refusals to suitable user-facing responses. The supplier REST creation business handler already passes through the safe shared result; MCP's older mapper may omit the pending field until adapted.
- Payment preparation/EFT generation/Netcash raw and batch release must call the verified-beneficiary executor boundary, bind versions/HMAC and reject old prepared payments without valid bindings. These files remain deliberately untouched in this assignment.
- Employee evidence association, other evidence stores and configured beneficiary policy evaluation remain pending from the kernel report. Empty proposal evidence does not relax verification requirements.
- Direct historical import/Sage paths outside migrationContactService and generic bank-data read/reveal adapters still require the programme inventory review. This scoped change does not claim all supplier writes or sensitive reads are globally closed.
- Existing financial writers outside this scope must share the parent-lock/active-state contract. The guard serializes current shared proposals and merges; unrelated legacy direct SQL writers are not made safe merely by this merge guard.
