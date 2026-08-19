# Self-serve signup — open registration with trial seeding

**Decided 2026-08-19.** Replaces the pre-launch waitlist gate on `/register`.

## Decisions (locked)

1. **Open self-serve.** Anyone can register at `/register`. No approval step.
2. **Lead creates their own account** — we do not create it for them.
3. **Trial plan, 14 days.** New tenants land on the `trial` plan with
   `companies.trial_ends_at = now() + 14 days`.
4. **Turnover collected at signup** so `payg_eligible` is correct from day one
   (< R1 000 000 declared → eligible), driving post-trial PAYG conversion.

## Facts established (verified against prod, 2026-08-19)

- `POST /api/auth/register` was never gated — the gate is `pages/register.tsx:32`
  rendering `WaitlistForm` unless `?invite=` is present.
- The *emailed* invite path is `/accept-invite?token=` →
  `POST /api/invitations/{token}/accept`, and it is correct.
  `pages/api/invitations/index.ts:70` builds that URL.
- `/register?invite=` → `InviteRegisterForm` → `/api/auth/register` is a **dead,
  broken duplicate**: it posts no `companyName` (which register requires → 400)
  and register never reads `inviteToken`. Nothing links to it. Delete it.
- `companies.plan_id` is vestigial: 0 of 10 prod rows populated. Plan lives in
  `subscriptions` (`status` CHECK allows `'trial'`); trial expiry lives on
  `companies.trial_ends_at`.
- Neither `/onboarding` nor `register.ts` sets `plan_id`, `payg_eligible`, or
  `annual_turnover_cents` today.
- Prod plans: `trial` R0, `payg` R0, `starter` R299, `professional` R599,
  `enterprise` R1499.
- ~~`promoteWaitlistSignup` passes `plan_id` to `createCompany`, which writes the
  dead `companies.plan_id` column.~~ **WRONG — corrected in review.**
  `createCompany` (`adminCompanyService.ts:289-294`) never writes
  `companies.plan_id`; it already inserts the `subscriptions` row itself when
  `plan_id` is set. The promote path was correct all along.

## Work

### 1. Shared seeding policy
Extract the PAYG/plan policy out of `buildCompanySeed` (which is coupled to
`WaitlistSignupRow`) into a pure function over declared turnover + signup type,
in `src/modules/onboarding/services/`. Both callers use it.

### 2. Tenant provisioning helper
One function that, given `{ companyName, turnoverCents, signupType, ownerUserId }`,
inside a single transaction:
- INSERT `companies` (name, is_active, annual_turnover_cents, payg_eligible,
  trial_ends_at = now() + 14d)
- INSERT `subscriptions` (company_id, plan_id = `trial`, status = `'trial'`,
  current_period_start = now(), current_period_end = now() + 14d)
- INSERT `company_users` (owner, is_default) + `users` profile shadow

### 3. `pages/api/auth/register.ts`
Accept `companyName`, `signupType` (`direct` | `accountant`), optional
`annualTurnover` (whole ZAR → cents) and `phone`. Call the provisioning helper
instead of its inline INSERTs. Keep existing enumeration defence, rate limits,
and GoTrue rollback behaviour unchanged.

### 4. `src/components/auth/SignupForm.tsx` (new)
Public signup: first/last name, email, password + confirm, company name,
signup type toggle, annual turnover (optional), phone (optional). Posts to
`/api/auth/register`, auto-signs-in, redirects to `/onboarding`.
Mirror `WaitlistForm`'s existing visual shell.

### 5. `pages/register.tsx`
Render `SignupForm`. Redirect `?invite=<t>` → `/accept-invite?token=<t>` so any
old link still works.

### 6. Delete the dead path
Delete `src/components/auth/InviteRegisterForm.tsx` only.
**Correction:** `pages/api/invite/[token].ts` is NOT dead — `pages/invite/[token].tsx`
and `pages/login.tsx` both call it (GET for invite metadata, POST for an
already-signed-in user to join). Keep it.

### 7. ~~Fix promote to match~~ — DROPPED
Based on the false premise above. Promote already creates the subscription via
`createCompany`; adding a second INSERT produced duplicate conflicting rows
(caught in blind review). Promote now only shares the PAYG/plan *policy*
functions, not the write. A regression test asserts promote issues no
`INSERT INTO subscriptions` of its own.

### 8. Team notification
Keep the signup notification email (currently `pages/api/waitlist.ts:137` →
`ai@velocityfibre.co.za`) firing on self-serve registration.

## Out of scope (flagged, not built)

- **Email verification.** `adminCreateUser({ email_confirm: true })` auto-confirms,
  so at volume anyone can create a tenant on an address they don't own. Only
  brakes are 5/hr per-IP and 5/hr per-email rate limits. Separate piece of work.
- Card-on-file at signup / Paystack checkout.
- Trial-expiry enforcement and conversion prompts.
- The waitlist form, API, and admin page stay in place for the 3 existing rows.

## Acceptance criteria

- A registration through the browser at `/register` yields: GoTrue user;
  `companies` row with correct `payg_eligible` + `trial_ends_at`;
  `subscriptions` row on plan `trial` with status `trial`; `company_users` owner
  row; and lands on `/onboarding` signed in.
- Declared turnover R900 000 → `payg_eligible = true`; R1 200 000 → `false`;
  undeclared → `false` with `annual_turnover_cents` NULL (never 0).
- `/register?invite=<token>` redirects to `/accept-invite?token=<token>`.
- `/accept-invite` still joins an invitee to the *inviting* company — no second
  company created.
- `bun run ci` green. Browser proof required, not just API proof.
