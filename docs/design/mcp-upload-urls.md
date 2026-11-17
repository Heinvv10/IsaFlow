# MCP uploads without bytes in the tool call (17 Nov 2026)

**Problem.** `attach_entity_document` (2 MB) and `attach_document` (750 KB, no dedup) take base64 in the call. A
39-file sync (~7 MB) is too heavy for an agent, so syncs fell back to a browser script posting with a session cookie.

**Shape.** Two tools plus one token URL. No new scope: both tools are `write:invoices`; a bank-line target also needs
`write:bank-tx` (same rule as `attach_entity_document`), so `token_info` is unchanged.

1. `create_upload_urls` — up to 100 files `{target, file_name, mime_type, size, sha256, document_type?}`. Target is
   `{entity_type, entity_id}` (bill, invoice, credit note, payment, bank line), `{bank_transaction_id}` or
   `{bank_reference, bank_account_id?}`. Checked up front, per file: target is the token's company's (else "Not found"),
   mime allowed for that store, size within cap (bank 2 MB = the bank store's own cap; entity 10 MB, below the UI's 20 MB
   because staged bytes sit in Postgres), sha256 well-formed, and **dedup**: same bytes uploaded through this flow to the
   same target (and still there), same bytes already on the bank line (sha256 computed in SQL from the stored data URL),
   or same stored name + size → `duplicate: true`, `document_id`, no URL. Each new file gets
   `https://app.isaflow.co.za/api/mcp/uploads/<token>` valid 30 min.
2. Agent uploads with `curl -sS -T file "<url>"`. `PUT /api/mcp/uploads/[token]`: no cookie, CSRF or bearer — the
   token is the only credential. 32 random bytes; only its sha256 is stored (`token_hash`). One-shot (pending + unexpired
   only; compare-and-set to `uploaded`). Body streamed with a hard cap of the declared size (413 past it); must equal
   the declared size and sha256 and its magic bytes must match the mime (400, URL stays usable for a corrected PUT).
   Rate-limited 300/min per IP. Runs on the service pool in two short public-route transactions (no connection held
   while the body streams); the write names the intent's id AND company_id.
3. `finalize_uploads` (`upload_ids[]` ≤ 100) — per id, under the company's RLS: re-verify size, sha256, magic bytes,
   target ownership and dedup; write through the existing services (`addBankTxAttachment` / `storeDocumentBytes`,
   extraction off); clear the staged bytes; mark `finalized`; one `audit_log` row per finalize (source, upload_id,
   document_id, sha256, duplicate, token jti). Per-file status: finalized / not_uploaded / expired / refused / not_found.
   Re-finalizing returns the first result. Finalize is **bound to the creating principal**: the intent stores
   `created_by` (user) and `created_token_jti` (PAT id / OAuth authorisation id, stable across token refresh), and an id
   from any other user or connection reads `not_found`, like another company's. A bank-line upload also needs
   `write:bank-tx` at finalize (checked before the bytes are read), not only at create.

**Storage.** Migration `999q_mcp_upload_intents.sql`: company-scoped table, `tenant_isolation` RLS for `app_user`,
`app_service` mirrors via `app_service_sync_policies()`. Finalized rows keep sha256 + result id (no bytes) for dedup.
Unfinalized rows past expiry are purged by both tools (bounded 500/call) — no separate cron: nothing to do between calls
except reclaim a few MB of abandoned bytes, which the next call does.

**attach_document fix.** Dedup on the same bytes (sha256) or same name + size on the line → `duplicate: true`. Cap
raised 750 KB → 2 MB: the transport body is 3 MB since `attach_entity_document`, and the bank store already takes 2 MB.

**Not done.** Server-side JPEG downscale: no image library (`sharp` etc.) is in `package.json`; with the 2 MB cap and
the upload path it is not needed for the stated batch (≤450 KB/file). Presigned object-storage URLs: bank files live
in Postgres as data URLs, so a storage presign would cover only half the targets; one token route covers both.

**Trade-offs.** The registry stores a write tool's result for idempotent replay, so issued URLs (tokens) sit in
`mcp_tool_calls` until they expire (30 min, one-shot) — a retry with the same key gets the same URLs, which is the
point. An entity file goes to object storage before its row (as today's tool); a rolled-back finalize can leave an
unreferenced object. nginx on velo (`isaflow-combined`, app.isaflow.co.za) sets `client_max_body_size 50M`, so a
10 MB PUT passes the proxy.
