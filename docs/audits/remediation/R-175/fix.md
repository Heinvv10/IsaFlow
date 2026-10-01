# R-175 and K-103 — the rate limiter admitted more calls than its limit, and wrote its counter on the request's transaction

## Defect

`checkRateLimit` in `src/lib/rateLimit.ts` kept a 5-second in-process LRU copy of each counter.
For a cost-1 call, while that copy was below half of `max`, it admitted the call and bumped only
the copy (`cached.count += 1`). The `rate_limit_counters` row never saw that call.

Every call that did reach the database overwrote the copy with the database count. That count
was lower than the copy, because the local admissions were missing from it. So the copy dropped
back under the threshold and the limiter admitted locally again.

Every rate-limited route went through this: login, 2FA, password reset, invites, portal payment
create and verify, AI, email send, report export, MCP.

## Measurement

On unchanged code (`origin/master` 090497265), against real PostgreSQL, one process:

- A limit of 20 admitted **65** of 100 sequential calls. The team lead's estimate was about 70.
- Two module instances sharing the table, 100 alternating calls: 65 admitted.
- Three calls far below a limit left a stored count of 1, not 3.
- 9 cost-1 calls then one cost-11 call left a stored count of 12, not 20.
- After 20 admitted calls a refund of 2 found a stored count of 1, so it could not give back 2.

100 concurrent calls (`Promise.all`) on a fresh key admitted exactly 20 even before the fix. They
all start before the first database answer fills the LRU. That case passes on both sides and is
kept as a guard.

Output: `red.int.log` (7 failed, 4 passed) and `red.unit.log` (4 failed, 2 passed).

## Fix

The short-circuit is removed. Nothing in the process can admit a call. (Review round 1 added a
cache that only refuses; see below.)

- Every `checkRateLimit` call does the atomic upsert. The verdict is `count <= max` on the row
  the database returns. The SQL logic is unchanged, except it no longer returns `window_start`.
- `refundRateLimit` no longer has an LRU entry to drop. Its SQL logic is unchanged.
- `clearRateLimitCache` was a no-op after this step. Since review round 1 it clears the
  refuse-only cache.
- `lru-cache` is no longer imported here. Other modules still use the package.
- No exported signature changed. No caller's code changed.

Comments that described the old behaviour were corrected in
`pages/api/invitations/[token]/accept.ts`, `pages/api/mcp/index.ts` and
`src/lib/rateLimit.claude.md`. Invite-accept keeps `ATTEMPT_COST = 2`; it is still ten attempts
an hour, and changing it would change what the live counters mean.

A cache that only refuses early was first left out. Review round 1 showed why it is needed, and
it is now built. See "Review round 1".

## K-103 — fixed in the same branch

R-175 alone could not ship. The limiter used the shared `sql` template. Inside a request
transaction `sql` runs on the request's own connection. Two things followed:

- A request that rolled back was never charged.
- The key's row lock was held until the request ended, so same-key requests queued.

Before R-175 that only happened above half the limit. With R-175 it happened on every call.

Measured on 527dda3f4 (`../K-103/red.r175.int.log`, 5 failed, 2 passed): no counter row after a
rollback; a refund undone by a rollback; a second same-key request still blocked after 2 seconds.

### Fix

`checkRateLimit` and `refundRateLimit` run on the limiter's own pool,
`src/lib/rateLimitPool.ts`, outside any transaction. Each statement commits by itself. The charge
survives whatever the request does, and no lock outlives the statement. The refund takes the same
path as the charge.

### Why a separate pool

A request already holds one connection from the main pool for its transaction. If the limiter
took a second one from that pool, a full pool of requests would each wait for a connection that
none of them can free. Measured (mutant K3): with all 10 request connections held, a limiter on
the main pool waits the full 15-second connect timeout. K-103's validation proposed the main
pool; that was not used for this reason.

### Size, cost and failure

- 3 connections per process, fixed. Each statement takes about a millisecond.
- Cost: up to 3 more PostgreSQL connections per app process. They close after 30 seconds idle.
  The number of production processes and the server's connection limit were not checked.
- A call waits at most 5 seconds for a connection, then throws. One caller catches a limiter
  error: `shareResolver.ts:94`, which logs it and refuses the share link. Every other caller lets
  it through, so the request fails with a 500. That is what a database error has always done
  here. Nothing is admitted unchecked.
- Statement, lock and query timeouts were added in review round 1. An earlier version of this
  document said a limiter statement could only wait behind another limiter statement. That was
  wrong: `rateLimitCleanupService.ts:27` deletes the same rows through `sql`, possibly inside a
  request transaction, and DDL or VACUUM FULL can hold the table.

### Row security and role

On the fixture, `rate_limit_counters` has no row security, no policies and no triggers.
`app_user` and `platform_admin` hold INSERT, SELECT, UPDATE and DELETE.

The limiter pool connects with `DATABASE_URL`, the same role as the main pool before any
`SET LOCAL ROLE`. Login, register and password reset already write the table on that role,
outside any transaction. Inside `withAuth` the write used to run as `app_user`; it now runs as
the pool role. The production role's grants were not inspected.

## The strongest argument against

One extra database round-trip per rate-limited request, on a second connection. Calls under
half their limit used to cost nothing. Now each is an upsert, and the limiter keeps up to 3
connections of its own per process.

A flood of limited requests now queues on 3 connections instead of spreading over the request
pool. If the queue is longer than 5 seconds the requests fail with 500. This was not load-tested.

A request that fails is now charged. That is K-103's intent, but it is a change: a route that
returns 500 repeatedly will use up its caller's allowance. Review round 1 gives the daily AI and
send units back in that case; the short buckets stay charged.

## Behaviour that changes for callers

- Limits now hold at their stated value. Callers that were getting about three times their limit
  will be refused sooner.
- A refused call still adds to the counter, as it did before whenever it reached the database.
- A charge is kept when the request rolls back. `withAuth` and the bearer pipeline ROLLBACK
  after a 429; that used to undo the refused call's own increment and now does not.
- Same-key requests no longer wait for each other.
- `pages/api/invitations/[token]/accept.ts` wrapped its charge and refund in `als.exit`. That is
  no longer needed. Review round 1 removed the wrappers.

## Tests

- `tests/integration/r175-rate-limit-admits-over-max.int.test.ts` — 11 cases on real PostgreSQL:
  exactly `max` admitted, sequential and concurrent; a low-volume call is stored; cost-1 calls
  count against a later weighted call; weighted calls; window rollover; a window that has not
  ended; refund; refund floor, window and absent key; two module instances, alternating and
  concurrent. Red 7 of 11, green 11 of 11.
- `tests/integration/k103-rate-limit-rolls-back-with-request.int.test.ts` — 7 cases: the charge
  survives a rollback and is visible before the request ends; a handler that throws is charged;
  a refund survives a rollback; two same-key requests held open do not block each other, with
  both transactions checked as still open; 40 concurrent requests admit exactly `max`; the
  limiter answers while every request connection is held; the limiter fails within a bound and
  does not admit when its own pool is exhausted. Red 5 of 7, green 7 of 7.
  The register named this file, but it was not in the repository at any ref. It was rewritten
  from `../K-103/red.log`, keeping the two original cases.
- `tests/unit/lib/rateLimitEveryCallCounted.test.ts` — 6 cases with the pool mocked. Red 4 of 6
  on `origin/master`, green 6 of 6.
- The whole unit suite: 1117 files, 14881 pass, 6 skipped, the same as before the K-103 change.
  Two files mocked `sql` for the limiter and now mock its pool: `checkReportRateLimit.test.ts`
  and the new unit file.
- The four limiter unit files against the fixture database: 34 pass.
- Every other `tests/integration` file that mentions the limiter or its table: 23 files. 16 pass.
  7 fail (15 tests), and the same 15 fail with `origin/master`'s limiter swapped in. The causes
  are the harness: no GoTrue on the fixture, a database-name guard, and a function owner. See
  `green.log`.
- `mutations.log`: 14 mutants on the first commit, then 19 on the pool-based code (K1 to K7 for
  K-103, and the R-175 set repeated). All red. Baseline green afterwards. The pool size is
  tuning, not a guard, and has no mutant.

Not verified:

- k-041 "L4" and "L7", which drive the limiter and the refund through the invite-accept route.
  They need GoTrue, which this harness does not have.
- The rest of `tests/integration`, which was not run.
- The production role's grants and the connection budget, as noted above.
- Behaviour behind a connection pooler, if production uses one.

Stale LRU comments in `tests/unit/lib/rateLimit.test.ts` and `rateLimitSend.test.ts` were
corrected. Comments only; one test title still mentions the LRU.

## Review round 1

Both blind reviewers said SHIP on c5b0ba6d0, with findings. All are handled below.

### 1. Flood on an over-limit key: the refuse-only cache

Every call was a committed write on 3 connections, refused calls included. A flood from one
over-limit address could keep the pool busy and make every limited route answer 500.

Now, when the database reports a key over its limit, the process remembers the count it saw. A
later call on that key with the same or a lower `max` is answered `false` from memory, with no
database call.

- Memory never admits. The only path that returns `true` is the database's answer.
- A refusal is remembered for at most 5 seconds (`REFUSAL_TTL_MS`), and never past the end of the
  key's window. The window end comes from the database clock, measured from before the
  round-trip.
- `refundRateLimit` drops the entry. `clearRateLimitCache` clears all entries.
- The cache is an LRU of 10 000 keys.

The 5-second cap is a deliberate change from "until the window ends". This process is not told
when another process refunds, when the nightly cleanup deletes rows, or when an operator deletes
a counter to unlock someone. With no cap that stays invisible for up to a day. With the cap, a
flood on one key costs one write per process every 5 seconds.

What it does not cover: a flood that uses a new key each time (many addresses). Each new key is
still one write.

Pool size stays at 3. The pool now carries only calls that may be admitted, about a millisecond
each. A larger pool would only matter for the many-keys flood, and there it would take more of
the server's connections, which were not counted.

### 2. Every wait on the limiter pool is bounded

`lock_timeout` 2 s, `statement_timeout` 3 s, `query_timeout` 4 s, connect timeout 5 s. The server
gives up first. `query_timeout` is a client-side timer that abandons a query without cancelling
it, so it must be the longest of the three or the connection goes back to the pool still busy.

They are sent as connection start-up parameters. This works against PostgreSQL directly (the
fixture, and `isaflow_dev` on port 7772). A transaction pooler can reject start-up parameters it
does not know, and a rejected connection would make every limited route fail.

Verified by the team lead on 2026-10-01: production's `DATABASE_URL` targets port 7772, which is
the `isaflow-supabase-db` container's PostgreSQL directly. The Supavisor pooler is on 7773 and
7774 and is not used. So the start-up parameters are safe today. If the app is ever moved behind
a pooler, change this pool first (set the timeouts another way, or confirm the pooler passes
them).

Post-deploy check: `POST /api/auth/login` with a wrong password must answer 401, not 500. It is
unauthenticated and limited by `withRateLimit`, so a 500 there means the limiter pool cannot
connect.

A statement stalled on a locked row now fails with `55P03` after 2 seconds. The caller gets an
error, never an admission, and the pool is usable afterwards.

### 3. Failed requests burned usage quota

The limiter charges on its own connection, so a failed request keeps its charge. That is right
for an abuse limit. It is wrong for a usage quota, which bounds work actually done.

Review round 2 replaced the rule below with "charged minus used, on every exit". The mechanism
as it stood after round 1, in `src/lib/rateLimitQuota.ts`:

- `checkAiRateLimit` and `checkSendRateLimit` note what they charged the **daily** bucket on the
  request context.
- `withAuth` gives those units back when the request ends in a 5xx or a throw. Before K-103 the
  whole charge was rolled back in that case, so this restores the old outcome for the daily
  bucket only.
- A handler can give its own units back where it answers below 500 but did no work. A request
  can give back only what it charged, once.
- The 15-minute per-IP and per-company buckets are never given back. They bound a loop of
  failing requests. Only `withAuth` keeps the list, so every caller is authenticated.
- A refund that fails is logged and the units stay spent. It never changes the response.

Callers changed:

- All 12 `checkAiRateLimit` callers and all 6 `checkSendRateLimit` callers, through `withAuth`:
  a 5xx or a throw gives the daily units back. No edit in those files.
- `nl-query`: gives the unit back on every exit where the provider gave no answer (bad question,
  no key, provider error status, provider call threw). It keeps it once the provider answered.
  This route answers 200 on provider failure, so the 5xx rule alone did not cover it.
- `statement-bulk-email`: charges after the ownership guard, and gives back the emails that
  failed to send.

Not changed, for a decision:

- The other 10 AI routes and 5 send routes also have exits that answer below 500 without doing
  the work (a 400 after the charge, or a 200 with a fallback when the provider fails). Those
  still spend the daily unit, as they did before this branch. Each needs the `nl-query`
  treatment, one route at a time: roughly 110 exits in 15 files, and `ai-invoice-pipeline.ts` is at
  299 lines.
- Hourly per-company quotas that call `checkRateLimit` directly. A 5xx there now keeps its
  charge; before K-103 it was rolled back. Listed in the table as "left".
- `portal-chat` daily (500 per company). The caller is a portal customer, not a `withAuth` user.

Every caller, at 7b6ca9353. "Failed request" means one that passed the limiter and then failed.

Abuse limits. An attempt counts even when it fails. Not changed.

| Key | Max / window | Where charged | A failed request has used |
|---|---|---|---|
| `<scope>:ip:` via `withRateLimit`: login 20/900, 2fa-challenge 20/900, register 5/3600, forgot-password 10/900, do-reset-password 10/900, change-password 10/900, change-email 5/900, verify-email 20/3600, auth-refresh 30/60, oauth-token 60/60, contact 5/900 | as listed | before the handler | 1 |
| `login:email:` | 10 / 900 | before the password check | 1 |
| `register:email:` | 5 / 3600 | before GoTrue | 1 |
| `forgot:email:` | 3 / 900 | before the mail | 1 |
| `contact:email:` | 3 / 900 | after validation | 1 |
| `2fa:factor:`, `2fa:disable:`, `2fa:confirm:` | 5 / 900 each | before the code check | 1 |
| `invite-accept:` | 20 / 3600, cost 2 | after the token lookup, before GoTrue | 2; the route refunds two non-guess verdicts itself |
| `oauth-register:` (IP), `oauth-register-global` | 10 / 3600, 100 / 3600 | before registration | 1 each |
| `portal-auth:` (AR portal password) | 5 / 900 | before the password check | 1 |
| `afs-portal-magic-link:` (new key, item 4) | 5 / 60 | before the lookup | 1 |
| `paystack-verify:`, `paystack-create:`, `paystack-create-link:` | 30 / 900, 60 / 900, 20 / 900 | before any payment table | 1 each |
| `portal-dispute:`, `portal-chat:` (IP), `waitlist:`, `track:` | 10 / 60, 20 / 900, 10 / 600, 120 / 60 | first thing | 1 |
| `share:ip:`, `share:token:` | 60 / 300, 120 / 3600 | before the link lookup | 1 each; a limiter error refuses |
| `admin:` (IP), `impersonate:` | 120 / 60, 5 / 60 | first thing | 1 |
| `mcp-ip:`, `mcp:` (company) | 300 / 60, 120 / 60 | before the tool runs | 1 |
| `reports:` (`withAuth` and bearer, `/api/accounting/reports-*`) | 60 / 60 | in the wrapper | 1 |
| `report:<name>:co:` via `checkReportRateLimit`, 16 call sites | 25 / 900 | first thing | 1 |
| `ai-categorize:ip:` / `:company:`, `ai-commentary:ip:` / `:company:` | 30 / 900, 60 / 900 | first thing | 1 each |
| `ai:<name>:ip:`, `ai:<name>:co:` (the 15-minute AI buckets) | per caller, default 20 and 40 / 900 | first thing | 1 each, kept |
| `send:<name>:ip:`, `send:<name>:co:` (the 15-minute send buckets) | per caller, default 30 and 60 / 900 | first thing | 1, and the recipient count, kept |

Usage quotas with a window of an hour or more.

| Key | Max / window | Where charged | A failed request has used | Outcome |
|---|---|---|---|---|
| `ai:<name>:co:<id>:day`, 12 routes: nl-query, ai-forecast, ai-narrative, afs-ai-narrative (100), smart-categorize (200), vlm-extract, verify-payslip, document-validation, multi-doc-match, ai-invoice-pipeline, onboarding-extract, onboarding-extract-id | 300 / day unless noted | first thing, before validation | 5xx or throw: 0. Below 500 without work: 1 | changed (5xx rule) |
| the same, `nl-query` | 300 / day | first thing | no provider answer: 0 | changed (explicit) |
| `send:<name>:co:<id>:day`, 6 routes: invoice-email, customer-statements, dunning, afs-signing (500 each), company-invitations (100), statement-bulk-email (10 000) | as listed, cost = recipients | first thing | 5xx or throw: 0. Below 500 without a send: the recipient count | changed (5xx rule) |
| the same, `statement-bulk-email` | 10 000 / day | after the ownership guard | refused by the guard: 0. Sends that failed: 0 | changed (explicit) |
| `portal-chat:co:<id>:day` | 500 / day | after the IP bucket | 1 | left: not a `withAuth` caller |
| `onboarding-docs:` | 15 / 3600 | first thing | 1 | left |
| `invitations:company:` | 20 / 3600 | before the invite | 1 | left |
| `company-docs:` | 30 / 3600 | on upload | 1 | left |
| `company-directors:` | 20 / 3600 | on write | 1 | left |
| `bank-bulk-preview:`, `bank-bulk-commit:` | 60 / 3600 each | after validation | 1 | left |
| `extension-ingest:` | 60 / 3600 | after the token check | 1 | left: not a `withAuth` caller |
| `mcp-bank-import:`, `mcp-bank-undo:` | 60 / 3600 each | in the tool | 1 | left: bearer, not `withAuth` |

### 4. Two routes shared `portal-auth:`

`pages/api/portal/auth.ts` is the AR portal's password login (5 per 15 minutes).
`pages/api/accounting/portal/auth.ts` sends the AFS portal's magic link (5 per 60 seconds). Both
used `portal-auth:${ip}`. One key is one row with one window, so the 60-second caller kept
resetting the row and the password login allowed about 60 guesses per 15 minutes.

They guard different secrets, so they get different keys. The magic-link route now uses
`afs-portal-magic-link:`. The password login keeps `portal-auth:` and its live counters.

`tests/unit/security/rateLimitKeyCensus.test.ts` reads every tracked file under `pages` and
`src`, finds every limiter call, and fails when two call sites use the same static key prefix
with different options. A call it cannot read must be pinned by line with a reason; 7 are. It
found no other collision. It compares exact prefixes only: it would not see two different
prefixes that can produce the same key.

### 5 to 8

- `invite-accept`: the `als.exit` wrappers are removed.
- `tests/unit/lib/rateLimit.test.ts`: the boundary test now asserts calls 1 to 5 admitted and
  call 6 refused. The stale test title is corrected.
- The pool-exhaustion test no longer has a stopwatch bound. Both calls wait at the same time and
  the test's own timeout is the bound.
- Docs: `shareResolver.ts:94` catches a limiter error and refuses. The `withRateLimit` signature
  in `rateLimit.claude.md` now shows `scope`.

### Do unit tests reach the limiter pool?

Measured, by tracing every pool creation across the whole unit suite: two files create it,
`tests/unit/lib/rateLimit.test.ts` and `rateLimitSend.test.ts`. Both are meant to be
database-backed and skip when no database is reachable. `twoFactorLogoutCsrf.test.ts` does not
reach it. No test that mocks `@/lib/neon` opens a limiter connection.

One thing to know: `vitest.config.ts` reads `DATABASE_URL` from `.env.local` through `loadEnv`.
`env -u DATABASE_URL` does not hide it. In a worktree that has `.env.local`, those two files run
against `isaflow_dev` and write and delete their own test keys there. That was already so before
this branch, through `sql`. Nothing was changed.

The limiter pool is not ended by tests. No run hung, and 2 seconds after an integration run the
fixture showed no connection left from it.

### Tests and mutants in this round

- Integration, real PostgreSQL: `r175-refusal-cache` (7), `r175-usage-quota-refund` (3), the
  K-103 file (now 9) and the R-175 file (11). Red on c5b0ba6d0: 10 of 27 (`red.r1.int.log`; the
  quota file was written later and is not in that log). Green: 30 of 30.
- Unit: `rateLimitQuota` (10), `nlQueryQuotaRefund` (10), `rateLimitKeyCensus` (4), and new cases
  in `rateLimitEveryCallCounted`, `withAuth-commit-order` and `statementBulkEmailRateLimit`. Red
  on c5b0ba6d0's sources: 24 of 53 (`red.r1.unit.log`). Green: 53 of 53.
- Whole unit suite: 1120 files, 14915 pass, 6 skipped.
- The 23 other integration files that mention the limiter: the same 15 tests fail as with
  `origin/master`'s limiter (no GoTrue on the harness, a database-name guard, a function owner).
- Mutants on the final code: 55, all red, baseline green before and after (`mutations.log`,
  round 3). Three quota mutants at first survived the new quota integration file; it was
  strengthened and they are red there too.

Not verified in this round:

- The k-041 and k-042 invite suites. They were re-run as asked and fail on this harness before
  and after, for want of GoTrue. So the removal of the `als.exit` wrappers is covered by reading
  the code and by the K-103 tests, not by a route test.
- `withAuth` giving units back, end to end against PostgreSQL through a real HTTP request. The
  wiring is unit-tested with a mocked client; the refund itself is tested against PostgreSQL.
- Start-up-parameter timeouts behind a pooler.
- Load. Nothing here was load-tested.

## Review round 2

Both blind reviewers said SHIP on a06b5cc8b. The cache and the timeouts held. Findings and fixes:

### 1. The quota refund is net of work done, on every exit

Round 1 gave back every noted unit on a 5xx and nothing otherwise. Both halves were wrong:

- A 5xx after work was done got it all back. Bulk email throwing on recipient 60 of 100 sent 59
  emails and got 100 units back.
- A route that answered below 500 without doing the work kept the charge. `ai-narrative` and
  `ai-forecast` answer 200 with a fallback when the provider is down; `invoice-email` answers 200
  `sent: false` when SMTP is down.

The rule now: the request's record holds, per charge, the units **charged** and the units
**used**. When the request ends, on any status, a throw or a failed COMMIT, it gets back
`charged - used`, never less than zero and never more than it charged.

- `src/lib/quotaUse.ts`: `noteQuotaCharge` (called by the limiter) and `markQuotaUsed(kind)`
  (called where the work happens). It depends only on `als`, so the shared clients can import it.
- `src/lib/rateLimitQuota.ts`: `settleQuotaCharges`, the one refund path. `withAuth` calls it in
  its `finally`, whatever the status.
- The per-route refund calls from round 1 (`nl-query`, `statement-bulk-email`) are removed, so
  nothing is refunded twice.
- `markQuotaUsed` ignores a zero, negative or NaN count. The first version of the test for this
  found that a negative count produced a refund larger than the charge.

Where use is recorded. I read every quota caller and followed its imports to the call that does
the work.

Email has one chokepoint. All 6 send routes reach `sendEmail` in
`src/modules/accounting/services/core/emailService.ts`, inside the request. It marks one unit
used when `transporter.sendMail` resolves.

AI has no single chokepoint. There are three shared clients and three routes that call the
provider themselves. Five AI routes cannot be covered at all.

| Caller (daily key) | What does the bounded work | Use recorded in | Unused unit |
|---|---|---|---|
| `invoice-email` | `sendInvoiceEmail` -> `sendEmail` | `emailService.sendEmail` | comes back |
| `statement-bulk-email` | `sendStatementEmail` -> `sendEmail`, once per recipient | same | comes back, per email not accepted |
| `customer-statements` | `sendStatementEmail` -> `sendEmail` | same | comes back (see note 1) |
| `dunning` | `sendDunning` -> `sendEmail` | same | comes back |
| `company-invitations` | `sendInviteEmail` -> `sendEmail` | same | comes back |
| `afs-signing` | `notifySigningRequested` -> `sendEmail` | same | comes back |
| `vlm-extract` | `ocrService` -> `vlmService` -> `callVlmChat` | `vlmCore.callVlmChat`, on an OK response | comes back |
| `onboarding-extract` | `callVlmChat` | same | comes back |
| `onboarding-extract-id` | `callVlmChat` | same | comes back |
| `afs-ai-narrative` | `generateNoteNarrative` (Anthropic SDK) | `noteAiService`, after the provider answers | comes back |
| `nl-query` | `fetch` to the provider, in the route | the route, after an OK response | comes back |
| `ai-narrative` | `fetch` to the provider, in the route | the route, after an OK response | comes back |
| `ai-forecast` | `fetch` to the provider, in the route | the route, after an OK response | comes back |
| `ai-invoice-pipeline` | no AI provider is called | nowhere | **kept** |
| `multi-doc-match` | no AI provider is called | nowhere | **kept** |
| `verify-payslip` | no AI provider is called | nowhere | **kept** |
| `document-validation` | no AI provider is called | nowhere | **kept** |
| `smart-categorize` | the LLM pass runs after COMMIT, outside the request | nowhere reachable | **kept** |

Fail safe: only a caller that passes `refundUnused: true` notes a charge. The five **kept**
routes do not pass it, so they keep their charge on every exit, as before this branch.

Note 1: `customer-statements` charges 1 unit per request and sends up to 100 emails. That is not
new and not changed here. With one or more emails accepted the unit is used.

Use is "the provider answered with an OK status" or "the mail server accepted the message". A
provider that answers and then the route fails still costs the unit. (Review round 3: a provider
timeout now counts as use too.)

`tests/unit/security/quotaCallerCensus.test.ts` lists every quota caller as refundable or as
keeping its charge. It fails when a caller is in neither list, when a refundable caller cannot
reach, through its imports, a file that calls `markQuotaUsed` for its kind, when a kept caller
passes `refundUnused`, or when use is recorded in a file not listed. It is reachability read
from source: it proves a path exists, not that every success path takes it.

### 2. Bulk send routes

`statement-bulk-email`, after the charge moved behind the ownership guard:

- An abuse limit per user (`statement-bulk-email:attempts:<user>`, 30 per 15 minutes) now runs
  first. It counts every attempt and is never given back.
- Ids are checked with `isValidUUID` before any query. A non-UUID id answers 400, not 500.
- The refusal log carries a count and at most three ids.

`customer-statements-send` had two of the three shapes: the `::UUID[]` cast and the full-array
log. Both are fixed the same way. Its limiter already ran before the ownership query.
`ar/dunning/send`, `invoice-email`, `company-invitations` and `afs/send-for-signing` take single
ids, validated or looked up by company, and log no id arrays. Nothing to change there.

### 3. `remaining_ms` overflow

The time left in the window was cast to `int`. A window above about 24.8 days overflowed and
every call on such a key threw. It is `float8` now. A 30-day window is tested.

### 4. Stale comments

The header and doc comment said every call does the UPSERT and that there is no in-process copy.
Corrected. The core moved to `src/lib/rateLimitCore.ts`, because `rateLimit.ts` was at 296
lines; `rateLimit.ts` re-exports it and callers import from `@/lib/rateLimit` as before.

### 5. Key census

- Exceptions are pinned by file and by the text of the key, not by line number.
- Any import of a limiter function under another name, a namespace import, a dynamic import or
  an assignment of one to a variable fails the test.
- Every call is resolved to the key pattern it produces, including the three keys each of
  `checkAiRateLimit` and `checkSendRateLimit` builds and the one `checkReportRateLimit` and
  `withRateLimit` build. A hand-written `report:reports-pdf:co:${id}` at another limit fails.
- `refundRateLimit` calls are included: each must be on a key some call site charges.
- Scope is every tracked `.ts`, `.tsx`, `.js` and `.mjs` file outside `tests/`. The app's runtime
  code is all in `pages/` and `src/`; scanning the rest as well means a script that starts
  calling the limiter is seen. One match outside them is prose in a string and is pinned.

### 6. Production target

Recorded under review round 1, item 2, with the post-deploy check.

### 7. Unit tests wrote to the dev database

`tests/unit/lib/rateLimit.test.ts` and `rateLimitSend.test.ts` ran their database cases against
`isaflow_dev`, because `vitest.config.ts` loads `DATABASE_URL` from `.env.local`. Those cases
moved to `tests/integration/rate-limit-counter-db.int.test.ts` and
`rate-limit-send-db.int.test.ts`, which need the disposable fixture and use random keys. The
unit file keeps the pure cases. Traced over the whole unit suite: the limiter pool is created 0
times (2 before).

`vitest.config.ts` was not changed. About 60 other unit files use the same
`isDbReachable()` pattern and run against whatever `.env.local` names: the `*Db.test.ts` and
`*.integration.test.ts` files under `tests/unit/mcp`, `tests/unit/services` and others, and
`tests/unit/services/admin/rateLimitCleanupService.test.ts`. They were not touched.

### Tests and mutants in this round

- Integration, real PostgreSQL: 6 files, 44 tests, all pass. New: the usage-quota file rewritten
  for the new rule (5), the 30-day case, the two moved files (11). Red on a06b5cc8b: 6 of 13
  (`red.r2.int.log`).
- Unit: 12 limiter files, 124 tests, all pass. New: `quotaUseChokepoints` (9), `aiRoutesQuotaUse`
  (10), `quotaCallerCensus` (21), `customerStatementsSendGuards` (5); rewritten:
  `rateLimitQuota`, `rateLimitKeyCensus`, and the quota cases in `withAuth-commit-order`,
  `nlQueryQuotaRefund` and `statementBulkEmailRateLimit`. Red on a06b5cc8b's sources: 68 of 96
  (`red.r2.unit.log`; many fail at import, because the functions they call did not exist).
- Whole unit suite: 1123 files, 14963 pass, 6 skipped.
- The 23 other integration files that mention the limiter: the same 15 tests fail as with
  `origin/master`'s limiter.
- Mutants on the final code: 78, all red, baseline green before and after (`mutations.log`,
  round 4).

Not verified in this round:

- `invoice-email`, `dunning`, `company-invitations`, `afs-signing`, `vlm-extract`, the two
  onboarding routes and `afs-ai-narrative` have no route-level test of their own for the quota.
  They are covered by the test of the shared client they call and by the reachability census.
- `withAuth` settling end to end over a real HTTP request. The wiring is unit-tested; the settle
  is tested against PostgreSQL.
- The k-041 and k-042 invite suites (no GoTrue on the harness).
- Load.

For a decision:

- The five kept AI routes. Four call no AI provider, so their "AI" bucket is really a request
  limit. `smart-categorize` runs its LLM after COMMIT. They keep their charge on every exit.
- `customer-statements` charges 1 unit for up to 100 emails (note 1).
- The hourly per-company quotas and `portal-chat` daily still keep a failed request's charge.
- About 60 unit files still run against the database `.env.local` names.

## Review round 3

Both blind reviewers said SHIP on d89110477 with no HIGH or MEDIUM. Every LOW is fixed.

### 1. A refund could land in the next window

Request A charges 100 at the end of a window and its sends fail. The window rolls. Request B
charges and sends 100. A settles, and the new window read 0 with 100 sent.

`chargeRateLimit` now returns the window it charged (`window_start`, as text, so the
microseconds survive). The noted charge carries it, and `refundRateLimit(key, units, windowStart)`
is a no-op when the row's window is a different one. `invite-accept` still refunds without a
window: its refund follows its charge by seconds inside a one-hour window. Left as it was.

### 2. A refused charge no longer consumes units

Before: at 9,950 of 10,000, a 100-unit request pushed the count to 10,050 and was refused. A
1-unit request was then refused for the rest of the day with 50 real units unspent.

Now one atomic statement charges **only when the call fits** and returns whether it did
(`INSERT ... ON CONFLICT DO UPDATE ... WHERE expired OR count + cost <= max`, read back in the
same statement). A refused call changes nothing. The count never passes `max`. A cost above
`max` is refused without a database call, because it can never fit.

The refuse-only cache holds the count at the last refusal and turns a call away only while
`remembered + cost > max`. So after a refused 100-unit call, a 1-unit call that fits is still
sent to the database.

The strongest argument against: a refused attempt now leaves no trace. The counter used to climb
past `max` under attack, and that number showed how hard a key was being hit. It is gone; only
the 429 logs show it. Also, small requests can now starve a large one for a whole window: at
9,950, fifty 1-unit calls fit and the 100-unit batch never will. Before, the batch's refusal
blocked everyone equally.

Abuse limits behave as before for cost 1: the same calls are admitted and refused, and the
window ends when it did. Tests that assumed a refused call increments the counter: 16
integration cases and the mocked unit cases, all in this branch's own files or in the two files
moved from the unit suite. They are corrected. I found no caller in `src` or `pages` that reads
the count.

### 3. Work after the request cannot be refunded

`runAfterCommit` now forfeits the request's refund (`forfeitQuotaRefund`): every noted charge is
kept. Use recorded after the request has ended would never reach the settle, so the route would
otherwise get every unit back.

The caller census also refuses a refundable route that reaches `als.exit(`, a detached
`.exit(() =>`, `setImmediate` or `process.nextTick`, in any file it imports, except
`src/lib/afterCommit.ts` itself. Fixture cases both ways.

What it cannot see: a promise that is started and not awaited, a bare `setTimeout`, and an
import it cannot resolve.

### 4. A provider call that times out counts as use

`markQuotaUsedUnlessNoWork(kind, err)` runs in the catch of every provider call. The unit is
used unless the error proves no work was done: connection refused, name not resolved, DNS
failure, connect timeout, or an error carrying a provider status (the SDK's 4xx or 5xx). A
timeout, an abort, a reset after the request was sent, or an unknown error counts as use.
A provider answer with an error status through `fetch` (`!response.ok`) is still no use.

Email is not changed: a failed `sendMail` is still no use, though a timeout after the message
body was sent may have delivered it.

### 5. One `AUTO_RATE_LIMIT` table

`src/lib/auth/autoRateLimit.ts` holds the table and `checkAutoRateLimit`. `withAuth` and the
bearer pipeline both call it. The two pins in the key census are gone; the census reads the
table.

### 6. Key census blind spots

- Different patterns are compared when one, read as a glob, can produce the other's keys:
  `foo:*` and `foo:bar:*`. One real pair is reasoned and pinned (`portal-chat:*`, keyed by an
  IP, against `portal-chat:co:*:day`). The wrappers' own 15-minute and daily company keys are
  exempt by rule: the company id is a UUID and holds no colon.
- Outside its import, a limiter function may appear only as a direct call. Assigned, put in an
  object, passed as an argument or bound, it fails the test.

### 7. Send routes: a malformed request no longer charges the shared bucket

| Route | Before | Now |
|---|---|---|
| `customer-statements-send` | company bucket charged first | per-user limit, validate, then company bucket |
| `invoice-email` | company bucket charged first | the same |
| `ar/dunning/send` | company bucket charged first | the same |
| `afs/[documentId]/send-for-signing` | company bucket charged first | the same |
| `statement-bulk-email` | fixed in round 2 | unchanged |
| `company-invitations` | already validates before charging; owner or admin only | unchanged, no per-user limit added |

The per-user limit is `<name>:attempts:<user>`, 30 per 15 minutes, counted on every attempt and
never given back.

### 8. Tidy

The spliced sentence in `rateLimit.claude.md` is repaired. `QuotaKind` is defined once, in
`als.ts`. The `checkRateLimit` comment sits on its function. The doc now says what the daily
bucket holds after the settle.

### 9. Route-level tests

`tests/unit/api/sendRoutesQuotaUse.test.ts` drives `send-for-signing`, `dunning` and
`company-invitations` through their real services down to the real `sendEmail`. Only the mail
transport, the database and outside services are stubbed. Each keeps its unit when the mail
server accepts, and leaves it unused when the server is down or not configured.

### Tests and mutants in this round

- Integration, real PostgreSQL: 6 files, 51 tests, all pass. Red on d89110477: 23 of 51
  (`red.r3.int.log`).
- Limiter unit files: 16 files, 196 tests, all pass. Red on d89110477's sources: 49 of 186
  (`red.r3.unit.log`).
- Whole unit suite: 1125 files, 15011 pass, 6 skipped.
- The 23 other integration files that mention the limiter: the same 15 tests fail as with
  `origin/master`'s limiter.
- Mutants on the final code: 113, all red, baseline green before and after (`mutations.log`,
  round 5).

Not verified in this round:

- The new statement under real concurrency from several processes. It is tested with concurrent
  calls from one process and two module instances.
- Counter rows written by the old code with a count above `max`. They read as full until their
  window ends, which is the old behaviour.
- `withAuth` settling end to end over a real HTTP request; the k-041 and k-042 invite suites
  (no GoTrue on the harness); load.

For a decision:

- Item 2's trade: small requests can starve a large one, and an attack no longer shows in the
  counter.
- `invite-accept`'s refund carries no window.
- A failed `sendMail` after a timeout is treated as not sent.
- `company-invitations` has no per-user limit.
- Carried over: the five kept AI routes, `customer-statements` charging 1 unit for up to 100
  emails, the hourly quotas and `portal-chat` daily, and about 60 unit files that run against
  the database `.env.local` names.

## Review round 4

Both blind reviewers said SHIP on 84bcca1b8 with no HIGH or MEDIUM. Every LOW is fixed.

1. **Company bucket charged after the ownership check.** One write-access user naming ids that
   are not the company's could take half the company's 15-minute send allowance with nothing
   sent. The shared bucket is now charged only after the record is found to be the company's:
   - `customer-statements-send`: after the ownership guard.
   - `invoice-email`: a new ownership query (and a UUID check before it) answers 404 first.
   - `ar/dunning/send`: the invoice and the template are looked up first, 404 if either is not
     the company's. This costs two extra reads per send; `sendDunning` reads them again.
   - `afs/send-for-signing`: after the document, signer and rendered-HTML checks, just before
     the Signum call.
2. **`invite-accept` refunds into its own window.** It uses `chargeRateLimit` and passes the
   window to the refund. The key census now fails on any refund that names no window.
3. **Attempt key scoped to the company:** `<route>:attempts:<company>:<user>`. A bureau user has
   one allowance per client. The old keys simply expire.
4. **Both usage buckets or neither.** In the AI and send wrappers, when the daily bucket
   refuses, what the call took from the 15-minute company bucket is given back, into its window.
   The per-IP bucket is an abuse limit and stays charged.
5. **The cache remembers only a full key** (`count >= max`). A refused 100-unit call at 9,950 of
   10,000 is not remembered, so a 1-unit call that fits is never refused from memory. The cost:
   repeated oversized calls on a nearly full key each reach the database. They write nothing.
6. **`max` is validated.** A fractional `max` is floored: 2.5 admits 2, the safe reading. NaN,
   Infinity, a negative or a value above 1,000,000,000 throws a `RangeError` that names the
   problem. Throwing is right for those: there is no safe number to substitute, and it is a
   programming error, not a request error. The bound is below int4 so `count + cost` cannot
   overflow.
7. **Header corrected:** an outage that shows as hangs still uses up the daily allowance,
   because a timeout counts as use.
8. **Old rows above `max`** are tested: refused until the window ends, then the count restarts.

Tests and mutants: integration 6 files, 57 pass (red 3 of 57 on 84bcca1b8, `red.r4.int.log`);
limiter unit files 17 files, 220 pass (red 25 of 213, `red.r4.unit.log`); whole unit suite 1125
files, 15033 pass, 6 skipped; mutants 131 of 131 red with a green baseline before and after
(`mutations.log`, round 6).

Not verified in this round:

- `invite-accept`'s refund through the route. The k-041 suite that drives it needs GoTrue, which
  this harness lacks. It is covered by the limiter-level rollover test and by the census rule.
- Item 5's stale-snapshot case as the reviewer described it (a concurrent writer between the
  statement's snapshot and its refusal). The rule that replaces it is tested; the race is not
  reproduced.
- Load, and the statement under concurrency from separate processes.

## Review round 5

Both blind reviewers said SHIP on 85b2cd6fd with no HIGH or MEDIUM. Every LOW is fixed.

1. **Stale snapshot in the refusal cache.** The comment said the refused row could only be stale
   low. That was wrong: a refund that commits while the upsert waits for the row lock is not in
   the statement's snapshot, so the row read "full" when it was not, and a fitting cost-1 call
   was refused from memory. Reproduced deterministically against PostgreSQL (a held refund, a
   cost-5 charge waiting on it, commit; then a cost-1 call). Now, when the snapshot says full,
   the latest committed count is re-read in its own statement and only that is remembered. Cost:
   one extra read per refusal that would be cached.
2. **A company known to be full costs no writes.** The AI and send wrappers consult the daily
   key's refusal cache first, before even the per-IP bucket. Tested by counting statements on
   the limiter pool: 25 requests on a full company, zero statements.
3. **Cross-company bucket.** Next to `<route>:attempts:<company>:<user>` (30 per 15 minutes),
   each send route also charges `<route>:user-attempts:<user>` (90 per 15 minutes, 3x). The
   per-company key stops a bureau user starving one client; the other bounds the total. Both
   are abuse limits, never given back. A distinct prefix, so the key census does not see
   overlapping patterns.
4. **`invoice-email` excludes deleted invoices** in its ownership guard. `sendInvoiceEmail`
   itself does not: it reads the invoice without a `deleted_at` filter and would email a
   deleted one. So this is a behaviour change: a deleted invoice can no longer be emailed
   through this route (404). `sendInvoiceEmail` was not changed.
5. **`send-for-signing` charges early.** Right after the document read and its two status
   checks, before the contact queries, the company query and the file read. A foreign document
   still leaves the bucket untouched. A request refused at the contact check now spends one
   unit; that is the trade asked for.

Tests and mutants: integration 6 files, 59 pass (red 3 of 23 on 85b2cd6fd, `red.r5.int.log`,
including the race); round-5 unit files red 17 of 70 (`red.r5.unit.log`); whole unit suite 1125
files, 15038 pass; mutants 141, 140 red at first, the survivor (`isKnownFull` ignoring `max`)
killed by a new test (`mutations.log`, round 7).

Process note: during this round a mutation dry run (`git checkout -- src pages` after each
mutant) was started before the round's changes were committed and reverted them. They were
restored from a copy taken minutes earlier, the full suites were re-run green, and only then
committed and mutated.

## Review round 6

Both reviewers said SHIP on 20ceca5d3 and confirmed the round-5 restore was complete.

1. **`send-for-signing` charges after the signer check.** Round 5 put the company charge before
   it, so foreign or inactive signer ids against a real document spent the shared bucket. The
   charge now sits after the document checks and the signer ownership and role checks, before
   the company query and the file read. Tested both ways: foreign signers leave the bucket
   untouched; a valid request is charged before the file read.
2. **Comments reflowed** on the five send routes. `statement-bulk-email`'s comment now also
   names the two abuse buckets.

Mutants: 142, all red, baseline green before and after (`mutations.log`, round 8). A first full
run was void (two runners overlapped after a batch overran its time limit) and was re-run
sequentially.

### After the merge with master

`send-for-signing` now checks that the rendered HTML file exists (`fs.access`, no read)
before the company charge, and reads it after. A document with no rendered HTML answered 400
after the charge and the unit was not given back. Tested: a missing file leaves the bucket
untouched. Mutant HT1 red.

The comment in `pages/api/mcp/index.ts` said `checkRateLimit` counts every call; since review
round 3 a refused call is not counted. Corrected.

### MCP batch charge (pre-existing, last review)

`pages/api/mcp/index.ts` charged a JSON-RPC batch one unit at a time and stopped at the first
refusal. A 20-call batch arriving with 10 units left spent those 10, ran nothing, and was
refused; a retrying agent drained the end of every window. It is now one atomic charge of the
batch size: the whole batch fits and is charged, or nothing is charged and it is refused. An
empty batch is not charged, as before. The per-IP check is a pre-auth abuse limit charged once
per HTTP request, so it does not have this shape and is unchanged. Calls a role-lock skip
leaves unrun stay charged, as before. Mutants MB1 to MB4 red.

The new cases are in `tests/unit/mcp/transportBatchCharge.test.ts`. `tests/unit/mcp/transport.test.ts`,
already 347 lines on master (over the 300-line cap), is kept at 347.

An earlier report here said the role-lock test asserts the full batch is charged. It did not: a
comment edit had swallowed the assertion. It is restored, and mutants that charge 1 or charge
per call now turn that test red.

The skipped-call text (`src/lib/mcp/batchSkip.ts`) said "Nothing was written or charged". On
master "charged" meant the Flows wallet, which is true, but the call is covered by the batch's
rate-limit charge and a caller reading "charged" would think otherwise. It now reads "Nothing was
written and no Flows were debited for this call; it still counted towards the batch's rate
limit". The two tests that match it are updated: the transport unit test and master's
`w2-28-system-role-round12` integration test.

## /review round (PR #604)

A fresh blind reviewer said SHIP with two MEDIUMs and two LOWs.

1. **`send-for-signing` marks its work.** Its bounded work is the Signum document, not only the
   signer emails. With SMTP down it created the document, sent nothing, answered 200 and got
   the unit back. The route now marks the unit used once `sendForSigning` returns, and on a
   failure calls `markQuotaUsedUnlessNoWork`: a timeout counts as use, a refused connection does
   not. A Signum refusal now carries its HTTP `status`, so it counts as no work. The census lists
   the route itself as where this route's use is recorded.
2. **SMTP failures are classified, from nodemailer 8.0.4's source** (`lib/smtp-connection`,
   `lib/errors.js`). Not use: a 4xx/5xx reply (`responseCode`), EDNS, ETLS, EREQUIRETLS, EAUTH,
   ENOAUTH, EOAUTH2, EENVELOPE, EMESSAGE, ECONFIG, and ESOCKET from `connect` or `getaddrinfo`
   (nodemailer overwrites Node's code with ESOCKET but keeps `syscall`). Use: ETIMEDOUT
   (nodemailer reports the connect, the greeting and an idle socket mid-message all as
   ETIMEDOUT with command CONN, so it proves nothing), any other socket error, a dropped
   connection, and anything unknown. Tested with the real nodemailer against a small SMTP
   server in the test process (refusals at AUTH, MAIL, RCPT, DATA and end of DATA; a connection
   dropped after the message; a refused port), and the rest by error shape.
3. **After-commit work is visible.** The quota caller census fails when a refundable route can
   reach a file that registers `runAfterCommit` work, unless the file is listed with a reason.
   One is: `emailNotificationService.ts` registers the invoice.sent webhook only after a
   successful send, when the unit is already used. The forfeit itself is unchanged.
4. **Pool size: changed from 3 to 10, by measurement.** On the fixture (load average 3.5 to 6,
   32 cores), every call admitted:

   | Concurrent calls | Pool 3, p50 / p99 | Pool 10, p50 / p99 |
   |---|---|---|
   | 50, one key | 127 / 253 ms | 48 / 97 ms |
   | 50, many keys | 85 / 170 ms | 11 / 19 ms |
   | 200, one key | 521 / 1017 ms | 190 / 378 ms |
   | 200, many keys | 335 / 673 ms | 38 / 75 ms |
   | 1000, one key | 2.6 s / 5.0 s, 30 to 56 calls hit the connect timeout | 0.9 s / 1.9 s, none |
   | 1000, many keys | 0.6 to 1.7 s / 1.2 to 3.4 s | 187 / 370 to 421 ms |

   Cost: up to 10 limiter connections per process instead of 3, closed after 30 s idle. The
   production database's `max_connections` and the number of production processes were not
   checked (the fixture allows 100). Measured with a scratch test that is not committed.

Mutants: 23, all red, with a green baseline before and after (`green.log`).

## Rollback

Revert the branch's commits. No migration, no data change, no configuration. Counters written
while the fix was live stay valid for the old code.
