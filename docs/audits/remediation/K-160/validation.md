# K-160 — Twilio webhook retries re-ingest the same document

- **Claim (medium):** there is no idempotency on the Twilio message id, so a retry creates a second captured document.
- **Corrected trigger:** confirmed as stated, at all three levels. The route (`pages/api/accounting/capture/inbound/whatsapp.ts:112`) verifies the Twilio signature and the destination binding, then calls `ingestTwilioPayload` unconditionally. The service (`whatsAppInboundService.ts:72-240`) uses `payload.MessageSid` only to build a file name (`:155`), a notes string (`:159`) and the `capture_events.subject` (`:206`) — it never looks up whether that id was already ingested. The schema has no unique constraint that would stop it: `capture_events` carries no index on `subject`, and `idx_captured_docs_sha256` / `idx_captured_documents_sha_company` are both non-unique (verified against the fixture schema).
- **Disposition:** `confirmed`.

## Evidence
- `whatsAppInboundService.ts` changed since 5661d6f0 (`6ed297f1`, `a3278226` — the K-004/K-005 destination-binding work). Those commits added the verified-binding recheck at `:88-111`; they added no message-id dedupe. Validated against `origin/master`, not the audited SHA.
- The code comment at `:119` already states the hazard in passing: "a throw here would 500 the webhook and make Twilio retry, re-ingesting the document (no MessageSid dedupe)". Twilio retries on any non-2xx **or** on a timeout, so the query-loop's fail-open is a mitigation for one path, not the general case.
- RED: `tests/integration/k160-twilio-retry-reingest.int.test.ts` against the disposable PostgreSQL fixture — 1 failed / 1. Log: `red.log`. Two identical deliveries of one `MessageSid` produce 2 `captured_documents` rows where 1 is required.

## Harm
A duplicated captured document is a duplicated VLM extraction (billable, `routeEvent` at `:234`), a duplicated capture-inbox item for a human to triage, and a second path to a duplicate supplier invoice — one that the fingerprint dedupe will only catch after extraction, and only when `findDuplicate` fires. `attachReplyMedia` at `:223` also re-attaches the same evidence to the open bank-transaction query.

## Proposed minimal fix
Give the ingest a natural key. Add `provider_message_id TEXT` to `capture_events`, a partial unique index `(company_id, provider_message_id) WHERE provider_message_id IS NOT NULL`, and set it from `payload.MessageSid`. At the top of `ingestTwilioPayload`, after the binding check, `SELECT id FROM capture_events WHERE company_id = $1 AND provider_message_id = $2` and return the existing event ids instead of re-ingesting. About 8 lines plus one migration (use the next unused 3-digit prefix, `IF NOT EXISTS` on the index).

## Historical-data impact
Duplicates already ingested are identifiable by the message id embedded in the file name and subject:

```sql
SELECT company_id, subject AS message_sid, COUNT(*) AS ingests, array_agg(id) AS event_ids
FROM capture_events
WHERE channel = 'whatsapp' AND subject LIKE 'SM%'
GROUP BY 1,2 HAVING COUNT(*) > 1;
```
Each extra event and its `captured_documents` row can be discarded, but only after checking whether either was posted to a supplier invoice — discard the unposted one.

## Risks
The unique index will reject a legitimate re-ingest of the same message after an operator deliberately discarded the first capture. Prefer the explicit SELECT-then-return over relying on the constraint to raise, so the webhook still answers 200 (Twilio must not be told to retry) and the discarded-then-resent case can be handled deliberately rather than as a constraint violation.
