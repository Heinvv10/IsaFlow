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
