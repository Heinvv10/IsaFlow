# AFS review-integrity fixes — evidence

Branch `fix/afs-review-integrity-20260910`, cut from the platform-import branch head (`c3e3896ce`, rebased onto `7a5a3bdda`) because it already carried the AFS restore fix and the impersonation guards this work builds on.

The rule the branch enforces: a section's review or sign-off is an attestation about specific content. Any write that changes the content voids it; no write touches a section of a locked (signed-off, filed or out-for-signature) document; every write lands on the section of the document the request names; and a document transition decides on the sections as they stand under its own row lock.

## Test suites

| Suite | Files | Result |
|---|---|---|
| AFS integration (real routes, real PostgreSQL) | `tests/integration/controls/afs{SectionReviewIntegrityHttp,SectionWritesHttp,SigningHttp,SigningInputsHttp,DocumentTransitionRace,ManagementPackGate,PackDeliveryGate,RestoreReviewState}.int.test.ts` | 148 passed (+12 in the impersonation census) |
| Unit | `bun run test:unit` | 10,949 passed; the 5 failures in `directPostBypassGuards` and `creditNoteService` fail identically at the base commit |

Integration runs use the shared synthetic instance and `--no-file-parallelism`. The HTTP fixture clears the per-IP rate-limit counters at start: every run arrives from 127.0.0.1, and without that the second run of the day is answered 429 by the real limiter.

## Mutation testing

Each mutant was applied to the working tree, the AFS integration suites were run, and the tree was restored. A mutant is "killed" when at least one test fails; the named test is the first failure.

### Round 1 — the section write guard

| # | Mutation | Result | First failing test |
|---|---|---|---|
| M1 | `lockSectionForWrite` drops the locked-document check | killed (13) | refuses overrides PUT in a signed_off document |
| M2 | guard drops `AND s.document_id = documentId` | killed (5) | refuses a restore addressed through an editable document |
| M3 | `voidSectionAttestation` returns early, writing nothing | killed (10) | overrides PUT drops a reviewed section to pending |
| M4 | void keeps the prior status | killed (6) | overrides PUT drops a reviewed section to pending |
| M5 | void keeps `reviewed_by` | killed (7) | overrides PUT drops a reviewed section to pending |
| M6 | void writes no audit row | killed (1) | records the invalidation in the audit log |
| M7 | void drops the impersonation gate | killed (1) | refuses an impersonated restore |
| M8 | overrides PUT never voids | killed (4) | overrides PUT drops a reviewed section to pending |
| M9 | AI accept never voids | killed (1) | accepting an AI narrative voids its review |
| M10 | AI generate takes no lock | killed (2) | refuses AI narrative generate in a signed_off document |
| M11 | restore never voids | killed (3) | a restore clears reviewer and signatory |
| M12 | `saveVersion` demotes signed_off again | killed (1) | saveVersion is a snapshot |
| M13 | version reads unbound from the document | killed (1) | does not list the history through another document |
| M14 | `updateAfsSection` drops the actor requirement | killed (1) | refuses to change reviewed content without naming who changed it |
| M15 | `updateAfsSection` never voids | killed (1) | voids the review when it changes content |
| M16 | suppress never voids | killed (1) | suppressing a reviewed section clears its reviewer |
| M17 | regenerate takes no lock | killed (2) | refuses regenerate in a signed_off document |
| M18 | guard drops `FOR UPDATE` | killed (1) | decides invalidation on the committed status when a review lands during the restore |

### Round 2 — transitions, signing, packs, AI generate

| # | Mutation | Result | First failing test |
|---|---|---|---|
| N1 | transition reads the document without `FOR UPDATE` | killed (3) | sign-off waits for the write and then sees the voided review |
| N2 | transition UPDATE drops `AND status = <from>` | **survived** | — |
| N2b | transition drops both the lock and the predicate | killed (3) | sign-off waits for the write |
| N3 | webhook skips the fingerprint check | killed (2) | refuses to sign off when content changed since it was sent |
| N4 | webhook drops only its outer status check | **survived** | — |
| N4b | webhook drops only its in-transaction status check | **survived** | — |
| N4c | webhook drops all three status guards | killed (2) | never moves a filed document |
| N5 | guard ignores `signing_requested_at` | killed (1) | no section of the document takes a write |
| N6 | send records no fingerprint | killed (2) | records a fingerprint of the content it sends |
| N7 | send allows sections that are not signed off | killed (1) | refuses to send while a mandatory section is not signed off |
| N8 | pack gate removed | killed (6) | (pack + AI cases) |
| N9 | AI generate locks across the model call | killed | generates and stores a narrative / holds no lock while the model runs |
| N10 | AI generate skips the re-check | killed | refuses to store a narrative when the section changed |
| N11 | AI generate never voids | killed | refuses AI narrative generate in a signed_off document |
| N12 | reorder skips the guard | killed | reorder cases |
| N13 | comment add skips the guard | killed | comment cases |
| N14 | comment resolve unbound from the section | killed | resolution addressed through another document |
| N15 | impersonation mapped to 409 instead of 403 | killed (1) | is refused with 403, not a server error |
| N16 | `updateAfsSection` voids on content only | killed (1) | voids the review on a status change alone |
| N17 | `updateAfsSection` skips the void when a reviewer is named | killed (1) | never carries an old sign-off onto new content |
| N18 | signature refusal ignores section status | **survived — argument withdrawn, killed by S13** | — |

### Round 3 — what is signed, guarded generation, held-back packs

| # | Mutation | Result | First failing test |
|---|---|---|---|
| P1 | send posts bytes read from the stored artifact again | killed (2) | signs the statements rendered from the current rows |
| P2 | send records no payload hash | killed (1) | signs the statements rendered from the current rows |
| P3 | send falls back to unrendered bytes instead of refusing | killed (1) | refuses to send when the statements cannot be derived |
| P4 | `POST /generate` ignores `signing_requested_at` | killed (1) | refuses a document-level generate while out for signature |
| P5 | `generateSection` skips lock and void | killed (5) | regenerates a reviewed section from the ledger and voids its review |
| P6 | AI re-check compares `content` only | killed (1) | refuses when an accepted narrative changed the rendered overrides |
| P7 | AI voids only when the narrative is displayed | killed (1) | voids the review of a reviewed section when it has content blocks |
| P8 | AI refuses only after the model call | killed (1) | refuses a document out for signature before it spends anything on the model |
| P9 | reorder accepts a partial payload | killed (1) | refuses a payload that does not renumber every section |
| P10 | reorder never voids a renumbered section | killed (1) | voids the review of every section whose note number changes |
| P11 | reorder names the document as the missing section | killed (1) | names that section, not the document |
| P12 | mandatory count joins every framework's template row | killed (1) | counts one mandatory section per type |
| P13 | unreviewed pack is delivered after all | killed (2) | generates an unreviewed pack as a draft, delivers nothing |
| P14 | refused signature is not quarantined | killed (2) | refuses to sign off when content changed since it was sent |
| P15 | comments blocked again while signatures are pending | killed (1) | no section of the document takes a write |

P8 initially survived — the mutant still answered 409, from the lock after the model call —
so the assertion that the model is never called was added to the test, and the mutant then died.

### Round 4 — the delivery gate, the fingerprint's real inputs

| # | Mutation | Result | First failing test |
|---|---|---|---|
| Q1 | `deliverPack` drops the withheld check | killed (1) | refused by deliverPack itself, so no caller can deliver around the route |
| Q2 | the generator persists no withheld reason | killed (2) | is refused by the delivery route, and nothing is emailed |
| Q3 | sign-off neither clears the hold nor audits it | killed (1) | goes out once a person has signed the document off |
| Q4 | the delivery route drops its pre-check | **survived** | — |
| Q5 | fingerprint drops the company name and number | killed (3) | (grandfather + company-name cases) |
| Q6 | fingerprint drops the brand profile | killed (2) | (grandfather + branding cases) |
| Q7 | fingerprint drops the document row | killed (3) | (grandfather + fiscal-year/framework cases) |
| Q8 | the refusal always claims the copy was kept | killed (2) | refuses to sign off when content changed since it was sent |
| Q9 | a cancelled request keeps the payload hash | killed (1) | clears the record of what was sent when the request is cancelled |
| Q10 | reorder allows a duplicate id | killed (1) | refuses a payload that names the same section twice |
| Q11 | reorder reads the section list before taking the locks | **survived — ill-formed mutant, see R10** | — |
| Q12 | signing requires a saved brand profile again | killed (1) | sends for a company with no brand profile of its own |

Q1 and Q8 each survived their first run — Q1 because the delivery route's own pre-check
caught it, Q8 because no test asserted the success wording. A service-level test of
`deliverPack` and a "was kept" assertion were added, and both mutants then died.

### Round 5 — the grandfather guard, an unambiguous pre-image, naming the input

| # | Mutation | Result | First failing test |
|---|---|---|---|
| R1 | 683 re-stamps every in-flight document unconditionally | killed (2) | leaves the old stamp on a document whose content changed after the send |
| R3 | the company input hashed as separator-joined text again | killed (3) | both field-boundary collisions, and the service/migration agreement test |
| R4 | the refusal never names an input | killed (7) | per-input naming cases |
| R5 | the webhook drops the stored per-input digests | killed (7) | per-input naming cases |
| R6 | the brand-profile PUT returns no warning | killed (1) | each write path warns which signature it will invalidate |
| R7 | the company PUT returns no warning | killed (1) | each write path warns which signature it will invalidate |
| R8 | a draft pack is never watermarked | killed (1) | delivers a draft to draft-tier recipients … watermarked as a draft |
| R9 | every pack is watermarked, signed off or not | killed (1) | goes out once a person has signed the document off |
| R10 | reorder reads the section list before taking the locks | killed (1) | decides which notes it renumbers on the numbers as they stand when it holds the locks |
| R11 | the send stores no per-input digests | killed (7) | per-input naming cases |

**Q11 withdrawn.** The round-4 mutant for "read before the locks" added an unused early read and left the decision on the read under the locks, so it could not have failed; its survivor argument ("no reachable defect") was wrong. R10 moves the read that decides, and the two-connection test — a renumbering committed while the reorder waits for its lock — kills it.

The field-boundary collision named in review ('Acme' + registration vs 'Acme|registration' + NULL) did not collide under the round-4 formula, because every nullable field there was wrapped in COALESCE; the separator-shift collision ('Acme|1998' + '012345/07' vs 'Acme' + '1998|012345/07') did. Both are now tests.

### Round 6 — a send the render's inputs cannot race, no grandfathering, drafts stay drafts

| # | Mutation | Result | First failing test |
|---|---|---|---|
| S1 | the send takes no FOR SHARE on the company and brand rows | killed (1) — *mechanism removed in round 7* | cannot sign branding changed under the send |
| S2 | the send compares no fingerprint before and after the render | killed (1) — *mechanism removed in round 7* | refuses the send when a first brand profile is saved while it renders |
| S3–S11 | the pre-image drops period / logo / cover style / font / secondary colour / overrides / data snapshot / note number / section type | each killed (1) | the per-input case for that field |
| S12 | a document with no fingerprint is accepted | killed (1) | is refused at the webhook with a reason telling the operator to send it again |
| S13 | the "not signed off" count is removed | killed (1) | refuses when a section becomes mandatory after the send and is not signed off |
| S14 | only 'signed_off' counts as signed for the watermark | killed (1) | treats a filed pack as signed |
| S15 | only 'draft' counts as a draft for the recipient tier | killed (1) | sends a pack still in review to draft-tier recipients only |
| S16 | the email carries no draft mark | killed (1) | … marked as a draft in the email too |
| S17 | the brand PUT warns on every save | killed (1) | warns only when a signed input actually changes |
| S18 | the company PUT warns on every save | killed (1) | warns only when a signed input actually changes |
| S19a/b | the admin rename warns always / never | killed (1 each) | tests/unit/api/adminCompanyRenameWarning.test.ts |

**N18 withdrawn.** Its argument (the fingerprint subsumes section status) held only for documents stamped at send. The template registry is not in the fingerprint, so a section that becomes mandatory after the send, never signed off, matches the fingerprint and is caught only by the count; S13 is killed by exactly that case.

### Round 7 — fingerprint what is rendered, lock nothing on the company

Round 6's FOR SHARE on the `companies` row made every unrelated company write (logo, chase settings, PIS inputs, CIPC return, WhatsApp query number, the period-lock control, trials, admin edits, bulk actions, PAYG eligibility) wait up to the ~30s Signum timeout during a send. Round 7 removes both the locks and the before/after comparison: `snapshotRenderInputs` reads the company and brand inputs and fingerprints them in ONE statement, and the render uses those returned values instead of re-reading the tables.

| # | Mutation | Result | First failing test |
|---|---|---|---|
| T1 | the render re-reads the brand table instead of using the snapshot | killed (2) | signs exactly what it fingerprinted when the branding is edited under it; signs on the default branding it saw when a first profile is saved under it |
| T2 | the render re-reads the company row instead of using the snapshot | killed (1) | signs the registered name it fingerprinted when the company is renamed under it |
| T3 | the send takes FOR SHARE on the company row again | killed (2) | … renamed under it; lets an unrelated company setting be saved during a send, promptly |
| T4 | the send takes FOR SHARE on the brand row again | killed (1) | signs exactly what it fingerprinted when the branding is edited under it |

### Round 8 — exactly what is printed, in the order it is printed

| # | Mutation | Result | First failing test |
|---|---|---|---|
| U1 | the render orders sections by note number with no id tiebreak | killed (1) | renders sections with the same note number in one order, by id |
| U2 | the report footer back in the pre-image | killed (1) | does not void the signature when the report footer … changes |
| U3 | the draft AI narrative back in the pre-image | killed (1) | does not void the signature when a draft AI narrative … changes |
| U4 | the reporting framework back in the pre-image | killed (1) | does not void the signature when the reporting framework … changes |
| U5 | the default branding renders with empty colours | killed (1) | signs on the default branding it saw when a first brand profile is saved under it |

The tie test had to be built against the plan: the planner walks the `(document_id, section_type)` index, so the test gives the higher id the alphabetically first section type and writes it first; no scan order then agrees with id order.

### Why the survivors are not gaps

- **N2** — the `AND status = <from>` predicate on the transition UPDATE is redundant *while the row lock stands* (N1/N2b prove the lock is what the tests hold). It is kept as defence for a caller that runs outside a request transaction, where `FOR UPDATE` releases at once.
- **N4 / N4b** — the webhook guards its state three times: before the download, inside the transaction under the row lock, and in the UPDATE's `WHERE`. Removing any one leaves the other two; removing all three (N4c) is caught. Each layer covers a different failure (a replay, a status change between read and lock, a concurrent transition).
- **N18** — the "sections no longer signed off" count is subsumed by the content fingerprint, which includes each section's status. The count only produces a clearer refusal reason (`N mandatory section(s) are no longer signed off` rather than "content changed").
- **Q4** — the delivery route's pre-check is deliberately redundant: the gate is inside `deliverPack`, which every delivery passes through (Q1 proves it refuses on its own). The route check only spares a round trip and gives the caller the reason without an exception.
- ~~**Q11**~~ — withdrawn; see R10.
- ~~**N18**~~ — withdrawn; see S13.

No test was written to kill a redundant mutant.

## Deploy notes

- Migrations 681 → 682 → 683 add columns only. **They back-fill nothing** (reversing the round-3 decision): "sent for signature before this deploy" is not a state the product can produce — the previous send read an HTML file nothing wrote and refused before the only writer of `signing_requested_at` could run — and the back-fills were the one mechanism that could launder a change. A hand-made in-flight document with no fingerprint is refused at the webhook and must be sent again.
- **Rolling the CODE back with 683 applied fails open**: the previous `deliverPack` does not read `delivery_withheld_reason`, so a held pack becomes deliverable.
- 681, 682 and 683 were edited in place during review. The branch is unpublished and they have been applied only to the synthetic fixture, which records no migration names, so no environment holds a checksum of the earlier text.

## Open

- **The logo is covered by its URL, not its image.** The posted HTML carries `<img src=logo_url>` and Signum fetches the image itself, so the picture behind an unchanged URL can change between the send and a signature, or between two signatories. Fix direction, for Hein to decide: embed the image bytes in the render (e.g. a data URI) and hash those bytes into the fingerprint.
- **The report footer is never printed.** `brand_profiles.report_footer_text` is saved but the AFS renderer never reads it (only management-pack branding does). A latent defect, reported, not fixed here; the fingerprint now leaves it out because it is not printed.
- **The fiscal year is fingerprinted even when a period is set.** The cover prints the period when there is one and falls back to the fiscal year; the fingerprint carries both raw fields rather than duplicate that rule in SQL, so a fiscal-year edit on a document that has a period voids a signature over identical bytes. Bounded (documents with a period are management packs) and deliberate.
- **`lockAfsDocument` (afsDocumentService.ts) is dead code that would bypass signing.** It moves any non-signed status to `signed_off` with no lock, no section count and no delivery-hold release, and has no callers. Report only.

- The platform-admin company page (`pages/admin/companies/[id].tsx`) does not display the rename warning the admin PATCH now returns. The file is 606 lines, already over the 300-line limit, so it was not grown; displaying the warning there needs that page split first.

## Decisions worth naming

- **No grandfather clause.** Rounds 3–5 back-filled fingerprints for documents "already out for signature"; round 6 removed that (see Deploy notes).
- **Refused signatures.** The signatories did sign, so the PDF is downloaded and kept in `storage/afs-signed-quarantine/<company>/<document>-<timestamp>.pdf`, never as the document's signed copy. The Signum integration in this repo exposes only create and download, so there is no void/cancel call to make; the recorded reason tells a person to cancel the request at the provider. `signing_refused_at/reason` are returned by the document GET and shown on the review tab.
- **Signing renders with `skipChecks: true`.** The bytes are derived from the current rows (that is the point); the pre-export blocker gate remains the export's own policy. Making it a send gate as well is a separate decision.
- **Comments stay open while signatures are pending.** Review correspondence is not part of what is signed. Only the document's own lock (signed off, filed) closes it.
- **Behaviour change for review_required = FALSE.** The original design was auto-sign-off AND auto-deliver: the pack was written straight to `signed_off` (the status that locks a document) with no signatory, and delivered. This branch changes that to **generate and hold**: the pack is a draft a person can open, and it is not delivered until someone signs it off.
- **Packs generated with review SKIPPED** are drafts and are NOT delivered. The hold is a column on the document (`delivery_withheld_reason`, migration 683) enforced inside `deliverPack`; a document sign-off clears it and writes an `audit_log` row (`afs_pack_delivery_released`). Nothing else clears it. `deliveryWithheldReason` on the result and `deliveriesWithheld` on the scheduler summary are reporting, not the gate.
- **`signing_payload_sha256` is evidence, not a control.** The provider returns a signed, annotated PDF that can never byte-match the HTML posted, so nothing verifies one against the other; it records what left this system. The control the webhook enforces is the row fingerprint.
- **A brand profile is not guaranteed.** No company-creation path writes one (19,224 of 19,244 companies in the synthetic fixture have none), so the signing render falls back to `DEFAULT_BRAND_PROFILE` and the fingerprint records which was used. The PDF export still requires the firm's own branding.
- **Drafts go to draft-tier recipients by design** on a company that requires review (plan-7 design, the recipient schema, the config UI and the Deliver button). The gate does not touch that; every pack that is not signed off is watermarked 'DRAFT — NOT FOR DISTRIBUTION'. Note for the product owner, not decided here: the config UI defaults every new recipient to 'both', so by default everyone receives the draft.
- **Editing company or branding while a document is out for signature is allowed**; both write paths return a warning naming each signature the change will void, and the webhook's refusal names the input that changed (per-input digests recorded at send).
- **Scheduled delivery is dead code today**: `deliverPack` has exactly one caller (the deliver route), the scheduler never calls it, and `deliveryScheduled` is hardcoded false. Whether the scheduler should deliver is a product decision, not one this branch takes.
