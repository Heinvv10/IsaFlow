# Intercompany P2b: a person's elimination of a mirrored row (follow-up, NOT BUILT)

Status: design only. Descoped from the P2 mirror PR (review rounds 22-24). Until this is built a person cannot NAME a mirrored row in an elimination:
`create-elimination` answers 400 (`mirrored_row_manual_elimination_unsupported`) to a body naming `sourceIntercompanyId`, and
`createEliminationAdjustment` refuses a source row that a message records (`EliminationMirroredRowUnsupportedError`).
Parent design: `docs/plans/2026-11-17-intercompany-mirror-posting.md`.

**Known limit of the descoped state (round 26, L1; not built).** The refusal is on the NAMED row only. A free-form manual elimination (`create-elimination` with no
`sourceIntercompanyId`) dated BEFORE its pair's cutover needs no typed reason and gets no duplicate check, so a document mirrored between the connection's
cut-over date and the pair's cutover (`eliminationDuplicates.ts` header: dated after the connection's cut-over, approved once both sides were on) can be eliminated
by mirroring AND by hand, i.e. twice. The first invariant below (ONE match source, seeing mirrors of every message status, used by every caller including a row-less elimination) is what closes it.

## The problem

P2 derives the elimination of every mirrored (message-recorded) group row from the two ledgers at read time. Where the receiver's books do not
carry the sender's figures (a variance, a cancelled bill, a rejected / dismissed / failed message) NO path eliminates the row:
`intercompany_mirror_unresolved` lists it, informationally. The generator skips mirrored rows, the manual match refuses them. The only way to
get the sender's revenue and the receiver's expense out of the group figures today is to fix the receiver's side (the listing says how per
reason code). A person's "Eliminate this row" would let a group accountant eliminate it by hand, a stored adjustment carrying
`consolidation_adjustments.source_intercompany_id` and a `manual_reason`. Wanted, not safe to ship as built.

## What rounds 22-24 found (each a neighbour of the same feature)

1. Duplicate / cover heuristic. A manual (P1) row for the same sale, already eliminated by a posted adjustment, plus a person's elimination of
   the mirrored row counts the sale twice. The "may be the same sale" match (`intercompany_mirrored_duplicate`, wide by design) was reversed
   into `intercompany_manual_cover`. It matched only mirrors the facts see (accepted, with a target document), so a mirror in another message
   status (rejected, dismissed, failed, cancelled) slipped past, and the two directions of the match disagreed.
2. Cover override. A refusal with no way to confirm blocks a legitimate pair of rows; a confirm re-opens the double count. Neither was settled.
3. Stale after a sender cancel. A person's posted elimination still counts after the sender cancels the sale (the row's sender journal no
   longer stands), so the group figures eliminate revenue that no longer exists. It was patched as a listing branch ("stale"), not as the
   derivation's own state.
4. Partial windows. An elimination dated in one month and a reversal the receiver posts in another: a window-dependent suppression double
   counts across months, so suppression became window-free (`intercompany_row_manually_eliminated` with no window), which then broke the
   listing for a window holding only one of the two months.
5. Forged discard actor. A draft discarded by status flip let a writer set `discarded_by` to anyone (the column was app-writable).
6. Post-time races and locks. A draft saved while the receiver had not accepted was posted after it had; the re-check, the group elimination
   lock, and the generator's own lock had to be shared, and the lock helper itself needed a transaction check.
7. Index upgrade. The one-standing-elimination-per-row unique index had to become per (row, has-a-reason) so an older generator's adjustment
   never blocked a person's, with an upgrade for a database that already had the old shape.

## Invariants a correct design needs

- ONE match source. A single function, seeing mirrors of ANY message status, answers "which mirrored rows does this (manual or mirrored) row
  overlap", used by the generator's skip, the duplicate flag, the cover refusal and the listing. Two predicates for one fact is the defect.
- ONE exclusivity predicate. "A person's elimination counts for this row" is one database function used by the derivation (no event emitted),
  the listing, `intercompany_mirror_stands`, the facts, and the two readers of stored eliminations. No caller patches it separately.
- The person's elimination is a STATE of the row, judged with the ledgers as of each date: it ends when the sender's cancel takes the sale out
  (then the derivation, not a listing branch, says nothing is left to eliminate and the person's adjustment is flagged for reversal).
- Post-time re-check under the group lock: the post re-evaluates the predicate in the same statement, under the lock the generator and the
  create path take (one lock helper, held to commit, refused outside a transaction).
- The audit actor is stamped by a trigger from the session user, not by a writable column; a discard is a status change the trigger records.
- Listing codes are stable (`variance` / `cancelled` / `rejected` / `dismissed` / `failed`), the person's elimination never appears as a code,
  and a listed row says what fixes it on the receiver's side as well as that it can be eliminated by hand.
- No data migration of existing consolidation rows: a legacy duplicate skips the unique index with a NOTICE, as 1019 does.

## Proposed shape

- Keep the P2 derivation as is (events per standing mirrored row). Add ONE nullable column on `consolidation_adjustments` for a person's
  mirrored-row elimination (`source_intercompany_id` + `manual_reason`, already present) and ONE definer `intercompany_row_manually_eliminated(row)`
  with no window (the elimination stands for all windows; the person reverses it to hand the row back).
- Replace cover / duplicate / facts matching with one `intercompany_row_overlap(row)` over every message status; the others call it.
- Create and post call one service (`resolveMirroredRow`) that takes the group lock, runs the predicate and writes; the route only validates
  the body. A trigger stamps `created_by` / `discarded_by` from the session.
- The listing stays informational for rows nobody has eliminated; a row with a person's elimination shows once, as "eliminated by <person>", with
  a reversal prompt when the sender's cancel makes it stale.
- UI: an "Eliminate this row" action on the unresolved notice only once the above exists; the wording of the listing already says what fixes
  each reason code.

## Test matrix

| Case | Expected |
|---|---|
| Variance row, person eliminates, posts | listed no more; derivation emits nothing in any window; reports count it once |
| Same, then receiver fixes its bill | one elimination only (the person's stands until reversed); reverse hands the row back |
| Same, sender cancels the sale | flagged for reversal; counted until reversed; not double counted |
| Manual P1 row for the same sale already posted | refusal naming it, for mirrors of EVERY message status; override per the decided rule |
| Elimination in Feb, receiver reversal in Mar | same figure however the months are windowed (additivity) |
| Draft saved before the receiver accepted, posted after | post refused in the same UPDATE, under the lock |
| Two creations for one row, with and without the unique index | one stands; the loser gets the typed refusal |
| Concurrent generator run and create | serialised by one lock; the generator is not regressed |
| Forged `discarded_by` / `created_by` | ignored or refused; the trigger writes the session user |
| Older generator's adjustment of a mirrored row | ignored everywhere, never blocks a person's |
| Credit note row | worded as a credit note, signs preserved |
| Another group's / a manual / a made-up row id | 400, nothing written |
| Every tenant's rows | `company_id` and group membership scope every read; cross-tenant ids answer as not found |
