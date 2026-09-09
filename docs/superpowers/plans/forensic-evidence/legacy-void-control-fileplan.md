# Legacy void shared controls

Base243c0d88f; owner invoice_evidence; isolated feat/mcp-legacy-void-control-20260909.
Own core/paymentVoidService.ts and bank/bankAllocationUnwind.ts, focused tests and this plan. No bank allocation kernel files, registry or migrations.

## Callers and interface
Registered MCP writeVoidPayments.ts is the sole production caller of voidPaymentDocument. It preserves the public result/refusal contract. Bank-backed calls delegate the existing approved bank inverse. Non-bank calls must delegate existing AR cancellation/AP void; optional approvalId/reason must be validated by those real controls. Active immutable cash applications require their separate approved inverse first. Raw unwind helper production calls exist only in paymentVoidService; remove that destructive path. Direct legacy helper exports cannot synthesize authority from IDs and must refuse, not erase allocation history.

## Tests first
Actual PG tests cover journal-less legacy applied documents with unissued ALS, missing approval, raw helper invocation; approved direct AR/AP cash application -> approved inverse -> approved cancellation/void with retained rows and rollback. No payment/control mocks. Existing PDF side effect suppressed as standard synthetic bank fixture; actual journals and approvals used.

## Pending
RED/GREEN, focused and related PG, source TS/lint, independent named review. No production verification.

## RED evidence and implementation checkpoint
- Test-first54169e3cc, actual PG58366 terminal1: journal-less AR/AP legacy void returned success, subtracted115 and removed original allocation rows with unissued ALS and with issued context but no independent approval. Both exported per-payment helpers similarly mutated without permits; journal-wide helper returned a result without authority. Two positive fixtures initially failed unrelated AR account ambiguity/AP empty-allocation currency; not counted as source findings.
- Adapter delegates every non-bank economic mutation to existing cancelCustomerPayment / voidSupplierPayment, inside its savepoint; current matching principal and invoices/post permission required before payment lookup. Actual bank inverse delegation retained. Raw helper exports now refuse rather than mutate; there are no remaining production callers of them after adapter correction.
- Corrected legitimate fixtures: explicit AR bank account avoids duplicate system-bank selection; AP direct processing requires its original invoice allocation, retained through approved void. AR positive covers separately approved cash application and inverse before receipt cancellation. No alteration to AP currency/source contracts.
- Source TS and two-file ESLint46511 terminal0. No source changes since these checks. Positive PostgreSQL pending serialized lease.

## Central dependencies
Root owns MCP tool schema/forwarding: writeVoidPayments currently lacks approval_id, so real approved service success does not imply MCP handler success. Bank-backed shape additionally needs prepared inverse intent_id forwarding, otherwise the adapter creates a new intent that cannot consume an approval for the old one. Requested optional VoidPaymentOptions.intentId alignment with existing bank inverse signature; approval pending root contract decision.
Existing old unit files paymentVoidService.test.ts / bankAllocationUnwind.test.ts assert raw mutations and old helper spies. Their economic assertions need mapping to actual PG coverage before contract adaptation, not deletion to hide failures.

## Actual verified lifecycle
- Root approved optional intentId alignment; forwarded solely to existing owned bank inverse checks. Added actual bank-backed document inverse with prepared intent/approval identifiers.
- First corrected run56524 terminal1: ten tests passed, only AP duplicate system-bank fixture failed. Explicit AR/bank account now non-system, leaving the AP fixture's single system bank. No source workaround for ambiguous accounts.
- Final98039 terminal0:14/14 real PG tests pass (`legacy-void-controls-final-pg.log`): twelve new shared void scenarios and two existing cash-domain refusals. Includes actual approved direct AR cancellation after independently reversed cash history, AP process/void retaining original allocations, outer rollback, bank-backed prepared inverse, unissued context, missing approval, revoked current permission and raw helper refusals.
- All fixture pools closed and DB lease released. Final source typecheck after optional intentId typing pending source lease; prior source46511 typecheck/lint passed. Named independent review pending. MCP schema/forwarding remains root's integration task.

## Independent findings and shared correction
- Snapshot review of291b confirmed requested bank payment could be a different active sibling of the original effect child. Old unit coverage mapping additionally exposed journal-wide sibling safety lost by single-payment delegation.
- Root explicitly extended ownership to `controls/bankChildReversalGuard.ts`, already called by real AR and AP materializers during preparation and execution; bank kernel worker files remain untouched.
- Actual21560:15 PG pass plus one document-level shared-journal RED. Actual78040:15 pass plus seven true REDs (direct AR/AP shared journal before/after approval, document adapter shared journal, customer/supplier impostor bank child with genuine approved inverse). Tests-first02ab47ebb. No earlier permission/staleness refusal masks these cases.
- Shared guard bounds live customer+supplier journal child reads to two. A single-payment approval refuses aggregate journal ownership at both materialization phases. Bank adapter identity checks owned immutable intent/effect kind, payment ID, bank ID, journal ID and actual current bank journal relationship before dispatch.
- Initial64605:34/37 pass; bank query FOR SHARE on immutable control tables required forbidden UPDATE privilege. Corrected query keeps immutable rows SELECT-only and locks mutable bank/journal rows, preserving restricted grants. Final24561 terminal0:37/37 PG pass (22 legacy,13 bank,2 cash-domain), `legacy-void-identity-final-pg.log`.
- Unit compatibility uses real control issuance or real missing-context failures, no blanket boundary mocks. Twelve focused units35874 terminal0. Source typecheck/three-file lint56041 terminal0. DB/heavy leases released.

## Coverage mapping from retired raw-spy units
- Financial relative balances, status and dates: actual bankSettlementMetadata lifecycle plus direct AR/AP void PG; immutable histories survive inverse/cancel rather than DELETE assertions.
- Unwind-before-contra call order: replaced by actual outer rollback and unchanged original allocations, balances and payment rows; operations own savepoints.
- Journal-wide sibling handling: explicit aggregate ownership refusal at real shared AR/AP boundary, verified before and after approval. No unauthorised sibling mutation.
- Bank delegation/counts/reversal date: actual prepared approved bank inverse settles/reopens115 and reports one invoice; actual two-bank ambiguity refuses before effect.
- Foreign/missing, draft/approved-stage, already-cancelled: actual PG refusal and unchanged state.
- Row-lock safety: actual approved two-session direct/adapter cancellation test newly authored after identifying policy/payment ordering inversion; pending RED then correction. Current real payment lock helper remains in use.
- Posting attribution remains owned by actual domain/principal; supplied posting labels do not bypass bank identity or approvals. Existing bank lifecycle PG retains PAT attribution checks.

## Concurrency test correction
Initial58118/76523 observed40P01, but the synthetic direct caller acquired policy before actual permission-principal locks, unlike the real executor. The subsequent52590 run still deadlocked after policy-before-payment source change. Those runs do not prove the intended payment-lock inversion. Corrected fixture now preloads actual approvalAuthorities and effective permissions before holding policy, and uses a third genuinely authorized actor for the contender. The contender's real lock wait is observed through pg_locks. The proposed source policy lock was removed again before the corrected RED; all other37PG remain verified. Corrected RED/GREEN pending next lease.

## Corrected concurrency conclusion: finding withdrawn
Corrected33831 terminal0 PASSED before any new adapter policy lock. Committed626 and627 both acquire the same `control-authority:<company>` advisory lock before participant row locks. The original synthetic test held policy before that real authority stage and manufactured40P01; its interpretation as a production payment-lock inversion is withdrawn. No additional source policy lock remains. The retained test now uses actual approvalAuthorities, actual effective permissions and an independent third authorized company actor, observes a real waiter, and verifies both calls finish with exactly one contra. This is positive concurrency evidence, not a RED-to-fix claim.

The seven independently reproduced shared-journal/bank-child identity gaps remain confirmed and corrected. Source final state matches the three-file typecheck/lint56041 result. Final full38PG run83461 terminal0:38/38 pass (`legacy-void-complete-final-pg.log`), all fixture pools closed and DB lease released to root. Independent final named review still required.
