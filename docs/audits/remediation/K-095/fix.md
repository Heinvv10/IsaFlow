# K-095 — fix: a missing gateway secret is an outage, not a discount

**Trigger.** `POST /api/billing/flows/purchase` gated its unpaid fallback on
`Boolean(process.env.PAYSTACK_SECRET_KEY)` alone. With the key absent — unset, rotated out,
or missing from a deploy — any authenticated user of a `payg` company could call the route
and have the bundle credited to `flow_wallet` with a `purchase` row in `flow_ledger`, 201,
no payment taken.

**Before → after.** Before: no key → credit immediately. After: no key → 503
`SERVICE_UNAVAILABLE` and an error log, unless `ALLOW_UNPAID_FLOW_PURCHASE=true` **and**
`NODE_ENV !== 'production'`, in which case the admin-recorded fallback runs exactly as it did.
Local dev and pilot deployments keep working by setting the flag; production cannot opt in.

**Files.** `pages/api/billing/flows/purchase.ts` (new `unpaidFallbackAllowed()`, refusal
branch, doc comment); `.env.example` (documents the flag).

**Tests.** `tests/integration/k095-flow-purchase-fails-open-without-paystack.int.test.ts`
(1) and `tests/integration/k095-flow-purchase-fallback-gate.int.test.ts` (3) — real fixture
DB, real route. 4 passed. Adjacent cases: production overrides the flag; a malformed flag
value (`'1'`) is not an opt-in; a refusal leaves a second tenant's wallet untouched.
Mutation: reverting the production file takes all 4 red. See `green.log`.

**Migration / rollback.** None. Rollback is reverting the one file; the only operational
step is setting `ALLOW_UNPAID_FLOW_PURCHASE=true` on any non-production deployment that runs
without Paystack, otherwise flow purchases there start returning 503.

**Historical-data impact.** Wallets credited through this branch were never paid for. The
route reuses `payment_method = 'admin_recorded'`, so this query cannot separate a genuine
admin EFT top-up from a self-served free one — it bounds the exposure, it does not prove it.
Read-only, not executed here:

```sql
SELECT fp.company_id, COUNT(*) AS unpaid_purchases,
       SUM(fp.flows) AS flows_credited, SUM(fp.price_cents)/100.0 AS rand_not_collected
FROM   flow_purchases fp
WHERE  fp.status = 'succeeded'
  AND  fp.payment_method = 'admin_recorded'
  AND  fp.auto_triggered = false
GROUP  BY fp.company_id
ORDER  BY rand_not_collected DESC;
```

**Round 2 (blind review of fb63f304) — LOW-1.** `ALLOW_UNPAID_FLOW_PURCHASE` appeared nowhere
but the route, its tests and these docs, so a dev or pilot deployment that started returning 503
had no discoverable way to find the switch. It is now documented in `.env.example`, commented
out, next to the Paystack keys.

**Limits.** The fallback still writes `payment_method = 'admin_recorded'`. Giving it its own
value would make future rows separable, but it changes a stored enum-like value that reports
and the admin UI read, so it is left for a deliberate change. Whether production ever ran
without the key is a deployment question I did not inspect.

---

## Round 3 — disposition of the 8 findings in review-k095-r2.md (commit 3392181b1)

**HIGH-1 — FIXED.** `ux_sub_mandates_company_active` is a UNIQUE index on `(company_id) WHERE
status='active'` (migration 429), so scoping the activation to one id still 23505'd whenever the
company already had a *different* active mandate — reachable from an abandoned-then-retried
checkout, and in the webhook that throw rolls the event back, leaves `processed = FALSE`, answers
500 and loops Paystack's redelivery forever with the card charged. Activation now lives in
`src/modules/billing/services/paystackMandateActivation.ts`: a conditional UPDATE
(`status='pending' AND NOT EXISTS (…another active…)`) inside a SAVEPOINT, returning
`activated | already_active | not_pending | blocked`. The two settled outcomes get a `log.warn`
plus a `failure_reason` on the payment request instead of a throw. **No migration:** the constraint
the reviewer asked for already exists (429). Reserved prefix **656 is released, unused.**

**MEDIUM-1 — FIXED.** `verify.ts` re-reads the canonical state `WHERE id = <linked mandate>`; the
company-wide newest-first ORDER BY survives only for a pre-651 row with no resolvable link. Proved
on the response body, not the row states: the new test asserts `mandateId` and `maxAmountCents`.

**MEDIUM-2 — FIXED, by inversion.** The allow-list is gone. `BEST_EFFORT_ACTIONS` is empty and is
the only escape from fail-closed, so an action nobody thought about — including one that does not
exist yet — commits nothing unaudited. An allow-list of privileged actions has to be complete to be
correct; a deny-list of harmless ones only has to be right about the entries it names.

**LOW-1 — FIXED.** `activateAuthorisedMandate` returns `not_pending` for revoked/expired/failed, so
a payment event can never resurrect a revoked mandate. Asserted directly.

**LOW-2 — FIXED.** `tests/unit/services/adminCriticalActions.test.ts` now enumerates the two
emission mechanisms separately and asserts that a direct `INSERT INTO admin_audit_log`
(`impersonation_start`) does NOT count as covered by this service.

**LOW-3 — FIXED.** A paid authorisation that attaches to nothing keeps `status='completed'` (the
money really was taken) but records `failure_reason` — `authorisation_no_mandate_row`,
`authorisation_blocked` or `authorisation_not_pending` — so it is operator-visible rather than a
`log.warn` alone.

**LOW-4 — FIXED.** `.env.example` no longer promises a "pilot deployment" opt-in: `next build` +
`next start` sets `NODE_ENV=production`, so every deployed environment ignores the flag.

**LOW-5 — FIXED.** `src/modules/billing/.claude.md` documents `paystackMandateActivation.ts`, the
651 link contract, the 23505-must-never-escape rule and the new 503; `AGENTS.md` regenerated
(`bun run agent-docs:check` → 74 mirrors match).

**Round-3 tests.** `tests/integration/k095-mandate-activation-guards.int.test.ts` — 4 tests, real
fixture DB: the blocked second activation (tx still usable + COMMIT succeeds), the revoked mandate,
two concurrent activations on two pool clients (index arbitrates, loser reports `blocked` and its
transaction survives), and the verify response-body attribution. Whole item: 9 files / 37 tests.
Mutation: reverting `activateAuthorisedMandate` to the blind UPDATE takes all 4 red with
`duplicate key value violates unique constraint "ux_sub_mandates_company_active"`; making
`logAdminAction`'s catch return instead of throw takes 18 integration + 3 unit tests red.

**Historical-data impact (round 3).** Rows that already lost this race are readable — read-only,
not executed here:

```sql
SELECT pr.company_id, pr.paystack_reference, pr.completed_at, pr.mandate_id
FROM   paystack_payment_requests pr
WHERE  pr.purpose = 'authorization'
  AND  pr.status = 'completed'
  AND  NOT EXISTS (SELECT 1 FROM subscription_mandates m
                   WHERE m.id = pr.mandate_id AND m.status = 'active')
ORDER  BY pr.completed_at DESC;
```

Each row is a customer charged for an authorisation that never became their active mandate. The
fix stops new ones and labels them; it does not refund or re-activate anything, which is a
commercial decision.

**Limits (round 3).** `blocked` is recorded, not resolved: nobody is alerted and no refund is
raised. The pre-651 NULL-link fallback is still a newest-first heuristic — correct for one open
checkout, a guess for two, and only time retires it as those rows age out.

---

## Round 4 — disposition of the 8 findings in review-k095-r3.md (commit 131bf415d)

**MEDIUM-1 — FIXED.** The pre-651 fallback orders `(status='active') DESC` — which is what makes a
webhook *redelivery* idempotent — so a second paid checkout resolved the ALREADY-ACTIVE mandate,
short-circuited at `already_active`, and both callers read that as success: no label, no warn, a
charged card and a captured authorization code discarded. `resolveAuthorisedMandate` now returns
the row's `paystack_authorization_code` and whether the payment request *named* it (`linked`), and
an unlinked active row carrying a **different** code returns the new outcome
`already_active_other_code` → `failure_reason='authorisation_already_active_other_code'`. Same code
= genuine redelivery = `already_active`, unchanged. A `linked` row is never second-guessed.

**MEDIUM-2 — FIXED.** `paystack_payment_requests.failure_reason` had no reader, so "operator-visible"
was not met and the payer saw `pending` indefinitely. `GET …/mandate/verify` now reads it back and
answers `status: 'failed'` + `failureReason`; the return page renders "Your card was charged but the
mandate could not be activated — contact support" for an `authorisation_*` reason instead of the
card-declined copy. Both `noteAuthorisationNotAttached` call sites moved `log.warn` → `log.error`
so it reaches error tracking. A row is only *named* in the response when the request linked it or
nothing went wrong — a failed fallback resolution answers `mandateId: null`, never a neighbour's id.

**LOW-1 — FIXED.** `isUniqueViolation` matched bare `23505`. It is now `isActiveMandateConflict`:
`code === '23505' && constraint === 'ux_sub_mandates_company_active'`. Any other unique violation,
deferred constraint or trigger-raised duplicate reaches the caller instead of being reported as
"the company already has a different active mandate".

**LOW-2 — FIXED.** `verify.ts` branched its fallback re-read on `mandate === null` rather than on
whether the request *had* a link. A `mandate_id` that no longer resolves now answers
`mandateId: null` (no query at all) instead of the company-newest row.

**LOW-3 — FIXED.** `create.ts`'s failure-path `UPDATE subscription_mandates … WHERE id = ${mandateId}`
carries `AND company_id = ${req.companyId}`.

**LOW-4 — FIXED (documentation).** `src/modules/admin/.claude.md` records that fail-closed rolls back
the DB, not the outside world: `invoice.send`, `user.reset_password` and `user.force_logout` leave
their external effect done when the audit INSERT fails, so an operator reading that 500 must assume
the email or the password change happened. It also records that `logAdminAction` fails closed.

**LOW-5 — ACCEPTED, operational.** No code change: the 503 is correct. `PAYSTACK_SECRET_KEY` (test
key) must be set on the dev and pilot hosts before this ships, or Flow top-ups there return 503 with
no override (`NODE_ENV=production` under `next start` disables `ALLOW_UNPAID_FLOW_PURCHASE`). Flagged
for the deploy, not fixable from the repo.

**LOW-6 — FIXED.** `authorised_at` dropped from both `verify.ts` re-reads and from `MandateView`.

**Round-4 tests.** `tests/unit/services/paystackMandateActivation.test.ts` — 7 tests (different code
vs redelivery vs linked row; 23505 absorbed only for the named constraint; another constraint and a
non-unique error rethrown; revoked). `tests/integration/k095-r4-fallback-attribution.int.test.ts` —
3 tests on the fixture DB (second paid checkout labelled and both mandates untouched; same-code
redelivery left unlabelled; a dangling link answers no mandate while the company's own active row is
not reported). k095/k096/k097: **10 files / 40 tests**. Full unit suite with the fixture env unset:
**801 files / 9555 tests**. tsc, eslint, agent-docs (74 mirrors) clean.
Mutation: restoring the bare-`23505` match and dropping the different-code guard takes 2 unit + 1
integration test red; restoring `mandate === null` as the fallback predicate takes the dangling-link
test red; dropping `failureReason ? 'failed'` takes the round-3 verify test red.

**Historical-data impact (round 4).** No migration, no backfill. Requests that took the
already-active fallback before this fix are unlabelled and indistinguishable from a redelivery —
read-only, not executed here:

```sql
SELECT pr.company_id, pr.paystack_reference, pr.completed_at, pr.paystack_authorization_code
FROM   paystack_payment_requests pr
JOIN   subscription_mandates m
       ON m.company_id = pr.company_id AND m.status = 'active'
WHERE  pr.purpose = 'authorization'
  AND  pr.status = 'completed'
  AND  pr.mandate_id IS NULL
  AND  pr.failure_reason IS NULL
  AND  pr.paystack_authorization_code IS DISTINCT FROM m.paystack_authorization_code
ORDER  BY pr.completed_at DESC;
```

**Limits (round 4).** `already_active_other_code` is still only a label plus an error log — no refund
and no ticket is raised, which stays a commercial decision. The different-code test is only possible
for rows where `paystack_authorization_code` was recorded; a pre-651 request whose code column is
NULL compares as different and is labelled conservatively.
