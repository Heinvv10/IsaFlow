# Control request lifetime and response finalization corrections

Baseline ba3d9ebd, isolated branch fix/mcp-forensic-context-20260909. Changes limited to context.ts, cookie/bearer wrappers and their focused unit tests. Public withControlRequest/requireControlTx/assertControlTx signatures unchanged. No ALS/auth identity/permission/schema changes.

## Findings reproduced before fixes

P1: a retained ctx.sql created global LazyQuery objects without checking its originating request. Detached asynchronous work inherited usable ALS after withControlRequest returned. Initial regressions:3failed,5passed (/tmp/forensic-context-red.log): fabricated matching ALS accepted; retained query call outside request accepted; delayed callback after exit accepted.

P2: a handler can buffer successful res.json/end and mark required evidence failed. withControlRequest throws after the handler returns; wrappers previously rolled back/rethrew with patched res.end, leaving buffered success and potentially hanging outer error handling. Added cookie and bearer tests using real json->end buffering; both failed while13existing wrapper tests passed (/tmp/forensic-context-response-red.log).

## Final behavior

A private lifetime brand binds contexts to exact request-store object, client and frozen authenticated principal. Only withControlRequest creates that active brand, revoked in finally on success or failure. Direct ALS construction cannot issue contexts. ControlQuery validates both tagged-query creation and actual then/catch/finally execution; no global LazyQuery escapes. It memoizes one execution and refuses reuse after expiry or in another request, even with same client/user/company.

ControlIntegrityError distinguishes required-evidence refusal. Both auth wrappers intercept it before transaction finalization, replace buffered success with a generic CONTROL_INTEGRITY_FAILED500, then take existing rollback-and-flush path. Tests assert exactly one rollback, no commit, one realEnd flush, no original sensitive success bytes, and one client release. Wrappers restore original end in finally even for unrelated propagated errors. Already-streamed headers cannot be rewritten; that branch closes the stream after rollback without attempting new headers or appending buffered success. Buffered JSON behavior is directly tested; no live streaming acceptance claimed.

All contexts in updated tests now originate inside withControlRequest. Bearer tests use real ALS. Narrow callback type annotations in existing auth tests were corrected to permit focused TypeScript checking; no assertions weakened.

## Verification

Final24tests pass across3files,1.56s total. Includes fabricated ALS rejection, expired query creation/consumption, detached callback after wrapper exit, same-client context reuse rejection, positive in-scope execution exactly once, cookie/bearer integrity500 finalization, and existing commit-order/auth refusal behavior. Final log /tmp/forensic-context-response-green.log.

Commands from isolated worktree with Node22.23.1 on PATH:

```
node node_modules/vitest/vitest.mjs run tests/unit/services/controls/context.test.ts tests/unit/auth/withAuth-commit-order.test.ts tests/unit/auth/withBearerAuth.test.ts
node node_modules/eslint/bin/eslint.js src/modules/accounting/services/controls/context.ts src/lib/auth/withAuth.ts src/lib/auth/bearerPipeline.ts
node node_modules/typescript/bin/tsc --noEmit --project /tmp/forensic-context-tsconfig.json
```

Source ESLint passed. Focused TypeScript project (extends repository configuration, incremental=false, includes changed source and test files, exclude=[]) passed after fixing pre-existing narrower callback annotations exposed by including tests. Final small header guards preserve the same checked types. Each changed code file below300lines; bearer comments condensed to preserve cap. No DB/build/fullCI runs or external actions. Named-commit independent review and root integration remain required.
