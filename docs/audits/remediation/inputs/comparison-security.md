# Auth, billing, and capture audit comparison

Reviewed commit: `5661d6f0f5f2212705151e95455a3f681ddf840e`.

Compared Claude's `2026-09-08-claude-full-code-audit.html` and `2026-09-08-detail/api-admin-auth-billing-portal.md` with our `2026-09-08-codebase-audit.html` (54 findings). Committed source was read with `git show`. This comparison is source-traced; no new runtime tests, external requests, or deployment verification were performed. Severity below uses our P1/P2 scale, rather than treating Claude's CRITICAL labels as established.

## Requested findings

| Claude ID | Decision and corrected severity | Source evidence and bounded scenario |
| --- | --- | --- |
| C3 | Retain P1; distinct from F33 | `src/modules/billing/services/subscriptionBillingService.ts:125-130` advances the subscription period on charge creation. Failed attempts update only the charge at `249-258`; selection excludes charges after the attempt limit at `172-175`. The missing delinquency lifecycle leaves the subscription active after collection is exhausted. Advancing a billing period by itself can be legitimate; missing handling of unpaid renewals is the stronger finding. F33 instead concerns ignoring scheduled cancellation. |
| C12 | Retain narrowly, P2; confidence high in allowlist defect, no cross-tenant exposure established | `src/modules/accounting/services/core/nlQueryValidationService.ts:119` does not recognize double-quoted table identifiers. Contrary to the report's outdated substring-only description, `pages/api/accounting/nl-query.ts:109-117` applies an AST tenant-scope guard. `src/modules/accounting/services/core/nlQueryScopeGuard.ts:118-123` accepts arbitrary table names and later validates their company scope, without enforcing the table allowlist. This permits nonallowlisted own-tenant tables subject to their RLS; the precise sensitive-column impact depends on those policies. Fix by checking parsed table nodes against the allowlist and enforcing appropriate column/role restrictions. |
| C17 | Retain P1; high source confidence, probabilistic trigger | `src/modules/accounting/services/capture/captureInboxService.ts:47-53` generates 24 random bits. `scripts/migrations/sql/409_capture_and_evidence_ledger.sql:25` makes only `(company_id, channel, address)` unique; the address index at `29` is nonunique. `src/modules/accounting/services/capture/inboundEmailService.ts:84-98` selects the first active inbox by address alone, then uses its company. A cross-company address collision can route documents to the wrong company. No collision execution or deployed population was measured. Add global active-address uniqueness and sufficient identifier entropy. |
| C18 | Retain routing defect P1; reject missing-signature allegation | `pages/api/accounting/capture/whatsapp-inbox.ts:43-56` accepts an E.164 address without global ownership/uniqueness validation. `src/modules/accounting/services/capture/whatsAppInboundService.ts:86-106` resolves the company by destination alone with LIMIT 1. Migration409 permits duplicate destinations across companies. Two companies configured with the same destination have ambiguous routing. However, `pages/api/accounting/capture/inbound/whatsapp.ts:87-95` returns503 when credentials are absent, before ingestion at97: it fails closed. Enforce verified, globally unambiguous destination routing. |
| C19 | Retain P1; new versus our54 | `pages/api/webhooks/paystack.ts:227-240` and `pages/api/portal/payments/paystack/verify.ts:80-96` change invoice paid totals without creating the canonical customer-payment and GL entries. Invoice settlement therefore diverges from the GL. Do not retain the stronger claim that subsequent correction is permanently impossible. Route gateway receipts through the canonical accounting payment operation with shared idempotency. |
| H48 | Retain P2 functional account-lifecycle defect | `src/lib/auth/gotrue.ts:190-201` returns the existing identity after a422 response to creation. `pages/api/invitations/[token]/accept.ts:54-57` unconditionally sets its password, then signs in at60. Accepting another-company invitation changes the existing account password globally. An invitation alone does not reset it; the acceptance flow is required. Existing identities should authenticate rather than repeat account-creation password setup. |
| H49 | Retain P1 conditional configuration defect | `pages/api/billing/flows/purchase.ts:37-68` immediately completes a bundle purchase if the Paystack key is missing, without a production-mode restriction. Export at136 has authentication and CSRF but no admin role restriction. `src/lib/observability/deepChecks.ts:89` treats absent configuration as a health-check condition rather than a startup prohibition. No evidence establishes that production currently lacks the key. Fail closed when payments are unavailable; restrict explicit manual credits to their administrative workflow. |

## H50 versus our F13

Claude's multiple-active-mandates/continued-debit scenario is contradicted by `scripts/migrations/sql/429_stitch_payments.sql:102-105`, which enforces one active mandate per company. Promoting several pending mandates fails that constraint. Retain our **F13, P2: Retrying mandate checkout prevents successful activation**. Do not add H50 as a separate continued-debit finding. Activation should identify a single mandate and checkout creation should handle existing pending attempts consistently.

## Our F01 versus Claude's MFA omission

**F01 remains valid, P1.** Claude's checklist establishes that normal login withholds regular session cookies until MFA, but does not establish API-level assurance enforcement. `src/lib/auth/gotrue.ts:52-57` verifies signature and subject without requiring AAL2. `src/lib/auth/withAuth.ts`, `withUserAuth.ts`, and `withPlatformAdmin.ts` lack an AAL gate. `middleware.ts:27-29` identifies the normal access cookie, and middleware checks do not establish token assurance. The pending login credential is still an AAL1 JWT.

Our earlier isolated mocked verification exercised this middleware distinction using a locally signed test credential and mocked database. That is prior local test evidence, not a new demonstration or a live-system result. Enforce the account's required assurance in shared authentication gates.

## Other interpretation differences

- Claude's clean webhook-signature assessment does not disprove **F02**. Authenticating and deduplicating an event does not ensure that failed processing is retried.
- Claude's OAuth checklist does not disprove **F40**. Atomic code consumption remains separate from successful token-row creation.
- The claim that rotation mints refresh tokens without offline_access is not established as a separately reachable defect merely because rotation always returns a refresh token: the path ordinarily requires an existing valid refresh token.
- **C3 and F33 are separate defects. H50 and F13 describe the same underlying mandate-selection problem, with F13 giving the schema-consistent consequence.**

## Confidence and limits

The conclusions above concern the named commit. They do not certify the current deployment, database migration state, provider configuration, or occurrence frequency. No broad re-audit was performed for this comparison. C12's sensitive-data impact remains policy-dependent; C17 requires an address collision; C18 requires duplicate destination configuration; H49 requires absent payment configuration.
