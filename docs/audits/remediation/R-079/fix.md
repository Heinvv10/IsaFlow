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
