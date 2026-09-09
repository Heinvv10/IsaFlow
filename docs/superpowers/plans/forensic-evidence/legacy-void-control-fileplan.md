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
