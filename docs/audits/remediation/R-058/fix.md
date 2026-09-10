# R-058 — capture posting routes double-post one captured document

**Severity** HIGH · **Branch** `fix/audit-r058-post-expense-double-post` · **Migration** none

## Trigger

`pages/api/accounting/capture/[id]/post-expense.ts` SELECTed `ce.status` with a
plain read, refused in JavaScript when it equalled `'posted'`, and then created
an expense claim (employee path) or a GL journal (anonymous path) — closing with

```
UPDATE capture_events SET status = 'posted', ... WHERE id = $1 AND company_id = $2
```

carrying **no** `status` predicate and discarding the row count. Two concurrent
requests (a UI double-click, an agent retry) both read `'extracted'`, both passed
the check, and both posted: **one captured receipt, two expense claims or two
journals**.

`capture/[id]/post.ts` — the supplier-invoice sibling, twenty lines of the same
shape — had the identical defect, and its second write is an `INSERT INTO
supplier_invoices`: **one bill accrued twice** against the payable control
account.

`withAuth` COMMITs any response below 500, so the refusal has to happen *before*
the first write, not after it. It does: the claim is taken on the SELECT itself.

## Fix

New `src/modules/accounting/services/capture/captureEventLock.ts` —
`lockCaptureEventForPosting(companyId, eventId)` reads the event joined to its
captured document under `FOR UPDATE OF ce`, behind a re-issued
`SET LOCAL lock_timeout = '5s'`, and refuses to run outside a request
transaction. `55P03` / `40P01` surface as `CaptureEventLockedError`, which both
routes answer as a 409.

Both routes replace their `SELECT ... FROM capture_events` with that call. The
existing `event.event_status === 'posted'` refusal and its 400 wording are
unchanged; nothing else in either file moved.

**Lock, not predicated claim — chosen by measurement.** A predicated
`UPDATE ... WHERE status <> 'posted' RETURNING id` would also serialise, but it
must be written *before* the posting work, which means reordering both handlers
and stamping `posted_by` / `posted_at` / `resolved_*` before the values that
populate them exist. `FOR UPDATE` gets the same outcome with a three-line diff
and is what every other write path in this repo already does
(`bankTxLock.ts`, `creditNoteLock.ts`, `wipEntryLock.ts`, `loanPostingGuards.ts`,
`assets/[assetId]/dispose.ts`, `assets/below-threshold.ts`). Measured: under
READ COMMITTED the loser blocks on the row, re-reads it at the winner's
committed version, sees `'posted'`, and returns 400 having written nothing —
`post-expense: two CONCURRENT requests post ONE journal, not two` proves it by
outcome, and goes red when `FOR UPDATE OF ce` is deleted.

`captured_documents` is joined but deliberately **not** locked: the extraction
pipeline (`captureRouterService.routeEvent`) writes that row.

## Census

Enumerated from the **tables** (every `capture_events` / `captured_documents`
writer in `pages/`, `src/`, `scripts/`), then reconciled **by outcome**: which
sites can write a ledger row, an accrual or a claim more than once for one
captured document. Directories walked: `pages/api/accounting/capture/**`,
`pages/api/accounting/*.ts`, `src/modules/accounting/services/capture/**`,
`src/modules/accounting/services/core/`.

| # | Site | Writes on the second run | Disposition |
|---|---|---|---|
| 1 | `capture/[id]/post-expense.ts` | expense claim + GL journal | **FIXED** — locked |
| 2 | `capture/[id]/post.ts` | `supplier_invoices` INSERT | **FIXED** — locked |
| 3 | `capture/[id]/discard.ts` | `status='discarded'` only | **Round 1 disposition was WRONG** — see Round 2. It writes the column the post guard reads. |
| 4 | `capture/upload.ts` | INSERT of a NEW event | Out of class — creates, never posts. |
| 5 | `capture/inbound-email.ts` → `inboundEmailService` | INSERT of a NEW event | Out of class. |
| 6 | `capture/whatsapp-inbox.ts` → `whatsAppInboundService` | INSERT of a NEW event | Out of class. |
| 7 | `capture/mirror/**` → `imapMirrorService` | INSERT of a NEW event | Out of class. |
| 8 | `captureRouterService.routeEvent` | `status='extracting'/'extracted'/'failed'` | Out of class — extraction only, posts nothing to the ledger. Note: it can overwrite a `'posted'` status back to `'extracting'` if an extraction is re-kicked after a post; that is a separate, non-financial defect not seen in the wild. |
| 9 | `captureQueryService`, `costCentreUsageGuard` | reads only | Out of class. |
| 10 | `ai-invoice-pipeline.ts` | `supplier_invoices` INSERT | **REGISTERED R-070** — see below |
| 11 | `receipt-to-journal.ts` | GL journal | **REGISTERED R-070** — see below |

`SET status = 'posted'` on `capture_events` appears at exactly three lines in the
repo (post.ts:1, post-expense.ts:2), all of them now behind the lock.

### R-070 (reserved, not fixed here)

`pages/api/accounting/ai-invoice-pipeline.ts:59` and
`pages/api/accounting/receipt-to-journal.ts:43` both `SELECT extracted_data,
status FROM captured_documents` and then **never read `status` again**. They are
keyed on `documentId`, not on a capture event, and have no "already posted"
refusal at all — so they re-post the same captured document on every call, with
no concurrency required. `ai-invoice-pipeline` is partly shielded by
`findDuplicate`; `receipt-to-journal` has nothing.

Registered rather than fixed because the correction is a **new refusal on a
different table**, not the missing lock this item is about: it needs a decision
on whether `captured_documents.status = 'matched'` (or the unused `posted_at`
column) is the right marker, and on whether an operator may legitimately re-run
either route. Neither route has an in-app caller — the full-repo grep for the two
paths finds only docs and build logs — but both are live authenticated endpoints,
so this is a scope judgement, **not** an unreachability argument.

## The guard fails in both directions

- `post-expense: a legitimate first post writes exactly one journal` — 200, one
  journal, event `'posted'`.
- `post-expense: the one journal balances at the receipt total` — 115.00 dr /
  115.00 cr.
- `post: a legitimate first post creates exactly one supplier invoice` — 200.
- `post-expense: an event whose post failed hard is still retryable` — a post
  that 500s (FK violation on a non-existent employee) rolls back with `withAuth`,
  leaves the event `'extracted'` with no claim and no journal, and the retry
  succeeds. The event is never stranded `'posted'` with nothing behind it.

## Tests

`tests/integration/r058-capture-post-double-post.int.test.ts` — 9 tests in round 1 (16 after round 2), all
asserting on OUTCOME (journals / claims / invoices actually written), never on
the wording of a refusal.

| Mutation (file copies, restored) | Result |
|---|---|
| delete `FOR UPDATE OF ce` from `captureEventLock.ts` | 3 failed (the three concurrency tests) |
| `if (event.event_status === 'posted')` → `if (false)` in both routes | 5 failed (both sequential tests + all three concurrency tests) |
| restored | 9 passed |

Two existing unit suites (`postExpenseZeroVatLine.test.ts`,
`capturePostFingerprint.test.ts`) drive the handlers directly with no `withAuth`,
so they now mock `@/lib/als` to stand in a client for the `SET LOCAL`. Their SQL
stubbing is otherwise untouched and all 13 still pass.

## Historical impact — for Hein, production NOT measured

Read-only. Run against production `isaflow` yourself; agents are barred from it.

```sql
-- Capture events posted more than once: one captured document, several
-- ledger artefacts. Any row returned is a double post.
SELECT ce.company_id,
       ce.id                       AS capture_event_id,
       ce.captured_document_id,
       ce.posted_at,
       (SELECT count(*) FROM gl_journal_entries je
         WHERE je.company_id = ce.company_id
           AND je.source_document_id = ce.captured_document_id)      AS journals,
       (SELECT count(*) FROM supplier_invoices si
         WHERE si.company_id = ce.company_id
           AND si.source_document_id = ce.captured_document_id)      AS supplier_invoices,
       (SELECT count(DISTINCT ecl.claim_id) FROM expense_claim_lines ecl
         WHERE ecl.company_id = ce.company_id
           AND ecl.source_document_id = ce.captured_document_id)     AS expense_claims
FROM capture_events ce
WHERE ce.status = 'posted'
  AND ce.captured_document_id IS NOT NULL
  AND ( (SELECT count(*) FROM gl_journal_entries je
          WHERE je.company_id = ce.company_id
            AND je.source_document_id = ce.captured_document_id) > 1
     OR (SELECT count(*) FROM supplier_invoices si
          WHERE si.company_id = ce.company_id
            AND si.source_document_id = ce.captured_document_id) > 1
     OR (SELECT count(DISTINCT ecl.claim_id) FROM expense_claim_lines ecl
          WHERE ecl.company_id = ce.company_id
            AND ecl.source_document_id = ce.captured_document_id) > 1 )
ORDER BY ce.posted_at DESC;

-- Same question asked from the DOCUMENT side, which also catches the R-070
-- routes (they never touch capture_events at all).
SELECT je.company_id, je.source_document_id, count(*) AS journals,
       min(je.entry_date) AS first_entry, max(je.entry_date) AS last_entry
FROM gl_journal_entries je
WHERE je.source_document_id IS NOT NULL
  AND je.source = 'auto_expense_receipt'
GROUP BY je.company_id, je.source_document_id
HAVING count(*) > 1
ORDER BY count(*) DESC;
```

## Round 2 — the guard read a column three handlers write

Blind review of `9488b2cf0`: 0 HIGH · 2 MEDIUM · 2 LOW. The lock was confirmed
correct; the finding was that the guard it protects depends on a status other
code can reset, and names one value instead of asking whether the event is still
open for posting.

### Census, re-derived from the COLUMN

Every writer of `capture_events.status`, found by walking every file that names
the table (`grep -rln capture_events pages src scripts tests`, 23 files — the
four migrations, 11 source files, 8 tests), not by grepping for `'posted'`. The
CHECK constraint (migration 409, never altered — no later migration names it)
closes the vocabulary at `received, extracting, extracted, posted, discarded,
failed`.

| Writer | Transition | Predicated? | Disposition |
|---|---|---|---|
| `capture/upload.ts:156` | INSERT → `received` | n/a | New row; cannot touch an existing event. |
| `inboundEmailService.ts:173` | INSERT | n/a | Same. |
| `whatsAppInboundService.ts:198,255` | INSERT | n/a | Same. |
| `imapMirrorService.ts:252` | INSERT | n/a | Same. |
| `captureRouterService.ts:138` | any → `extracting` | no | **R-071**, out of scope. Reviewer measured reachability NEGATIVE (all 4 callers pass an id they INSERTed in the same function; no re-extract endpoint). I did not re-measure a contradiction. It now cannot produce a double post from a discarded event (allow-list), but it could still revert a `posted` event to `extracting`, which the allow-list treats as postable — so R-071 remains a real latent guard-defeater and still needs its own predicate. |
| `captureRouterService.ts:176,184` | → `extracted` | no | Same function as above; same disposition. |
| `captureRouterService.ts:196` | → `failed` | no | Same. |
| `capture/[id]/post.ts:143` | → `failed` (duplicate) | row held under lock | Retry state — `failed` stays postable on purpose. |
| `capture/[id]/post.ts:201` | → `posted` | row held under lock | Round 1. |
| `capture/[id]/post-expense.ts:185,294` | → `posted` | row held under lock | Round 1. |
| `capture/[id]/discard.ts:42` | any → `discarded` | **no, and no lock** | **FIXED** (MEDIUM-1). |

Readers of the column: `captureQueryService.ts:117` (inbox filter),
`captureEventLock.ts` (the guard), `captureRouterService.ts:116` (unused read).

### MEDIUM-1 — discard reset the status the post guard reads — FIXED

`discard.ts` now takes the same row lock (`lockCaptureEventRow` — the event row
ONLY; the posting read's INNER JOIN to `captured_documents` would have made an
event with a NULL `captured_document_id` undiscardable) and predicates its
UPDATE `AND status <> 'posted' RETURNING id`, refusing 400 on zero rows. Two
independent refusals: mutation M2 (predicate removed) and M5 (JS check removed)
each stay green on their own; M3 (both removed, i.e. the round-1 code) goes red.

Proved by outcome, sequentially (`discard: a POSTED event cannot be discarded
back into a postable state` — discard 400, status stays `posted`, re-post 400,
claims stay 1 — the reviewer's measured `claims now 2` sequence) and concurrently
(`discard CONCURRENT with post never leaves a posted bill on a discarded event`:
one 200 + one 400, and an invoice exists iff the event reads `posted`).

### MEDIUM-2 — the guard refused only `'posted'` — FIXED

"Already posted" for this table means **the event is no longer open for
posting**: its work is either done (`posted`) or abandoned (`discarded`). Both
routes now ask `isCaptureEventPostable(status)`, an ALLOW-list over the CHECK
vocabulary: `received`, `extracting`, `extracted`, `failed`. An allow-list, not
a longer deny-list, so a status added to the constraint later fails CLOSED until
someone decides it is postable. `received` / `extracting` stay postable because
they always were (the `!extracted_data` refusal is what stops an unfinished
extraction); `failed` stays postable because `post.ts` itself parks a duplicate
there and a retry must work. The 400 wording for `posted` is unchanged; other
refusals say `Event cannot be posted from status '<s>'`.

Two unit fixtures seeded `event_status: 'pending'` — a value the CHECK has never
allowed. The allow-list refuses it, so they now seed `'extracted'`. That is the
fixture-hides-defect lesson in miniature: the old deny-list passed on a status
that cannot exist.

### LOW-1 — the 409 branch had no test — FIXED

Two tests hold the event row `FOR UPDATE` from an independent pool client and
assert 409 (measured `409 (5002ms)`), nothing written, and — for post-expense —
that the retry after release posts once. M4 (409 mapping removed) turns both red.

### LOW-2 — 409 at the lock, 500 one statement later — FIXED

Contract chosen: **409** (`apiResponse.conflict`). This path already spoke it —
the round-1 lock mirrors `bank/bankTxLock.ts` and K-071's bank routes; the
capture routes have never emitted `apiDocumentLock`'s 503 + `Retry-After`, and a
third contract was not invented. To make the path consistent, the timeout is
narrowed to the lock statement: `SET LOCAL lock_timeout = DEFAULT` runs the
moment the `FOR UPDATE` is granted, so downstream lock waits behave exactly as
before this lock existed and no new 500 shape is introduced. The reset runs only
after a GRANTED lock — a 55P03 aborts the tx, and any statement in a `finally`
would raise 25P02 and mask it.

**Not pinned by a test**: the reset is a behaviour restoration, observable only
through a downstream lock held >5s mid-request; no test exercises that.

### Round 2 mutations (file copies in `agents/fix-r058b/`, restored, `git diff` = the edits only)

| Mutation | Result |
|---|---|
| M1 allow-list → `=== 'posted'` on both routes | 3 failed: both DISCARDED tests + the concurrent discard/post |
| M2 discard UPDATE predicate removed (lock kept) | 16 passed — the lock + JS check still refuse |
| M3 discard unlocked plain SELECT + predicate removed (round-1 code) | 2 failed |
| M4 `CaptureEventLockedError` mapping disabled | 2 failed: both 409 tests |
| M5 discard JS status check removed (predicate kept) | 16 passed — the predicate refuses on its own |
| restored | 16 passed |

### Round 2 historical impact — production NOT measured

```sql
-- A ledger artefact behind an event the inbox shows as discarded
-- (MEDIUM-1 concurrent, or MEDIUM-2 post-after-discard that later got discarded).
SELECT ce.company_id, ce.id, ce.captured_document_id, ce.posted_at, ce.updated_at
FROM capture_events ce
WHERE ce.status = 'discarded'
  AND ( ce.posted_at IS NOT NULL
     OR EXISTS (SELECT 1 FROM supplier_invoices si WHERE si.company_id = ce.company_id
                  AND si.source_document_id = ce.captured_document_id)
     OR EXISTS (SELECT 1 FROM expense_claim_lines ecl WHERE ecl.company_id = ce.company_id
                  AND ecl.source_document_id = ce.captured_document_id)
     OR EXISTS (SELECT 1 FROM gl_journal_entries je WHERE je.company_id = ce.company_id
                  AND je.source_document_id = ce.captured_document_id));
```
Post-after-discard that ends `posted` is indistinguishable from a normal post
unless `error` still carries the discard reason: add
`OR (ce.status = 'posted' AND ce.error IS NOT NULL)` to review those by hand.

## Not done

- R-070 registered, not fixed (reasoning above).
- `capture/[id]/post.ts` 500s on an extraction with no `lineItems` / `warnings`
  array (`aiInvoicePipelineService.ts:142,179` read `.length` unguarded). Found
  while seeding the fixture; pre-existing, unrelated to this item, left alone.
- `routeEvent` reverting `'posted'` → `'extracting'` is **R-071** (registered by
  the orchestrator), not fixed here — out of scope, reachability measured negative
  by the reviewer. Round 1 called it non-financial; that was wrong — it would
  defeat the guard (reviewer measured `claims now 2` when applied by hand).
- The reviewer's addendum suggested a partial unique index on
  `expense_claim_lines(company_id, source_document_id)` as a DB backstop for the
  one path with none. Not done: it is a migration, not among the four scored
  findings, and needs a dedupe check on existing rows first. Recommended as a
  follow-up alongside R-071.

## Round 3 — two unpinned lines, one wrong comment

Blind review of `467bbf1d4`: 0 HIGH · 0 MEDIUM · 2 LOW.

### LOW-1 — `captureEventLock.ts:189` (the reset) and `:72-74` (the allow-list) had no test — FIXED

Two tests added to `tests/integration/r058-capture-post-double-post.int.test.ts`
(now 18):

- `post-expense: a downstream lock wait outlives the 5s used to acquire the
  event lock` — adapted from the reviewer's own probe
  (`agents/rev-r058b/r058b.probe.test.ts`, the `LOW-2` block). Holds
  `captured_documents`' row `FOR UPDATE` from an independent connection for 7s,
  then calls `post-expense` and asserts 200 in >5000ms. Without
  `lockWithTimeout`'s `SET LOCAL lock_timeout = DEFAULT` reset, the downstream
  wait on that unrelated row inherits the 5s bound meant only for the
  `FOR UPDATE OF ce` acquisition and the request 500s at ~5s instead.
- `post-expense: a 'failed' event (post.ts's duplicate-retry park) is still
  postable` — seeds an event at `status='failed'` with extracted data, posts,
  asserts 200 / one journal / `status='posted'`. Pins the allow-list's
  over-refusal direction: `post.ts:151` parks a duplicate-blocked bill there
  for retry, and a shrunk allow-list would strand it with no race needed.

`seedEvent()` gained an optional 4th `status` parameter (default `'extracted'`,
unchanged for every existing call) and a `holdDocumentRow(documentId, ms)`
helper was added alongside `holdEventRow` for the first test.

### LOW-2 — the `!extracted_data` justification at `captureEventLock.ts:63-65` was false — FIXED

Corrected the comment only; `'extracting'` stays on the allow-list (decided
with R-071, not here). It no longer claims the routes' `!extracted_data`
refusal stops a still-extracting event — it doesn't: `routeEvent` writes
`captured_documents.extracted_data` in its own `UPDATE`
(`captureRouterService.ts` ~161) *before* it sets `capture_events.status =
'extracted'` in a second, separate statement (~176), so a request landing
between those two writes sees `status='extracting'` with data already present
and passes both checks. The comment now states what actually makes that window
survivable — `routeEvent` still runs to completion and flips the status
forward, so a request racing it doesn't itself corrupt anything — and points to
R-071 as the unpredicated writer that could turn this into a real defect (not
fixed here).

### Round 3 mutations (file copy, restored, `git diff` = the edits only)

| Mutation | Result |
|---|---|
| M6 drop `SET LOCAL lock_timeout = DEFAULT` | 1 failed — the new reset test (5095ms, timed out at ~5s instead of succeeding at >7s) |
| M7 allow-list → `'received', 'extracting', 'extracted'` (drop `'failed'`) | 1 failed — the new `'failed'` retry test |
| restored | 18 passed |

### Round 3 gates (foreground)

```
env -u DATABASE_URL bun run ci
[ci] build PASS
[ci] all checks passed
EXIT=0

source fixture.env && bunx vitest run --config vitest.integration.config.ts --no-file-parallelism \
  tests/integration/r058-capture-post-double-post.int.test.ts
Test Files  1 passed (1)
     Tests  18 passed (18)
EXIT=0
```

## Round 4 — R-071 fixed here: routeEvent could silently revert a posted event

Blind review of `9b4853823`: 0 HIGH · 1 MEDIUM · 0 LOW. The round-3 comment was still
false — the `!extracted_data` / window argument was correct about *why* the
window exists, but wrong that racing it was harmless. `routeEvent`'s writes
AFTER extraction (`captureRouterService.ts` — the two `'extracted'` branches
and the `'failed'` branch) were themselves UNPREDICATED
(`WHERE id AND company_id` only). If a post landed and completed INSIDE the
window (status still `'extracting'`, `extracted_data` already written —
exactly what the round-3 comment described), `routeEvent` finishing afterwards
silently reverted the event from `'posted'` back to `'extracted'` — postable
again, per the allow-list — and a SECOND post went through with no race needed
on the second call. The reviewer measured this on a FIRST extraction (no
re-extract endpoint required), so `fix.md`'s earlier "reachability NEGATIVE"
for `captureRouterService.ts:138` (re-running extraction on an *existing*
event) did not cover this — this is a different write, in the SAME function
call, racing a post rather than racing a second `routeEvent` invocation.
Employee-claim path: measured 1 → 2 claims, no DB backstop on
`expense_claim_lines`.

### Fix

`captureRouterService.ts`'s three post-extraction writes (`'extracted'` with
data, `'extracted'` without data, `'failed'`) now carry `AND status =
'extracting'` and `RETURNING id`, and check the row count. Zero rows means a
post (or a concurrent `routeEvent`) already moved the event on — the result is
dropped with a `log.warn`, not silently written over. The FIRST write ("mark
as extracting") is NOT predicated: it is reachable only from `routeEvent`'s own
initial SELECT, immediately after an INSERT the caller just made in the same
function (see the round-2 census below — no re-extract/retry endpoint exists),
and a post cannot race it because `!extracted_data` always refuses before that
first write has any data to expose.

### Census — every `routeEvent` caller, and what status each write can legitimately start from

Every caller (`grep -rln routeEvent pages src`, excluding tests): `upload.ts:173`,
`inbound-email.ts:51` (via `inboundEmailService`), `imapMirrorService.ts:266`,
`whatsAppInboundService.ts:234`. All four INSERT a NEW `capture_events` row at
`status='received'` and call `routeEvent` on that same id in the same function
— none re-invoke it on an existing event. No retry-of-`'failed'` or
re-extraction endpoint exists anywhere in the repo (confirmed again this
round). So the only legitimate transition into `'extracting'` is
`'received' → 'extracting'` (the unpredicated first write), and the only
legitimate transition OUT of `'extracting'` is to `'extracted'` or `'failed'`
(the three now-predicated writes) — both hold under the new predicate, so no
legitimate path became a no-op. Confirmed by the unit suite
(`captureRouterService.test.ts`, 22 tests, all still pass unmodified — the
predicate/RETURNING change does not add or remove a `sql` call, only changes
what the mocked empty-array return means) and the new integration test's
"legitimate routeEvent, no race" case.

### Test — `tests/integration/r058-capture-router-post-race.int.test.ts` (new file, 2 tests)

Same interleave technique as `k122b-portal-token-race.int.test.ts`: `vi.mock('@/lib/neon')`
wraps the real `sql` and, on ONE specific call (the `'extracted'`-with-data
UPDATE), pauses before it runs, lets a real `post-expense` call complete in
the window, then releases it — a genuine interleave of the real code, not a
replay of the statement.

1. `a legitimate routeEvent (no race) still transitions the event to extracted
   with data` — no interception armed; proves the fix doesn't strand ordinary
   extractions.
2. `a post that lands and completes inside routeEvent's extracting window is
   not undone when routeEvent finishes afterwards` — the regression pin. Post
   inside the window → 200, 1 claim, event `'posted'`. `routeEvent`'s delayed
   write then runs and must be a no-op: event stays `'posted'`, claims stay 1,
   a second post attempt is refused 400 with claims still 1.

### Mutation (file copy, restored, `git diff` = the edits only)

| Mutation | Result |
|---|---|
| Drop `AND status = 'extracting'` from the `'extracted'`-with-data write (leave `RETURNING id` / row-count check) | 1 failed — the regression test: event reverted to `'extracted'`, second post succeeded, claims 2 |
| restored | 2 passed |

### Round 4 gates (foreground)

```
env -u DATABASE_URL bun run ci
[ci] build PASS
[ci] all checks passed
EXIT=0

source fixture.env && bunx vitest run --config vitest.integration.config.ts --no-file-parallelism \
  tests/integration/r058-capture-router-post-race.int.test.ts tests/integration/r058-capture-post-double-post.int.test.ts
Test Files  2 passed (2)
     Tests  20 passed (20)
EXIT=0
```

Unit: `tests/unit/services/capture/captureRouterService.test.ts` — 22/22 passed, unmodified.

### R-071 — now FIXED by this branch (was registered, not fixed, in round 2)

Round 2's `fix.md` registered R-071 as "reachability NEGATIVE" for the
`captureRouterService.ts:138` re-extraction case; that disposition stands for
THAT write (still unpredicated, still reachable only from `routeEvent`'s own
first statement, immediately after an INSERT — no external caller can re-run
it on an existing event). What round 3's review found and this round fixes is
a DIFFERENT write in the same function racing a POST rather than a second
`routeEvent` call. R-071 is closed by this commit.

### Out of scope, not fixed (registered R-075 by the round-3 reviewer)

`routeEvent` is fired unawaited from `upload.ts:173` / `inbound-email.ts:51`
inside `withAuth`'s `als.run`, and its statements after the extraction
`await` still resolve `als.getStore()?.client` — by then `withAuth` may have
already released that client back to the pool, so `routeEvent`'s writes can
run on a connection serving another request's transaction, under that
request's GUCs. Not measured or fixed here.

## Round 5 — the first write was unpredicated too, and a "dropped" result wrote half of itself

Blind review of `28bfa9350`: 0 HIGH · 1 MEDIUM · 2 LOW.

### MEDIUM-1 — `routeEvent`'s first write (`'received' → 'extracting'`) — FIXED

Round 4's reason for leaving it unpredicated ("`!extracted_data` always
refuses before that first write has any data to expose") was **false**.
`captured_documents.extracted_data` is `JSONB DEFAULT '{}'` (migration 233:8)
and none of the four ingest INSERTs sets it, so `post-expense.ts:93`'s
`!extracted_data` refusal never fires on a fresh document — `'{}'` is truthy.
The reviewer measured, with the real handlers and the real `routeEvent`:

```
data before {} → post-expense@'received' 200, 'posted', claims 1
→ routeEvent: 'posted' → 'extracting' (unpredicated) → 'extracted' (predicate matched)
→ post-expense again 200, 'posted', claims 2
```

Reachable without a race on the second post. The window is not "immediately
after the INSERT" as round 4 claimed: `inbound-email.ts` calls `routeEvent`
only after `ingestPostmarkPayload` has INSERTed and uploaded *every*
attachment, so event 1 sits committed at `'received'` for the upload time of
attachments 2..n; WhatsApp runs `attachReplyMedia` (network) between the INSERT
and the call; `upload.ts` is subject to R-075. The same window also **undid a
discard** (discard 200 → routeEvent → `'extracted'` → post 200).

The write now carries `AND status = 'received' RETURNING id` and returns (with
a `log.warn`) on zero rows — a `routeEvent` that loses the claim touches
nothing else at all.

**Census — every status a legitimate `routeEvent` call can start from.**
Re-derived from the callers, not from the predicate. All four (`upload.ts:173`,
`inbound-email.ts:51` via `inboundEmailService`, `imapMirrorService.ts:266`,
`whatsAppInboundService.ts:234`) INSERT a NEW `capture_events` row at
`status = 'received'` and pass that id. No retry-of-`'failed'` and no
re-extraction endpoint exists (`git grep routeEvent` over `pages src scripts`;
`vlm-extract`, `document-capture` and `document-capture-action` never write
`captured_documents.extracted_data` for a capture event). So the only
legitimate entry status is `'received'`, and the predicate makes no legitimate
route a silent no-op — proved forwards by the pre-existing "legitimate
routeEvent (no race)" test and the 22 unmodified unit tests, all of which
transition `received → extracting → extracted|failed`.

### LOW-1 — the `:195` and `:216` predicates had no test — FIXED

Round 4 added three predicates; only the with-data one was pinned. Adapted the
reviewer's `rev-r058d.discard.int.test.ts` probe: **discard during extraction**
is the legitimate, non-race way to land the event on a status other than
`'extracting'` underneath the two remaining writes. The test file's
`ocrService` mock gained a `mode` (`data` / `null` / `throw`) and a `hold`
promise so the discard can be issued while `extractFromPdf` is paused.

### LOW-2 — a dropped result had already rewritten `captured_documents` — FIXED

`routeEvent` has **no transaction** — every statement is its own autocommit —
so ordering is the only tool available. The `captured_documents` UPDATE ran
*before* the predicated event write, so on a 0-row (dropped) result the
document had already gone `'matched' → 'pending'` with `routeEvent`'s stale
`extracted_data`, contradicting the claim the post had just written. The event
transition is now claimed **first** and the document is written only if that
claim succeeded, so a dropped result writes nothing.

The residual is a post landing in the microseconds *between* those two
statements (event `'extracted'`, document still `'{}'`). It is strictly smaller
than, and entirely inside, the R-077 exposure below — an empty-extraction post
is possible for the whole duration of OCR, not just that gap — so it is left
for R-077 rather than answered here with a data-modifying CTE.

### Remaining exposure after this round

**R-077 (out of scope, registered):** posting from an empty `'{}'` extraction.
`post-expense.ts:93`'s `!extracted_data` guard is dead against the JSONB
default, so a client can post an event at `'received'` (or at `'extracting'`,
mid-OCR) and get a claim with no data behind it. This round stops that post
being *doubled* — `routeEvent` now drops itself instead of reverting the event
— but it does not stop the empty post itself.

### Round 5 mutations (file copy in `agents/fix-r058e/`, restored — sha256 `9ef67395…7deb7c5d`, `git diff` = the edits only)

| Mutation | Result |
|---|---|
| M8 drop `AND status = 'received'` (first write) | 1 failed — the `'received'` post test: event reverted, second post 200, claims 2 |
| M9 drop `AND status = 'extracting'` (no-data branch) | 1 failed — discard-during-extraction (OCR returns null): event revived to `'extracted'` |
| M10 drop `AND status = 'extracting'` (`'failed'` branch) | 1 failed — discard-during-extraction (OCR throws): event revived to `'failed'` |
| M11 move the `captured_documents` write back before the event write | 1 failed — the round-4 race test's LOW-2 assertion (`afterDoc.hasData` true) |
| restored | 23 passed |

### Round 5 gates (foreground; uptime 16.14 at start)

```
env -u DATABASE_URL bun run ci
[ci] build PASS
[ci] all checks passed
CI_EXIT=0

source fixture.env && bunx vitest run --config vitest.integration.config.ts --no-file-parallelism \
  tests/integration/r058-capture-router-post-race.int.test.ts tests/integration/r058-capture-post-double-post.int.test.ts
Test Files  2 passed (2)
     Tests  23 passed (23)
EXIT=0
```

Unit: `tests/unit/services/capture/captureRouterService.test.ts` — 22/22, updated
for the new `RETURNING id` row (the `'extracting'` mock now returns a row) and
the LOW-2 call reorder (event UPDATE is the 4th `sql` call, document the 5th).
