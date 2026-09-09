# K-077 — IMAP mirror stores a MIME type where the router expects an extension

**Claim.** Mirrored invoices never match the extraction router, so they are never extracted.

**Corrected trigger.** `imapMirrorService.ingestAttachment` writes `file_type =
(att.contentType ?? 'application/octet-stream').toLowerCase()` — e.g. `application/pdf`.
`captureRouterService.fileTypeToMime` looks that value up in `MIME_TO_EXT`, a table keyed by
extension (`pdf`, `jpeg`, `png`, `webp`, `tiff`), misses, and returns `application/octet-stream`.
`resolveExtraction` rejects that as an unsupported mime and returns `null` before it ever fetches
the bytes. The event is then marked `extracted` carrying no extraction at all — a silent no-op,
not an error. The map's name is also inverted: it maps extension to MIME, not MIME to extension.

**Disposition: confirmed.**

**Evidence** (`git show origin/master:<path>`; none of these files changed between the audited
5661d6f0 and origin/master 31fc2f10 — `git log --oneline 5661d6f0..origin/master -- <path>` is empty):
- `src/modules/accounting/services/capture/imapMirrorService.ts:216` sets `mime`, `:226` writes it
  into `file_type`.
- `src/modules/accounting/services/capture/captureRouterService.ts:59-70` the extension-keyed map
  and the fallback; `:84-92` the unsupported-mime early return; `:143` the call.
- The other two producers store the extension key, which is why only the mirror path is dark:
  `pages/api/accounting/capture/upload.ts:109,137` (`ALLOWED_MIME_TYPES[mimeType]` → `'pdf'`) and
  `src/modules/accounting/services/capture/whatsAppInboundService.ts:154,169` (`mimeToExt`).

**Reachability.** `pollMirrorConnection` → `ingestAttachment` → `routeEvent`. No auth or feature
gate between them; every attachment arriving through a configured IMAP mirror takes this path.

**Proposed minimal fix.** In `imapMirrorService.ts`, convert the MIME to the extension key before
the INSERT, reusing the same mapping the other producers use, and skip attachments whose MIME is
not in it (the upload route already skips unsupported MIMEs). Keep `storeCapturedBytes(…, mime)`
on the real MIME. Alternatively make `fileTypeToMime` accept either form, but then three producers
still disagree about what the column means — normalising at the writer is the smaller change.
Rename `MIME_TO_EXT` to `EXT_TO_MIME` while there.

**Historical-data impact.** Every `captured_documents` row created by the mirror carries a MIME in
`file_type` and has no `extracted_data`, and its `capture_events` row reads `extracted` — which
looks like a successful empty extraction rather than a skipped one. Read-only impact query:

```sql
SELECT cd.company_id, count(*) AS docs, min(cd.created_at) AS first, max(cd.created_at) AS last
FROM captured_documents cd
JOIN capture_events ce ON ce.captured_document_id = cd.id AND ce.company_id = cd.company_id
WHERE ce.channel = 'imap_mirror' AND cd.file_type LIKE '%/%'
GROUP BY cd.company_id;
```

Backfill is possible: the raw bytes are stored, so re-running `routeEvent` after the fix
re-extracts them. NOT run against production — production was not queried for this validation.

**Risks.** Re-extraction costs VLM/OCR calls per document and will flip those events from
`extracted`-with-nothing to `extracted`-with-data, which may surface documents in the review inbox
that users have never seen. Sequence any backfill deliberately rather than as part of the fix.
