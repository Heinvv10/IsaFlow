# Legacy void shared controls

Base243c0d88f; owner invoice_evidence; isolated feat/mcp-legacy-void-control-20260909.
Own core/paymentVoidService.ts and bank/bankAllocationUnwind.ts, focused tests and this plan. No bank allocation kernel files, registry or migrations.

## Callers and interface
Registered MCP writeVoidPayments.ts is the sole production caller of voidPaymentDocument. It preserves the public result/refusal contract. Bank-backed calls delegate the existing approved bank inverse. Non-bank calls must delegate existing AR cancellation/AP void; optional approvalId/reason must be validated by those real controls. Active immutable cash applications require their separate approved inverse first. Raw unwind helper production calls exist only in paymentVoidService; remove that destructive path. Direct legacy helper exports cannot synthesize authority from IDs and must refuse, not erase allocation history.

## Tests first
Actual PG tests cover journal-less legacy applied documents with unissued ALS, missing approval, raw helper invocation; approved direct AR/AP cash application -> approved inverse -> approved cancellation/void with retained rows and rollback. No payment/control mocks. Existing PDF side effect suppressed as standard synthetic bank fixture; actual journals and approvals used.

## Pending
RED/GREEN, focused and related PG, source TS/lint, independent named review. No production verification.
