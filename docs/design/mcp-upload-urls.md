# MCP uploads without bytes in the tool call (17 Nov 2026)

**Problem.** `attach_entity_document` (2 MB) and `attach_document` (750 KB, no dedup) take base64 in the call. A
39-file sync (~7 MB) is too heavy for an agent, so syncs fell back to a browser script posting with a session cookie.

**Shape.** Two tools plus one token URL. No new scope: both tools are `write:invoices`; a bank-line target also needs
`write:bank-tx` (same rule as `attach_entity_document`), so `token_info` is unchanged.

1. `create_upload_urls` — up to 100 files `{target, file_name, mime_type, size, sha256, document_type?}`. Target is
   `{entity_type, entity_id}` (bill, invoice, credit note, payment, bank line), `{bank_transaction_id}` or
   `{bank_reference, bank_account_id?}`. Checked up front, per file: target is the token's company's (else "Not found"),
   mime allowed for that store, size within cap (bank 2 MB = the bank store's own cap; entity 10 MB, below the UI's 20 MB
   because staged bytes sit in Postgres), sha256 well-formed, and **dedup by sha256 only**: a bank line hashes what it
   stores (sha256 computed in SQL from the stored data URL, same-size rows only); an entity target matches bytes an
   earlier finalize put there (`mcp_upload_intents` keeps sha256 + result id) while that document is active →
   `duplicate: true`, `document_id`, no URL. Never by name + size: two different statements can share both (the first
   review found a different file with the same name and size silently dropped). Known gap: a file attached to an entity
   through another route (UI, `attach_entity_document`) is not seen, because the entity store keeps no hash; it is
   stored again, which is the safe failure. **Caps** per company: 300 outstanding uploads (pending / uploaded,
   unexpired) and 300 MB declared; past either the file is refused with the reason; creates are serialised per company
   (advisory lock) so the cap holds under concurrency. Each new file gets
   `https://app.isaflow.co.za/api/mcp/uploads/<token>` valid 30 min.
2. Agent uploads with `curl -sS -T file "<url>"`. `PUT /api/mcp/uploads/[token]`: no cookie, CSRF or bearer — the
   token is the only credential. 32 random bytes; only its sha256 is stored (`token_hash`). One-shot (pending + unexpired
   only; compare-and-set to `uploaded`). Body streamed with a hard cap of the declared size (413 past it); a stall (30 s
   without data, 5 min total) or an abort stops the read (400, nothing staged). The bytes must equal the declared size
   and sha256, their magic bytes must match the mime, and they must be a complete file of that type: PDF `%%EOF` in the
   last 1024 bytes, PNG ending in IEND, JPEG ending in FFD9 (a polyglot such as a PDF header followed by HTML passes a
   magic check and nothing else; this check is the upload path's own, `fileMagic` is unchanged elsewhere). A bad body is
   400 and the URL stays usable for a corrected PUT. A good PUT moves the row's expiry to now() + 2 h (the finalize
   window) and writes an audit row. Rate limits: the client IP seen behind cloudflared / nginx is the proxy's, so a
   per-IP bucket would be platform-wide. Two tiers. Before the lookup: a token hash that missed in the last minute is answered
   404 from a bounded in-process cache (no query), then a per-token bucket (20/min: one replayed token cannot drive
   lookups) and a lookup ceiling (3600/min: unique junk cannot drive unbounded lookups). After a real intent resolves:
   the platform ceiling (3000/min) and per company (600/min), then the sweep. Misses are charged only to a miss bucket
   (600/min), never the platform ceiling, and never sweep. Known limit: before the lookup a well-formed junk token is
   indistinguishable from a real one, so a flood of unique junk past the lookup ceiling also refuses real PUTs until
   the minute turns. Closing that needs a signal checkable without the database, e.g. an HMAC over the token's random
   part with a server secret (junk then fails in-process); not done here, it needs a secret and a token-format choice. A body past its declared size is not drained: the read stops at cap + 1 byte and the
   connection is closed. Runs on the service pool in two short public-route transactions (no connection held while the body
   streams); the write names the intent's id AND company_id. The token path is redacted from logs
   (`redactShareToken`).
3. `finalize_uploads` (`upload_ids[]` ≤ 100) — per id, under the company's RLS and in its own savepoint: re-verify
   size, sha256, magic bytes and completeness, target ownership; take an advisory lock on (company, target, sha256)
   BEFORE the dedup read (two concurrent finalizes of the same bytes store once; `attach_document` takes the same lock);
   write through the existing services (`addBankTxAttachment` / `storeDocumentBytes`, extraction off); mark
   `finalized` (the trigger clears the bytes). Audit: `create` for a stored file, `update` for a duplicate, `reject`
   for every refusal (source, upload_id, document_id, sha256, token jti). At most 200 MB of staged bytes are read per
   call; the rest answer `deferred`. Per-file status: finalized / not_uploaded / expired / refused / deferred / error
   (a throw in that item: unwound, the others kept) / not_found.
   Re-finalizing returns the first result. Finalize is **bound to the creating principal**: the intent stores
   `created_by` (user) and `created_token_jti` (PAT id / OAuth authorisation id, stable across token refresh), and an id
   from any other user or connection reads `not_found`, like another company's. A bank-line upload also needs
   `write:bank-tx` at finalize (checked before the bytes are read), not only at create.

**Storage.** Migration `999q_mcp_upload_intents.sql`: company-scoped table, `tenant_isolation` RLS for `app_user`,
`app_service` mirrors via `app_service_sync_policies()`; `staged_bytes` STORAGE EXTERNAL (already-compressed files).
Finalized rows keep sha256 + result id (no bytes) for entity dedup. Column grants plus a guard trigger mean app_user
cannot forge what the code does not write: it inserts the declaration only (created_by is `auth.uid()`; status, expiry
and outcome are set by the trigger) and updates status / result / refusal only, along the legal transitions (a
finalized row must name a live document of its target, holding these bytes for a bank line). app_service (PUT, sweep)
adds `staged_bytes` and DELETE. Accepted: `created_token_jti` is what the app sent (no GUC carries the token id).
**Sweep**, no cron: both tools and the PUT route run it on the service pool across every company (SKIP LOCKED,
bounded batches of 200): an expired row's bytes are cleared at once (the row stays and reads `expired`, not
`not_found`), an unfinalized row is deleted 7 days after expiry. A sweep failure is logged and never fails the call.

**attach_document fix.** Dedup on the same bytes (sha256 of what the line stores) → `duplicate: true`, with the same
reply shape as a fresh attachment. The size cap is checked before the line is resolved. Cap raised 750 KB → 2 MB: the
transport body is 3 MB since `attach_entity_document`, and the bank store already takes 2 MB.

**Not done.** Server-side JPEG downscale: no image library (`sharp` etc.) is in `package.json`; with the 2 MB cap and
the upload path it is not needed for the stated batch (≤450 KB/file). Presigned object-storage URLs: bank files live
in Postgres as data URLs, so a storage presign would cover only half the targets; one token route covers both.

**Trade-offs.** The registry stores a write tool's result for idempotent replay, so issued URLs (tokens) sit in
plaintext in `mcp_tool_calls.result` — a retry with the same key gets the same URLs, which is the point. Accepted:
the row is tenant-scoped, a token is one-shot and dies after 30 minutes (or at its first good PUT), and a reader of
that table can already read the company's documents. Logs never see a token (path redaction). An entity file goes to object storage before its row (as today's tool); a rolled-back finalize can leave an
unreferenced object. nginx on velo (`isaflow-combined`, app.isaflow.co.za) sets `client_max_body_size 50M`, so a
10 MB PUT passes the proxy.
