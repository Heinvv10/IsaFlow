# R-088 — the same slip, uploaded twice, posted twice

## Defect

Every upload is a new `captured_documents` row, so the per-document fences — R-058's row lock and
K-072's `posted_at` claim — never see a second upload of one slip. A re-upload, or the same slip
arriving by email and by WhatsApp, booked the expense and the bank credit again; a slip posted as
a receipt journal could be posted again from the capture inbox as a supplier invoice.

## Fix

- `claimCapturedDocumentForPosting` takes a required `content: { spend, ... }`. Unless the claim is
  a provisional evidence attach, it refuses a FILE (`raw_bytes_sha256`) already booked from another
  upload in the company, under a per-fingerprint advisory lock, and stamps `posted_content_sha256`
  in the claim UPDATE. `claimLineSourceDocuments` does the same for manual claim lines (and stamps
  the receipt key; one file uploaded twice onto two lines is refused as `duplicate_file`). So every
  claimer is fenced: receipt-to-journal, both post-expense branches, `capture/[id]/post`,
  `ai-invoice-pipeline`, expense-claim lines. Every route answers the claim's content refusal 409.
- Lock order is the same everywhere: the document row(s), then the content fingerprints. A claim
  line used to take them the other way round and deadlocked against a route post of the same
  document (measured: 40P01 after `deadlock_timeout`, answered busy).
- The receipt routes also run `checkReceiptDuplicate`: the same bytes, or the same normalised
  vendor|date|total|VAT unless both reads printed different slip numbers. A same-file match is
  final; a same-details match can be confirmed (`confirmDuplicate: true`), recording the earlier
  document and who confirmed it.
- Migration 710: `posted_content_sha256`, `posted_receipt_key`, `posted_duplicate_of`,
  `posted_duplicate_confirmed_by`, and `uq_captured_documents_posted_content`
  `(company_id, posted_content_sha256) WHERE posted_content_sha256 IS NOT NULL AND posted_at IS NOT NULL`.
  All new and NULL, so it builds on production as it stands; nothing is backfilled.

## Decisions

- **Evidence attach (R-127).** `provisionalEvidenceAttach` neither checks nor stamps: it books
  nothing new. The invoice routes skip an unstamped slip that evidences a live provisional
  journal and has no live supplier invoice, so a provisional followed by that slip's supplier
  invoice — the flow R-127 makes legitimate — still posts, while a pre-710 slip that was invoiced
  and then evidenced still counts. The expense routes still count it: a receipt journal would expense the
  bank line twice. Not covered: an evidence attach of a slip whose file is already booked.
- **Slip numbers.** A details match is ignored when both reads printed different reference
  numbers — two identical coffees have two slip numbers.
- **No index on the key.** The slip-number rule cannot be an index; the key check is serialised by
  its advisory lock instead. The byte index has no exemption: a confirmed repeat always has
  distinct bytes.
- **No UI override.** `capture/[id]/post`'s inbox already shows `error.message`; a same-file match
  has no override. No `.tsx` calls `receipt-to-journal` or `post-expense`.

## Limits

- **Pre-710 postings carry no receipt key.** A re-ENCODED copy of a receipt posted before 710 is
  not caught (a byte-identical one is — the check reads `raw_bytes_sha256` directly).
  `bun scripts/r088-posted-receipt-key-census.ts [--company <uuid>] [--emit-sql <file>]` is read
  only: it reports those receipts and the key groups already booked more than once, and writes the
  backfill UPDATEs for a person to review and run.
- **False positives without slip numbers.** Two genuine same-vendor/day/total purchases whose
  numbers were not read are refused until a person confirms. Acceptable while every caller is a
  person; an unattended receipt poster must not confirm a details match on its own.
- A document with no stored hash is never a same-file match.
