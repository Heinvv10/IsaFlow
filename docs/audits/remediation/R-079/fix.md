# R-079 fix — the undo no longer reverses a posting a person already offset by hand

Branch `fix/audit-r079-undo-hand-offset`, off `origin/master` `1ad937f17`. Builds on K-071 rounds
21–22 (`journalReversalState`, the hand-REVERSAL `alreadyUndone` path). No migration.

## The defect

`undoRun` (`services/bank/autoPostUndoService.ts`) reversed an auto-posted journal that the user had
already corrected with an ordinary MANUAL journal. The manual journal carries no `reversal_of_id`
and sets no `reversed_at`, so K-071's reversal-chain walk cannot see it. Measured by the K-071
round-22 fixer on the fixture: provisional JE of E1 60 + E2 40 / bank 100, then a manual journal
crediting E1 60 / debiting bank 60, then the undo:

    {"afterHand":{"e1":0,"e2":40},"afterUndo":{"e1":-60,"e2":0},"undone":true}

With this branch's check removed (mutation M1 below) the new test reproduces it: the undo answers
`reversed: 1` for the same shape instead of refusing.

## The design (approved by Hein: never guess that the books were corrected by hand)

### 1. Detect before reversing — by ledger evidence, not by amount

`autoPostHandOffset.ts`. Before a row's posting is reversed (both the provisional path and the
matched/categorization path), `findHandOffset` asks the ledger whether something outside the
reversal chain already offsets it.

A **candidate** is a journal that is: POSTED; in the same company; posted strictly AFTER the
posting; not a reversal of anything (`reversal_of_id IS NULL`); still on the books (its own
reversal chain, via the shared `journalReversalState`, is not `live`); and has at least one line
moving one of the posting's accounts in the opposite direction.

A candidate **offsets** the posting when EITHER

- it is **linked** to the row — `source_record_id` is the bank transaction, or it shares the
  posting's non-null `source_document_id`; OR
- it was **made by a person** (source not `auto_*`), **no other bank line owns it** (not another
  line's `provisional_je_id` / matched journal, and not already confirmed as another line's
  correction in `audit_log`), and it lies **wholly within the posting**: every account it moves
  is one the posting moved, in the opposite direction, by no more than the posted amount.

The measured offset (E1 −60, bank +60 against E1 +60, E2 +40, bank −100) meets the second arm.
What does not, and therefore does not block the undo (each is a test): a reclass to an account the
posting never touched; the offset shape dated before the posting; a journal moving E1 back by
MORE than was posted; a system (`auto_*`) journal; a reclass between the posting's own accounts
(E1 back, E2 forward); another bank line's allocation (a refund); a hand offset the user has since
reversed; the reversal of an unrelated earlier journal.

### 2. Refuse and surface

Such a row gets a new skip reason, `skippedBy.offsetByHand`. Nothing is posted for it, its tag
stays, the run stays open (`undone` is false because `skipped` includes it), and the result
carries `handOffsets: [{ transactionId, journalEntryId, entryNumber }]`.

### 3. The recorded override

`autoPostHandCorrection.ts` `markCorrectedByHand(companyId, runId, txId, offsetJournalId, userId)`,
route `POST /api/accounting/bank-auto-post` `{ action: 'confirmHandCorrection', runId,
transactionId, offsetJournalId }`. It posts NOTHING. It clears the row's `auto_post_run_id` and
keeps its status and journal link (the line is still posted, as the user corrected it — resetting
it to `imported` would let it be posted a second time), writes an `audit_log` row (`user_id`,
`created_at`, `entity_type 'bank_transaction'`, `entity_ref` = the journal's entry number,
`changes.metadata` = `{reason: 'auto_post_corrected_by_hand', runId, postingJournalId,
offsetJournalId, offsetEntryNumber}`), and records the run undone (`undone_at`, `undone_by`) when
no row of it is left tagged. **Existing columns and the existing `audit_log` table only — no
migration.**

It refuses (400, `HandCorrectionRefusedError`, before any write) unless the named journal is a
candidate as defined above — posted, this company, after the posting, not a reversal, still on
the books, moving the posting's accounts back — and is not owned by another bank line. It is
deliberately LOOSER than detection on one axis: it accepts a journal that also touches accounts
outside the posting (a reclass), because that is the user's recorded word. One journal corrects
one line: once confirmed, it cannot be confirmed for a second line, and it no longer blocks that
line's undo.

### 4. UI

`AutoPostRunsPanel.tsx` counts the reason in its notice ("1 already offset by a manual journal —
see below") and lists each refused line through `HandOffsetNotice.tsx`: "JE-… already offsets this
posting — reverse that journal instead, or confirm it is the correction.", with a "Confirm JE-… is
the correction" button that opens the shared `ConfirmDialog` — nothing is sent until the dialog's
accept.

### Races

`undoRow` now takes the bank-line row lock (`lockBankTransactionForUpdate`) FIRST and re-reads the
line; the override takes the same lock. Whichever comes second finds the line out of the run (the
undo counts it nowhere; the override refuses). The run's rows are read `ORDER BY id` so two undos
lock in the same order. A contended lock is the existing `contended` skip.

## Tests

- `tests/integration/r079-undo-hand-offset.int.test.ts` (13): the measured case refuses with
  `offsetByHand`, posts nothing (nets unchanged, 0 contras), line keeps status / journal / tag, run
  open; untouched posting reversed once, nets 0; hand REVERSAL still `alreadyUndone` (K-071);
  eight unrelated-journal shapes do not block; a LINKED journal blocks even beyond the posting's
  accounts; the matched path refuses too.
- `tests/integration/r079-hand-correction-override.int.test.ts` (10): the override closes the
  refused row with 0 net change, records the audit fields and closes the run, and a later undo is
  refused; five non-offsets refused with nothing written (unrelated accounts, same direction,
  draft, another company's entry, the posting itself); a two-line run stays open after one
  confirmation, the journal cannot be confirmed for the second line, and the second line then
  undoes; a line from another run is refused; two racing undos reverse exactly once; an undo
  racing an override applies exactly one of them.
- `tests/unit/services/bank/autoPostUndoHandOffset.test.ts` (6) — the TS decision and the lock
  re-check; `tests/unit/components/autoPostRunsPanelHandOffset.test.tsx` (4) — wording, the
  dialog gate, Cancel sends nothing, the exact body sent, the refusal shown.
- Changed because the result SHAPE changed (not relaxed): the `toEqual` expectations in
  `autoPostUndoService.test.ts`, `k071-undo-hand-reversed-je`, `k140-undo-run-no-savepoint` gain
  `offsetByHand: 0` and `handOffsets: []`; the unit test mocks the new row lock.
- `src/lib/mcp/tools/toolHelpers.ts`: `HAND_CORRECTION_REFUSED` added to `REFUSAL_CODES` — the
  census `typedRefusalReachesAgent` requires a decision; the six messages are user-facing and name
  nothing internal. No MCP tool reaches it.

## Mutations (23, every one red; files restored, sha256 checked before/after)

| # | Mutation | Result |
|---|---|---|
| M1 | provisional path skips the offset check | detection 2 failed / 11 |
| M2 | matched path skips the offset check | detection 1 failed / 12 |
| M3 | drop "posted after the posting" | detection 11 failed |
| M4 | drop "not a reversal" | detection 1 failed |
| M5 | drop `status = 'posted'` on candidates | override 1 failed |
| M6 | any direction counts as "moves back" | override 1 failed |
| M7 | linked arm off | detection 1 failed |
| M8 | person-made condition off | detection 1 failed |
| M9 | another line's allocation not a claim | detection 1 failed |
| M10 | a confirmed correction not a claim | override 1 failed |
| M11 | within-posting admits foreign accounts | detection 1 failed |
| M12 | within-posting has no amount bound | detection 1 failed |
| M13 | within-posting ignores direction | detection 1 failed (after the E1→E2 reclass case was cut to 30, so only direction rules it out — at 60 the amount bound also did, and M13 survived) |
| M14 | reversed offsets still count | detection 1 failed |
| M15 | candidate company filter off | override 1 failed |
| M16 | override skips the offset check | override 5 failed |
| M17 | override ignores "owned by another line" | override 1 failed |
| M18 | override ignores the run tag | override 1 failed |
| M19 | override closes the run with lines still tagged | override 1 failed |
| M20 | override writes no audit row | override 2 failed |
| M21 | undo ignores the tag after the lock | unit 1 failed / 6 |
| M22 | `offsetByHand` not counted in `skipped` | detection 3 failed |
| M23 | one-click confirm (no dialog) | component 3 failed / 4 |

## Browser proof

Headless Chromium (Playwright) against `next dev -p 3217` from this worktree on `isaflow_dev`,
`reporting-qa@isaflow.dev`, Brightsphere. Seeded one run with a provisional JE (Accounting Fees 60
+ Advertising 40 / Bank - Primary 100) and a later manual journal JE-2026-00320 (Cr Accounting
Fees 60 / Dr Bank 60). On `/accounting/bank-transactions`, Undo answered 200
`{"reversed":0,"skipped":1,"skippedBy":{…,"offsetByHand":1},"undone":false,"handOffsets":[{…,
"entryNumber":"JE-2026-00320"}]}`; the notice read "Reversed 0 lines. Not undone: 1 already offset
by a manual journal — see below." and the line "JE-2026-00320 already offsets this posting —
reverse that journal instead, or confirm it is the correction." Clicking the confirm button opened
"Confirm the hand correction" with no request sent; accepting sent `confirmHandCorrection` → 200
`{"runClosed":true}`, and the run left the panel. On the DB afterwards: line still `provisional`
with its journal, tag NULL; run `undone_at` set, `undone_by` = the QA user; 0 contras of the
posting; one `audit_log` row naming JE-2026-00320. Seed rows deleted; dev server stopped.

## Gates (foreground)

- `env -u DATABASE_URL bun run ci` → every step PASS, `Tests 13017 passed | 248 skipped`,
  components `551 passed`, build PASS, `[ci] all checks passed`, **EXIT=0**.
- `k071-*`, `k140-*`, `k143-*`, `k144-*`, `r079-*` integration, `--no-file-parallelism` →
  `Test Files 19 passed (19)`, `Tests 71 passed | 1 skipped (72)`, **EXIT=0**.

## Known limits (decisions for Hein)

1. **A reclass is invisible.** A user who corrects the posting by moving E1 to an account the
   posting never touched (Cr E1 / Dr E3) makes a journal the ledger cannot tell from an unrelated
   reclass, and the brief requires that an unrelated journal not block. The undo reverses the
   posting and the reclass stands on its own — the same double-correction, in this shape. The
   override accepts such a journal, but only if the user thinks to use it; the undo does not stop
   to ask.
2. **A residual false positive.** A person-made journal, posted after the posting, using only the
   posting's accounts, backwards, within the posted amount, that nonetheless corrects something
   else, blocks the undo. The panel offers "reverse that journal" or "confirm it"; neither fits an
   unrelated journal. The workaround is to reverse it, undo, and re-post it. A third action
   ("unrelated — undo anyway", recorded) would close this; not built, as it was not in the
   approved design.
3. **Candidate scan cost.** Detection scans the company's posted journals after the posting that
   touch the posting's accounts — for the bank GL account that can be many rows per undone line.
   Correct first; not measured at production scale.

## Historical impact (production NOT measured — SQL for Hein, not run)

The undo clears `auto_post_run_id`, so a damaged row no longer names its run. What can be listed
is every auto-posted journal that was reversed and also has, between the posting and its reversal,
a person-made journal that lies wholly within it — the shape that was applied twice:

```sql
WITH posting AS (
  SELECT p.company_id, p.id, p.entry_number, COALESCE(p.posted_at, p.created_at) AS at,
         COALESCE(c.posted_at, c.created_at) AS reversed_at_ts
    FROM gl_journal_entries p
    JOIN gl_journal_entries c ON c.reversal_of_id = p.id AND c.company_id = p.company_id AND c.status = 'posted'
   WHERE p.status = 'posted' AND p.posting_agent IN ('ai-provisional:v1', 'ai:auto-post:v1')
), effect AS (
  SELECT p.company_id, p.id, l.gl_account_id, SUM(l.debit - l.credit) AS net
    FROM posting p JOIN gl_journal_lines l ON l.journal_entry_id = p.id AND l.company_id = p.company_id
   GROUP BY p.company_id, p.id, l.gl_account_id HAVING SUM(l.debit - l.credit) <> 0
)
SELECT p.company_id, p.entry_number AS auto_posting, o.entry_number AS hand_offset,
       o.posted_at AS offset_posted_at, p.reversed_at_ts AS undone_at
  FROM posting p
  JOIN gl_journal_entries o
    ON o.company_id = p.company_id AND o.status = 'posted' AND o.reversal_of_id IS NULL
   AND COALESCE(o.source, 'manual') NOT LIKE 'auto_%'
   AND COALESCE(o.posted_at, o.created_at) > p.at
   AND COALESCE(o.posted_at, o.created_at) < p.reversed_at_ts
 WHERE EXISTS (SELECT 1 FROM gl_journal_lines l JOIN effect e
                 ON e.company_id = p.company_id AND e.id = p.id AND e.gl_account_id = l.gl_account_id
                WHERE l.journal_entry_id = o.id AND l.company_id = o.company_id
                  AND SIGN(l.debit - l.credit) = -SIGN(e.net))
   AND NOT EXISTS (
     SELECT 1 FROM (SELECT gl_account_id, SUM(debit - credit) AS net FROM gl_journal_lines
                     WHERE journal_entry_id = o.id AND company_id = o.company_id GROUP BY gl_account_id) ce
     LEFT JOIN effect e ON e.company_id = p.company_id AND e.id = p.id AND e.gl_account_id = ce.gl_account_id
      WHERE ce.net <> 0
        AND (e.gl_account_id IS NULL OR SIGN(ce.net) <> -SIGN(e.net) OR ABS(ce.net) > ABS(e.net)))
 ORDER BY p.company_id, p.reversed_at_ts;
```

Parse-checked on the fixture DB only (0 rows there). Each hit is a candidate for manual review, not a proven double-correction: a hit whose offset was
unrelated is limit 2 above. A hit that is real is repaired by reversing the hand offset (the undo
already removed the posting it corrected).

## Files

`services/bank/autoPostUndoService.ts`, new `autoPostHandOffset.ts`, `autoPostHandCorrection.ts`,
`journalReversalState.ts` (moved out of the undo service unchanged, now shared);
`pages/api/accounting/bank-auto-post.ts`; `AutoPostRunsPanel.tsx`, new `HandOffsetNotice.tsx`;
`src/lib/mcp/tools/toolHelpers.ts`; `services/bank/.claude.md` + regenerated `AGENTS.md`; tests
listed above plus `tests/integration/helpers/r079Fixture.ts`.

---

## Round 2 — blind review of `822b1d405` (0 HIGH · 2 MEDIUM · 2 LOW) plus the reclass extension

### MEDIUM-1 — "mark as corrected" closed runs over live postings — FIXED, decided by the NET

The reviewer confirmed `Dr bank 1 / Cr E3 1` (manual) and `Dr bank 500 / Cr E3 500` (`auto_payment`)
against a R100 posting: both answered `runClosed:true` with the posting fully live. The override now
accepts a journal only if **a person made it** (source not `auto_*`, and `posting_agent` NULL,
`human…` or `legacy:human` — MCP agents, `system:`, `ai:` and `import:` are not people) **and,
together with the posting, it nets to zero within a cent on every NON-bank account of the posting**
(K-071's principle: decide by the net, not the flags). Otherwise `HAND_CORRECTION_REFUSED`. Both of
the reviewer's shapes are pinned, and so is the measured partial offset (E1 back, E2 40 still
charged), which is now refused. That is a consequence of the rule: a partial correction is not
"the correction". The user reverses it and undoes, or declares it unrelated.

### MEDIUM-2 — a false positive had no honest way out — FIXED (lead's decision under Hein's design)

A second recorded action, **"Not the correction — undo anyway"** (`undoAnyway`, route action
`undoAnyway`). The user declares the blocking journal unrelated to this line. `audit_log` records
who, when, the run, the line, the posting and the journal (reason
`auto_post_offset_declared_unrelated`). Then the line is undone through the same `undoRow`. The
declaration and the undo run in one savepoint, so a refused reversal (a closed period) takes the
declaration back and answers a fixed 400 with nothing written. Contention still answers 409. A
declared journal no longer blocks that line, cannot then be marked as its correction, and if a
SECOND journal still blocks, the answer names it (`outcome: 'offsetByHand'`, `handOffset`) and the
panel swaps it in. The reviewer's case is pinned end to end: an unrelated `Dr bank 25 / Cr E2 25`
blocks the undo, "mark corrected" is refused by the net check, and undo-anyway leaves
**e1 0 / e2 −25 / bank +25** with exactly one contra.

### Extension — detection fails closed on the reclass

The reviewer judged a reclass (Cr E1 / Dr E3) to be the COMMON hand correction, and round 1 missed
it. A journal now blocks the undo when it is posted, same company, after the posting, not a
reversal, still on the books (odd reversal chain = off), not declared unrelated for this line, AND
either linked (source record = the line, or the posting's source document) or person-made, not
owned by another bank line (its allocation or its confirmed correction), and **moves one of the
posting's NON-bank accounts back**. Round 1's "wholly within the posting" arm is gone: it is what
let the reclass through. Moving only the bank back never blocks, because every posting touches the
bank and a later receipt says nothing about this line.

**False-block measurement** (fixture, 20 auto-posted lines on E1/E2, routine activity after them):

| Scenario | Lines blocked |
|---|---|
| 10 month-end accruals Dr E1 / Cr accrued liability (person) | 0 / 20 |
| + those accruals reversed through the product (`reversal_of_id`) | 0 / 20 |
| + 10 supplier credit notes Cr E1 (system `auto_credit_note`) | 0 / 20 |
| + ONE accrual reversal typed by hand (Cr E1 / Dr liability, person) | **20 / 20** |
| (that one reversed) + ONE month-end reclass E2 → E3 R10 (person) | **20 / 20** |

This is the cost of failing closed. One person-made credit to an expense account blocks every
earlier auto-posting on that account until the user decides, once per line. Routine activity done
through the product (accruals, reversals via Reverse, system documents) blocks nothing. For scale,
a census on `isaflow_dev`: person-made, non-reversal journals crediting an expense account number
**4 at Brightsphere and 1 at ISAFlow Demo**, across all history.

### LOW-3 — two refused lines looked identical — FIXED

`handOffsets` now carries the line's date, amount and description, and the journal's date, amount
and description. `HandOffsetNotice` renders both: "Line 2027-11-15 · −R100,00 · … : JE-… (2027-11-16
· R25,00 · …) may already correct this posting — reverse that journal and undo again, or decide
below." Each decision sits behind its own `ConfirmDialog`.

### LOW-4 — the scan was per candidate — FIXED: one statement per row

`offsetCandidate` is one statement returning at most one journal. It is seeded only from lines on
the posting's NON-bank accounts that move them back, plus its links, so bank traffic never enters.
Link and person flags are computed once (`base`), and system journals are filtered before any
correlated check. The per-candidate checks are indexed `EXISTS` (the bank-line claim is split into
the two indexed lookups; the audit claims use the `changes` GIN index via `@>`). The reversal
chain is walked only for a journal that has a posted contra. The amount and net are computed for
the single returned row. Measured `findHandOffset` per row, after `ANALYZE`:

| Later journals | bank receipts (review shape) | system credits to E1 | person accruals on E1 | person credits to E1 (all block) |
|---|---|---|---|---|
| 200 | 4 ms | 8 ms | 7 ms | 6 ms |
| 2,000 | 3 ms | 14 ms | 3 ms | 29 ms |
| 8,000 | **5 ms** (was 2,874) | 48 ms | 4 ms | 92 ms |

Measured WITHOUT `ANALYZE` straight after the bulk insert, as the reviewer's harness did, the
review shape is 25 ms at 8,000. But the two shapes that reach the per-candidate checks degrade to
1.9 s (system credits) and 5.4 s (person credits). The planner, told the company has about one
line, picks the company index for per-journal lookups. That needs a tenant whose table statistics
are far behind its data. It is not fixed here; it is recorded.

### Guards both ways (all pinned)

Never-touched run undoes to zero · hand REVERSAL still `alreadyUndone` · undo vs undo, undo-anyway
vs undo, undo-anyway vs undo-anyway: one contra · undo-anyway vs mark-corrected: exactly one
decision recorded, and a contra only if undo-anyway won · non-blocking: offset shape dated before
the posting, system journal, MCP-agent journal, bank-only receipt, same-direction accrual, another
line's allocation, a reversed offset, the reversal of an unrelated journal, a linked journal that
charges the same way.

### Mutations (27 run, 26 red; file sha256 checked before/after)

R1 bank leg counted as expense moved back 1/7 · R2 posting_agent ignored 1/18 · R3 source ignored
1/18 · R4 other line's provisional JE not a claim 1/18 · R5 confirmed correction not a claim 1/14 ·
R6 declared-unrelated ignored 5/7 · R7 reversed journals still count 1/18 · R8 no "after the
posting" 16/18 · R9 no "not a reversal" 1/18 · R10 linked arm off 1/18 · R11 drafts count 1/14 ·
R12 no company filter 1/14 · R13 no moves-back base 1/18 · R14 net check never fails 3/14 · R15
net check includes the bank 4/14 · R16 mark: no person check 2/14 · R17 mark: no claim check 1/14 ·
R18 mark: no declared check 1/7 · R19 mark: no net check 3/14 · R20 anyway: no blocks check 1/7 ·
R22 anyway: no declaration 5/7 · R23 decisions: no run-tag check 1/14 · R24 UI one-click
undo-anyway 3/7 · R25 UI journal details dropped 1/7 · R26 offsetByHand not in skipped 7/18 · R27
undo row-tag re-check off unit 1/3 · R28 anyway: closed-period refusal re-thrown 1/8.

**R21 survived and the code went instead:** "close the run only when the line was undone" was
redundant, because `closeRunIfNothingTagged` already refuses while any line is tagged. The guard is
removed. Two more survived the first pass: R2 and R3, because the person rule was written twice (a
cheap early filter and the flag); R1, because it was aimed at the wrong file. The person rule is
now computed once (`base`), and R1 is aimed at the undo-anyway refusal it guards. All three are red
above.

### Browser proof (headless Chromium, `next dev -p 3217` from this worktree, `isaflow_dev`, reporting-qa, Brightsphere)

The first attempt seeded the posting on 2026-09-01. Undo-anyway answered **500**:
`ClosedFiscalPeriodError` from the reversal, Brightsphere's September 2026 being closed. The DB
afterwards: line still tagged, 0 contras, 0 audit rows, so the savepoint held. But the panel got
a bare 500. That is now the fixed 400 above (R28 pins it). Re-seeded in November 2027 (open):
- Undo → 200 `offsetByHand:1`. The panel read "Line 2027-11-15 · −R100,00 · R079 r2 proof line:
  JE-2027-00002 (2027-11-16 · R25,00 · R079 r2 proof — supplier refund entered by hand) may already
  correct this posting — reverse that journal and undo again, or decide below." with both actions.
- "Mark as corrected by hand" → dialog → accept → 400. The line showed "That journal does not
  correct this posting — with it, every account the posting charged must come back to zero".
- "Not the correction — undo anyway" → its own dialog, no request sent before accept → accept → 200
  `{"outcome":"reversed","runClosed":true}`. The run left the panel.
- DB: line `imported`, links and tag cleared; run undone; 1 posted contra; one audit row
  (`auto_post_offset_declared_unrelated`, the QA user, JE-2027-00002); nets on the three accounts
  over posting + contra + refund: Accounting Fees 0.00, Advertising −25.00, Bank +25.00. All seed
  rows were deleted and the dev server stopped.

### Gates (foreground)

- `env -u DATABASE_URL bun run ci` → every step PASS, `Tests 13014 passed | 248 skipped`,
  components `554 passed`, build PASS, `[ci] all checks passed`, **EXIT=0**.
- `k071-*`, `k140-*`, `k143-*`, `k144-*`, `r079-*` (20 files) `--no-file-parallelism` →
  `Test Files 20 passed (20)`, `Tests 88 passed | 1 skipped (89)`, **EXIT=0**.

### Files this round

`autoPostHandOffset.ts` (fail-closed rule, one statement, `offsetCandidate`), `autoPostHandCorrection.ts`
(net-checked mark, `undoAnyway`), `autoPostUndoService.ts` (`undoRow` exported), `bank-auto-post.ts`
(`undoAnyway` action), `HandOffsetNotice.tsx` / `AutoPostRunsPanel.tsx`, `toolHelpers.ts` (comment:
nine fixed messages), bank `.claude.md` + `AGENTS.md`; tests: `r079-undo-anyway.int.test.ts` (new,
8), `r079-undo-hand-offset` (18), `r079-hand-correction-override` (14), unit (3), component (7),
`r079Fixture.ts` (`fullReclass`, `postingAgent`). No migration.

---

## Round 3 — blind review of `06070b7fa` (0 HIGH · 1 MEDIUM · 2 LOW)

Kept from round 2 on the reviewer's evidence: the fail-closed rule. An amount-scoped rule
false-passes a combined month-end reclass 3/3, which is a double correction.

### MEDIUM-1 — the net rule refused real corrections and steered the user into undo-anyway — FIXED (lead's decision)

The reviewer's two shapes: a VAT-bearing posting (E1 86.96 + VAT 13.04 / bank 100) reclassed
Cr E1 / Dr E3 with the VAT left alone, and a correction split over two journals. Both were refused
by "mark", and "undo anyway" then gave e1 −86.96 / e3 +86.96, and e1 −60 / e2 −40 / e3 +100.

Decision: when the blocking journal moves the posting's accounts back but does not net them out,
the answer is to **reverse that journal first**. Once it is reversed through the product it has a
posted contra, the chain walk sees it off the books, and the undo is clean.
- `handOffsets` carries `netsPostingOut`, `reclass` (the journal books part of the posting to an
  account the posting never touched) and `projection`.
- The notice for that shape reads "JE-… moved this posting to another account. Reverse JE-… first
  (Journal Entries › JE-… › Reverse), then undo." For a partial correction it says "moves part of
  this posting back". The entry number links to `/accounting/journal-entries/<id>`, the page with
  the Reverse button. "Mark as corrected by hand" is offered only when the journal nets the posting
  out. The server still enforces this, and its refusal now says the journal "cannot be recorded as
  the whole correction … Reverse that journal first, then undo". It no longer says "does not correct".
- "Undo anyway" stays available, behind a dialog that shows **each account now and after the undo**
  (`autoPostUndoProjection.projectUndo`: posting + journal now, the journal alone after). The double
  correction is on screen before anyone confirms. A test pins that the projection equals what
  undo-anyway actually leaves on the DB.

Pinned (`r079-reverse-first.int.test.ts`): VAT reclass → notice fields plus a projection of
E1 0 → −86.96, VAT 13.04 → 0, E3 86.96, bank −100 → 0; mark refused; `reverseJournalEntry` on the
reclass, then undo → reversed 1 and **all five accounts net 0 on the DB**. Split correction → J1
named (reclass), reverse J1 → J2 named, reverse J2 → undo nets 0.

### LOW-2 — undo-anyway recorded a declaration over a line it did not undo — FIXED

Inside the savepoint, any `undoRow` outcome other than `reversed`, `alreadyUndone` or
`offsetByHand` now throws a `HandCorrectionRefusedError`. The savepoint takes the declaration back,
and the route answers 400. A reconciled line gets "That line is reconciled — unreconcile it first,
then undo". A re-reversed posting, or any other case, gets "That line cannot be undone as it
stands — nothing was recorded". Pinned: reconcile the line after the refusal → 400, 0 audit rows,
0 contras, line still reconciled and tagged. Re-reverse the posting after the refusal → 400,
0 audit rows, tag kept.

### LOW-3 — no date bound on the scan — FIXED

The posting's `entry_date` and posted time are read first and reach the scan as constants:
`o.entry_date >= $date AND COALESCE(posted_at, created_at) > $at`. That is an index range on
`idx_gl_journal_entries_company_date_posted`, so earlier history is never read. The named journal
of a recorded decision meets the same bound. The flags (linked, person-made) are computed once in
`pre`. The per-journal line checks run only for linked or person-made journals, and they compare
`company_id::TEXT`. It is still the tenant filter, but it is no longer an index condition: with it
as one, stale statistics picked `(company_id, gl_account_id)` and read every line of the company
per candidate (EXPLAIN: 5.3 s for 8,000 later bank receipts). Measured `findHandOffset` per row,
VAT-bearing posting:

| History | stale statistics | after ANALYZE |
|---|---|---|
| 8,000 EARLIER person E1 credits (review: 7,056 ms) | **4 ms** | 2 ms |
| 8,000 EARLIER system VAT-input credits (review: 1,717 ms) | **3 ms** | 2 ms |
| 8,000 later person bank receipts | 7 ms | 54 ms |
| 8,000 later system credits to E1 | 4 ms | 9 ms |
| 8,000 later person credits to E1 (all block) | 42 ms | 88 ms |

**Recorded limit:** a correction posted after the posting but DATED before it is not seen, and the
undo reverses the posting (pinned as a non-blocking case). The reviewer's suggested local statement
timeout was not added; the bound removes the measured cause.

### Mutations (13 run, 12 red; files sha256-restored)

T1 no date bound 1/19 · T2 reclass flag always false 2/5 · T3 anyway: reconciled not refused 1/5
· T4 anyway: other non-undo outcomes not refused 1/5 · T5 refusal remapped to the generic message
2/5 · T6 projection "after" uses the posting 2/5 · T7 UI offers mark for every journal 1/9 · T8 UI
dialog without projection 1/9 · T9 UI reverse-first guidance dropped 1/9 · re-checked on the new
query shape: U1 person rule ignores posting_agent 1/19 · U2 no posted-after bound 17/19 · U3 no
company filter 1/14. **U4 survived by design:** the person gate in `base` is a performance gate
only, and `kept` re-applies the person rule for blocking. Its effect is the stale-statistics row
for later system credits above: 4 ms with the gate, 1.6 s without (round-2 structure).

### Browser proof (headless Chromium, `next dev -p 3217` from this worktree, `isaflow_dev`, reporting-qa, Brightsphere)

Seeded a VAT-bearing provisional posting (Accounting Fees 86.96 + VAT Input 13.04 / Bank - Primary
100) and a manual reclass JE-2027-00002 (Cr Accounting Fees 86.96 / Dr Advertising 86.96).
- Undo → 200 `offsetByHand`. The notice: "Line 2027-11-15 · −R100,00 · R079 r3 proof line —
  journal (2027-11-16 · R86,96 · …): JE-2027-00002 moved this posting to another account. Reverse
  JE-2027-00002 first (Journal Entries › JE-2027-00002 › Reverse), then undo." **No "Mark" button.**
  The entry number links to `/accounting/journal-entries/<id>`.
- "Not the correction — undo anyway" → the dialog listed 1110 Bank −R100,00 → R0,00; 1140 VAT
  Input R13,04 → R0,00; Accounting Fees R0,00 → **−R86,96**; Advertising R86,96 → R86,96.
  Cancel sent nothing.
- Followed the notice: opened the linked journal page and clicked **Reverse** (`journal-entries-action`
  reverse → 200). Back on bank transactions, Undo → 200 `{"reversed":1,"skipped":0,"undone":true}`,
  and the run left the panel.
- DB: all four accounts net **0.00** over posting + reclass + both contras; line `imported`; no
  audit row. Seed rows deleted, dev server stopped.

### Gates (foreground) — see the merge note below for the merged tip

- `env -u DATABASE_URL bun run ci` → every step PASS, `Tests 13014 passed | 248 skipped`,
  components `556 passed`, build PASS, `[ci] all checks passed`, **EXIT=0**.

### Merge note (round 3)

`origin/master` moved to `5ad006971` (R-082/R-096, AR/AP statements and dunning). It shares no
file with this branch and declares no new `readonly code`, and `merge-tree` was clean. Merged as
`dfd6a83cf`. On the merged tip:
- `env -u DATABASE_URL bun run ci` → `Tests 13014 passed | 248 skipped`, components `556 passed`,
  `[ci] build PASS`, `[ci] all checks passed`, **EXIT=0**.
- `k071-*`, `k140-*`, `k143-*`, `k144-*`, `r079-*` (21 files), `--no-file-parallelism` →
  `Test Files 21 passed (21)`, `Tests 94 passed | 1 skipped (95)`, **EXIT=0**.
