# AFS review-integrity fixes — evidence

Branch `fix/afs-review-integrity-20260910`, cut from the platform-import branch head (`c3e3896ce`, rebased onto `7a5a3bdda`) because it already carried the AFS restore fix and the impersonation guards this work builds on.

The rule the branch enforces: a section's review or sign-off is an attestation about specific content. Any write that changes the content voids it; no write touches a section of a locked (signed-off, filed or out-for-signature) document; every write lands on the section of the document the request names; and a document transition decides on the sections as they stand under its own row lock.

## Test suites

| Suite | Files | Result |
|---|---|---|
| AFS integration (real routes, real PostgreSQL) | `tests/integration/controls/afs{SectionReviewIntegrityHttp,SectionWritesHttp,SigningHttp,DocumentTransitionRace,ManagementPackGate,PackDeliveryGate,RestoreReviewState}.int.test.ts` | 92 passed |
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
| N18 | signature refusal ignores section status | **survived** | — |

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
| Q11 | reorder reads the section list before taking the locks | **survived** | — |
| Q12 | signing requires a saved brand profile again | killed (1) | sends for a company with no brand profile of its own |

Q1 and Q8 each survived their first run — Q1 because the delivery route's own pre-check
caught it, Q8 because no test asserted the success wording. A service-level test of
`deliverPack` and a "was kept" assertion were added, and both mutants then died.

### Why the survivors are not gaps

- **N2** — the `AND status = <from>` predicate on the transition UPDATE is redundant *while the row lock stands* (N1/N2b prove the lock is what the tests hold). It is kept as defence for a caller that runs outside a request transaction, where `FOR UPDATE` releases at once.
- **N4 / N4b** — the webhook guards its state three times: before the download, inside the transaction under the row lock, and in the UPDATE's `WHERE`. Removing any one leaves the other two; removing all three (N4c) is caught. Each layer covers a different failure (a replay, a status change between read and lock, a concurrent transition).
- **N18** — the "sections no longer signed off" count is subsumed by the content fingerprint, which includes each section's status. The count only produces a clearer refusal reason (`N mandatory section(s) are no longer signed off` rather than "content changed").
- **Q4** — the delivery route's pre-check is deliberately redundant: the gate is inside `deliverPack`, which every delivery passes through (Q1 proves it refuses on its own). The route check only spares a round trip and gives the caller the reason without an exception.
- **Q11** — reading the document's section list under the row locks rather than before them closes a window that no reachable defect currently walks through: an interleaving would have to renumber a section to exactly the value the payload requests (over-voiding, harmless) or add/remove a section mid-request (only generation does that, and it is guarded). It is kept because the count and the "which sections changed" decision should be taken on one state, not two.

No test was written to kill a redundant mutant.

## Decisions worth naming

- **Grandfather clause (migration 682).** Documents already out for signature at deploy carry no fingerprint, so every pending signature would be refused on arrival. The migration backfills `signing_content_fingerprint` for documents with `signing_requested_at` set and status `partner_review`, taking their current content as the content that was sent. `signing_payload_sha256` stays NULL for them — the posted bytes cannot be recovered — and the webhook does not require it.
- **Refused signatures.** The signatories did sign, so the PDF is downloaded and kept in `storage/afs-signed-quarantine/<company>/<document>-<timestamp>.pdf`, never as the document's signed copy. The Signum integration in this repo exposes only create and download, so there is no void/cancel call to make; the recorded reason tells a person to cancel the request at the provider. `signing_refused_at/reason` are returned by the document GET and shown on the review tab.
- **Signing renders with `skipChecks: true`.** The bytes are derived from the current rows (that is the point); the pre-export blocker gate remains the export's own policy. Making it a send gate as well is a separate decision.
- **Comments stay open while signatures are pending.** Review correspondence is not part of what is signed. Only the document's own lock (signed off, filed) closes it.
- **Unreviewed management packs** are generated as drafts and NOT delivered. The hold is a column on the document (`delivery_withheld_reason`, migration 683) enforced inside `deliverPack`; a document sign-off clears it and writes an `audit_log` row (`afs_pack_delivery_released`). Nothing else clears it. `deliveryWithheldReason` on the result and `deliveriesWithheld` on the scheduler summary are reporting, not the gate.
- **`signing_payload_sha256` is evidence, not a control.** The provider returns a signed, annotated PDF that can never byte-match the HTML posted, so nothing verifies one against the other; it records what left this system. The control the webhook enforces is the row fingerprint.
- **A brand profile is not guaranteed.** No company-creation path writes one (19,224 of 19,244 companies in the synthetic fixture have none), so the signing render falls back to `DEFAULT_BRAND_PROFILE` and the fingerprint records which was used. The PDF export still requires the firm's own branding.
- **Scheduled delivery is dead code today**: `deliverPack` has exactly one caller (the deliver route), the scheduler never calls it, and `deliveryScheduled` is hardcoded false. Whether the scheduler should deliver is a product decision, not one this branch takes.
