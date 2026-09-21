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

---

## Round 5 — blind review of 1d5aa28fd (1 HIGH, 4 LOW)

**HIGH-1 — FIXED. `verify` racing the webhook reported an ACTIVE mandate as permanently `failed`.**
Round 4's own regression. `activateAuthorisedMandate` read the mandate once, at the top of the
request, then treated its conditional UPDATE writing zero rows as proof that a *different* row held
the company's active slot. `status = 'pending'` fails identically when the `charge.success` webhook
activated *this* row in the meantime — a window exactly as long as verify's outbound
`verifyTransaction` call, which is when the webhook lands. Round 4 made that durable and
payer-visible: `authorisation_blocked` persisted to `failure_reason`, the route answered `failed`,
and the return page told the payer their card was charged but no mandate exists.
*After:* `reclassifyAfterNoUpdate` (`paystackMandateActivation.ts`) re-reads the row before the
conclusion is drawn — on the zero-row path and on the absorbed 23505 alike. Active + same code (or
linked) → `already_active`; active + different code on an unlinked row → `already_active_other_code`;
still pending → `blocked` (the NOT EXISTS or the index really did stop us); gone/other →
`not_pending`. Belt and braces at the boundary: `verify` no longer lets a persisted `failure_reason`
outrank *this reference's own* mandate being `active`, so a reason written by any future path — or
already on disk — heals instead of defaming a chargeable mandate.

**LOW-1 — FIXED.** `verify.ts` nulled only `mandateId` for an unattributable fallback and still
returned that row's bank, card and ceiling. One `own` binding now gates the whole mandate view.
**LOW-2 — FIXED.** The dead `status='failed'` UPDATE in `create.ts`'s catch is gone: the 500 makes
`withAuth` ROLLBACK, discarding it *and* the INSERT it referred to, and on a SQL error it would have
raised 25P02 out of the catch with no savepoint.
**LOW-3 — DISPUTED, no change. `paystack_reference` IS unique.** `486_paystack_billing.sql:31`
declares `paystack_reference TEXT NOT NULL UNIQUE`; the backing index is a UNIQUE CONSTRAINT, which
`\d` lists under a separate heading from the plain indexes. Executed against the fixture DB:
`paystack_payment_requests_paystack_reference_key" UNIQUE CONSTRAINT, btree (paystack_reference)`.
No migration is needed and none was written; migration prefix 664 is RELEASED, unused.
**LOW-4 — FIXED.** The failed panel labels its link "Back to billing" when the reason starts
`authorisation_`, since `create.ts:44-53` answers 400 while an active mandate exists.

**Files (round 5).** `src/modules/billing/services/paystackMandateActivation.ts` (244),
`pages/api/billing/paystack/mandate/verify.ts` (202),
`pages/api/billing/paystack/mandate/create.ts` (126),
`pages/admin/billing/paystack/return.tsx` (157), `src/modules/billing/.claude.md` + `AGENTS.md`.

**Tests (round 5).** New `tests/integration/k095-r5-verify-webhook-race.int.test.ts` — 6 tests on
the fixture DB with two pool clients: webhook committing *during* verify's Paystack call
(webhook-after-read, the proved defect); verify first then a webhook redelivery, plus a later poll;
a second observer calling `activateAuthorisedMandate` with a stale `pending` read; a genuinely
blocked activation that must stay `blocked`; a `failure_reason` already on disk against an active
linked mandate (healed); an unattributable fallback returning no card/bank/ceiling.
`tests/unit/services/paystackMandateActivation.test.ts` 7 → 10.
New `tests/unit/components/paystackMandateReturn.test.tsx` — 2 rendered tests for LOW-4.
k095/k096/k097 integration: **11 files / 46 tests**. Full unit suite, fixture env UNSET:
**801 files / 9558 tests, 0 failed**. Components: 68 files / 443 tests. `bun run lint` 0 errors
(11 pre-existing warnings, none in these files); `bunx tsc --noEmit` clean; agent-docs 74 mirrors OK.

**Mutation (round 5), each reverted then restored.** `reclassifyAfterNoUpdate` → hardcoded
`'blocked'`: 2 integration + 3 unit red. `publicStatus` heal reordered so `failureReason` outranks an
active own mandate: 1 integration red. `own` gating removed (LOW-1): 1 integration red.
`failureReason` dropped from the response: 3 red across 2 files. Return-page label forced back to
"Try again": 1 component red. Round 4's four mutations still hold.

**Historical-data impact (round 5).** No migration. A wrongly persisted `authorisation_blocked` can
only have been written by round-4 code, which lives solely on this unmerged branch — production has
never run it, so no production row can carry one. Should any exist, the route now heals them on
read; to find them (read-only, NOT executed here):

```sql
SELECT pr.company_id, pr.paystack_reference, pr.failure_reason, m.status AS mandate_status
FROM   paystack_payment_requests pr
JOIN   subscription_mandates m ON m.id = pr.mandate_id
WHERE  pr.purpose = 'authorization'
  AND  pr.failure_reason IN ('authorisation_blocked', 'authorisation_not_pending')
  AND  m.status = 'active'
ORDER  BY pr.completed_at DESC;
```

**Limits (round 5).** The heal is read-side only: a stale `failure_reason` stays on the row and is
still visible to anyone querying the table directly. Clearing it would need a status-predicated
UPDATE on a GET, which is worse; the row is diagnostic and the payer-facing answer is now correct.
The re-read costs one extra SELECT, and only on the path that already lost the race.

---

## Round 6 — blind review of 5c6e1a50c (0 HIGH, 0 MEDIUM, 1 LOW)

**LOW-1 — FIXED. The pre-651 unlinked fallback could still name another checkout's FAILED row.**
`verify.ts` ran a SECOND, unlinked lookup whenever `pr.mandate_id IS NULL` and
`resolveAuthorisedMandate` resolved nothing — and that query admitted `status = 'failed'`. With no
`failure_reason` recorded, the round-5 `own` gate (which keys off `failureReason`) let the row
straight into the response, so the payer was shown the id, bank, card and ceiling of a mandate row
some *other* checkout created: the mis-attribution migration 651 exists to retire, in the one shape
the gate did not cover.
*After:* the second lookup is gone entirely, not merely narrowed. `resolveAuthorisedMandate` has
already run the pre-651 newest-first fallback over the company's `pending`/`active` rows; if it
resolved nothing, every remaining row is one no live checkout owns — a failed/revoked row this
reference cannot prove is its own, or a row a concurrent checkout inserted *after* that read.
Restricting the list to `('active','pending')` would have left exactly that race as a fresh
mis-attribution, so `fresh` is now read only for the mandate the request actually resolved.
The failure signal is taken from THIS reference's own row instead: `publicStatus` falls back to
`pr.status === 'failed'`, which `verify` itself writes on the failed/abandoned live path. Public
status is therefore unchanged for a genuinely failed checkout; only the identifying fields go.

**LOW-3 (round 5) — RULING RECORDED: the dispute is UPHELD, the finding was wrong.** The round-6
reviewer executed `\d` against the fixture and read `486_paystack_billing.sql:31`
(`paystack_reference TEXT NOT NULL UNIQUE`); the backing UNIQUE CONSTRAINT exists. No migration was
needed and none was written. Prefix 664 stays released.

**Files (round 6).** `pages/api/billing/paystack/mandate/verify.ts` (199 lines).

**Tests (round 6).** New `tests/integration/k095-r6-unlinked-failed-fallback.int.test.ts` — 4 tests
on the fixture DB: the reachable case (pre-651 request, `pr.status='failed'`, only another
checkout's failed mandate for the company) still reports `failed` while naming nothing; a
`completed` pre-651 request that resolved nothing stays `pending` rather than borrowing a
neighbour's failure; a second tenant gets 404 for the same reference; and the surviving pre-651
newest-first resolution of a LIVE row still attributes correctly (continuity guard).
K-095 integration re-run together: 4 files / **17 passed**. Full unit suite, fixture env UNSET:
**801 files / 9558 passed, 0 failed**. `bunx tsc --noEmit` clean; `bunx eslint` on the changed
source file exit 0.

**Mutation (round 6).** Reverting `verify.ts` to `5c6e1a50c` takes 2 of the 4 new tests red
(`mandateId` leaked, and `pending` reported as `failed`); the finer mutation of dropping only
`|| pr.status === 'failed'` takes the first test red on `expected 'pending' to be 'failed'`. Both
restored; the round-5 suites still pass unchanged.

**Historical-data impact (round 6).** No migration, no backfill — this is a read path only; no row
was ever written wrongly by it. Pre-651 requests that could have been answered with a neighbour's
failed row are listable (read-only, NOT executed here):

```sql
SELECT pr.company_id, pr.paystack_reference, pr.status, m.id AS row_that_would_have_been_shown
FROM   paystack_payment_requests pr
JOIN   LATERAL (SELECT id FROM subscription_mandates sm
                WHERE sm.company_id = pr.company_id AND sm.gateway = 'paystack'
                  AND sm.status = 'failed' ORDER BY sm.created_at DESC LIMIT 1) m ON true
WHERE  pr.purpose = 'authorization'
  AND  pr.mandate_id IS NULL
  AND  pr.failure_reason IS NULL
  AND  NOT EXISTS (SELECT 1 FROM subscription_mandates s
                   WHERE s.company_id = pr.company_id AND s.gateway = 'paystack'
                     AND s.status IN ('pending','active'))
ORDER  BY pr.created_at DESC;
```

**Limits (round 6).** The pre-651 fallback that remains — `resolveAuthorisedMandate`'s newest-first
pending/active resolution — is still a heuristic for a company with two open checkouts; round 4's
different-code guard is what bounds it, and only time retires it as those rows age out. A pre-651
request that completed but resolved nothing now answers `pending` rather than a borrowed `failed`;
that is honest (nothing on the reference says it failed) but it is a status change for those rows.
