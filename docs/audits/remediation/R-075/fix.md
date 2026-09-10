# R-075 — fire-and-forget `routeEvent` outlives the request's transaction

**Branch** `fix/audit-r075-route-event-after-commit`, based on `e86b10664`.
**Severity** HIGH (measured; see `probe-r075.md`).

## The defect

`pages/api/accounting/capture/upload.ts:173` started `routeEvent(eventId, companyId)` and did not
await it. `src/lib/neon.ts:110` routes every `sql` call through `als.getStore()!.client`, and
`withAuth` never exited the store or nulled the client — so after `withAuth` COMMITted and
`client.release()`d, the background statements still went to that PoolClient. pg-pool hands idle
clients out LIFO, so the next request usually gets it. Measured outcomes:

- **(a) inside the next request's transaction**, under its claims: the event sticks in
  `'extracting'` with a false "extraction complete" log, or — same user acting for another
  company — the write fails `WITH CHECK` and **aborts that request with a 500 and a rollback**.
- **(b) autocommit as `postgres`**, RLS bypassed. The pre-VLM `'extracting'` UPDATE did this on
  every run.
- **(c) `Client was closed and is not queryable`** after the 30 s idle reap.

`als.exit(() => routeEvent(...))` alone is the wrong fix: `routeEvent` starts *before* the COMMIT,
so on a fresh connection its first SELECT cannot see the uncommitted event.

## The fix

New `src/lib/afterCommit.ts`, three exports:

- `runOwnedContext(ctx, fn)` — `als.run` for the code that OWNS the transaction. Sets
  `ctx.finished = true` as soon as `fn` settles, before the owner COMMITs and releases.
- `runAfterCommit(label, fn)` — queues `fn` on the context. With **no** store (cron, webhook,
  API-key upload) it starts immediately, which is the behaviour those callers already had. On a
  finished context, or a context whose owner does not drain, it **throws** rather than silently
  dropping the work or starting it on the request's connection.
- `drainAfterCommit(ctx)` — the owner calls it only after its COMMIT **succeeded**. Each callback
  runs under `als.exit`, so it and every async continuation it creates see no store. A callback
  failure is logged (`log.error('after-commit work failed', …)`), never thrown into the finished
  request.

`src/lib/als.ts`: `assertTxUsable()` — already called by `neon.ts` before routing a query through
the request client — now refuses a `finished` context first, naming the cause and pointing at
`runAfterCommit`. This is the global guard: the whole class now fails loudly instead of wandering.

Every request/transaction owner was converted to `runOwnedContext` + `drainAfterCommit`:
`withAuth`, `bearerPipeline`, `withPlatformAdmin`, `withExtensionToken`, `withInviteToken`,
`withAlsTransaction`, `withPublicRouteTx`. `withAuth` and the bearer pipeline share one try block
for COMMIT and ROLLBACK, so the drain is guarded on `!handlerFailed`; `withAuth` still COMMITs
before replaying the buffered flush, and the drain comes after the flush.

`portfolioWorkbenchService` also runs `als.run` (per-client, on the BYPASSRLS admin pool). It was
moved to `runOwnedContext` for the `finished` guard but deliberately given **no** queue: its body
is `getMonthEndWorkbench`, read-only reporting that reaches none of the converted sites, so a
`runAfterCommit` there is a bug and should throw.

### Design choice: the background work runs as the pool's role, with explicit `company_id`

`detach` runs each callback under `als.exit`, so its `sql` calls fall through to `getPool()` — the
privileged default role, no RLS GUCs — exactly like the cron, the Postmark webhook and the API-key
upload that call the same services today. Chosen over re-establishing the company's claims because:

1. It is the path these services already run on in production (`inbound-email.ts`, the IMAP cron),
   so it is the shape they are tested and proven against; the RLS path is not.
2. Every statement `routeEvent` issues already carries an explicit `company_id = <A>` predicate —
   the probe confirmed no cross-tenant read or write even under a foreign role — so tenant scoping
   does not depend on the GUC.
3. Re-issuing a user's claims onto a fresh connection would mean minting a second authenticated
   context outside any request, which is a larger and more dangerous surface than the fix needs.

The obligation this creates: **every statement in after-commit work must carry its own `company_id`
predicate.** That is written into the module header of `afterCommit.ts`.

One consequence had to be handled. `runLlmResidualPass`'s auto-post sweep posts through
`allocateTransaction`, whose `FOR UPDATE` row lock and savepoints require a request transaction —
the wandering path used to supply the caller's by accident. `buildRunDeps` now wraps the sweep in
`withAlsTransaction({ userId, companyId })`, giving it its own. Without that the row is tagged but
never posts (mutation M8 below).

## Census — every un-awaited / post-response `sql` reach in `pages/` and `src/`

`eslint.config.mjs:67` sets `@typescript-eslint/no-floating-promises: ['error', { ignoreVoid: true }]`
with type-aware linting, so an un-awaited promise in this repo can only be spelled `void expr` or
`expr.catch(handler)` / `.then(_, handler)`. The census enumerated exactly those two forms plus the
timer escapes (`setTimeout` / `setImmediate` / `process.nextTick` / `queueMicrotask`), over
`pages/api`, `src/lib`, `src/modules`, `src/services`, `src/utils` — every server directory
(`src/components`, `src/contexts`, `src/hooks`, `src/types` are client/type-only). It also walked the
`als.run` sites, which bound the set of contexts a call can be under.

Converted to `runAfterCommit` (13 sites, all reachable under a request transaction):

| Site | Work |
|---|---|
| `pages/api/accounting/capture/upload.ts:175` | `routeEvent` (the finding) |
| `pages/api/accounting/bank-tx-attachments.ts:160` | attachment VLM extraction |
| `pages/api/accounting/company-documents.ts:137` | statutory doc extraction |
| `pages/api/accounting/smart-categorize.ts:115,148` | LLM residual pass (2) |
| `pages/api/accounting/bank-transactions-bulk-commit.ts:302` | `recalculateNudge` |
| `pages/api/admin/health.ts:223` | `checkAndAlert` |
| `src/lib/billing/withFlowMeter.ts:143` | `recalculateNudge` |
| `src/modules/.../core/documentStorageService.ts:144` | procurement doc extraction |
| `src/modules/.../core/emailNotificationService.ts:115` | `invoice.sent` webhook |
| `src/modules/.../capture/imapMirrorService.ts:269` | `routeEvent` (scan-now runs under withAuth) |

Left as-is, with the reason each does **not** now throw:

| Site | Why |
|---|---|
| `pages/api/accounting/capture/inbound-email.ts:51` (`routeEvent`) | `withErrorHandler` only — no ALS store. Confirmed by the probe and by an integration test here. |
| `src/modules/.../capture/whatsAppInboundService.ts:234` (`routeEvent`) | Only caller is the Twilio webhook route, `withErrorHandler` only — no store. |
| `pages/api/accounting/capture/inbound/whatsapp.ts:134,142` | `sendWhatsAppMessage` — no `sql`, and no store. |
| `pages/api/portal/pixel/[token].ts:62` | `withErrorHandler` only — no store; already runs on the pool. |
| `pages/api/auth/forgot-password.ts:65`, `pages/api/auth/register.ts:248`, `pages/api/oauth/register.ts:156` | `withRateLimit` only — no store. |
| `src/lib/auth/oauth.ts:501` (`updateLastUsed`) | `validateOauthAccessToken` runs at `bearerPipeline.ts:103`, before `runOwnedContext` at `:244` — no store. |
| `pages/api/accounting/ai-invoice-pipeline.ts:217`, `pages/api/accounting/capture/[id]/post.ts:236`, `src/modules/.../ap/supplierInvoiceService.ts:190` (`resolvePendingAlertForInvoice`) | **Under withAuth**, but not R-075 sites: the function has no `await` before its single `sql`, so the UPDATE is queued on the request's client within the same microtask drain — ahead of the COMMIT — and commits atomically with the request. Converting them would move an atomic write out of the transaction. Pinned by outcome in `tests/unit/lib/afterCommitCensus.test.ts` (mutation M6). |
| `src/modules/bureau/.../bureauWorkAggregatorService.ts:237` (`monthEndProgress`) | Listed as a candidate by the probe, but it is inside a `Promise.all` and **is** awaited. |
| `src/modules/admin/.../sageMigrationOrchestrator.ts:36`, `.../gl/closeRun/closeRunService.ts:184`, `.../capture/whatsAppInboundService.ts:281`, `pages/api/accounting/supplier-statements/index.ts:153` | `.catch()` on an **awaited** call — not floating. |
| `src/lib/observability/deepChecks.ts:30` (`p.then` in `withTimeout`) | The wrapped promise is awaited; the inner query is issued before the handler returns, so pg pipelines it ahead of the COMMIT. A timeout rejects the wrapper, not the statement. |
| Timers | Every `setTimeout` / `setImmediate` in server code is an `AbortController` deadline or a UI toast — none issues `sql`. |

## Tests

`tests/unit/lib/afterCommit.test.ts` · `afterCommitSites.test.ts` · `afterCommitTxOwners.test.ts` ·
`afterCommitCensus.test.ts` · `tests/unit/auth/afterCommitRequestOwners.test.ts` — 41 tests.
`tests/integration/r075-route-event-after-commit.int.test.ts` (4) and
`r075-llm-residual-after-commit.int.test.ts` (1), on `isaflow_schema_fixture`.

The integration suite drives the **real** upload route through the **real** `withAuth`, replacing
only `@/lib/supabaseStorage` and the VLM boundary. It asserts the event reaches `'extracted'`, that
routeEvent's three writes ran on a different pid **and** txid from both the upload's own transaction
and a concurrent company-B request holding its transaction open, that B answers 200 with its marker
row persisted, that a rolled-back upload never calls `routeEvent` at all, and that the API-key
upload and the Postmark inbound-email webhook still extract.

### Mutations (each applied to production code, run, reverted from a file copy)

| # | Mutation | Result |
|---|---|---|
| M1 | `runOwnedContext` no longer sets `ctx.finished` | 3 failed |
| M2 | drop the `store?.finished` guard in `assertTxUsable` | 6 failed |
| M3 | `withAuth` drains unguarded (`drainAfterCommit(ctx)` on the 5xx path too) | 1 failed |
| M4 | `withAlsTransaction` never drains | 1 failed |
| M5 | `detach` runs `fn()` instead of `als.exit(fn)` | 1 failed |
| M6 | `resolvePendingAlertForInvoice` awaits before its `sql` | 1 failed |
| M7 | `upload.ts` back to the bare fire-and-forget (the unfixed code) | 2 failed — the concurrency test and the rollback test |
| M8 | LLM sweep without its own `withAlsTransaction` | 1 failed (`expected 'imported' to be 'allocated'`) |

Baseline after restore: 41/41 unit, 5/5 integration.

### Attribution of the two red neighbours

`tests/integration/k-035-webhook-redelivery-discarded.int.test.ts` (4) and
`tests/integration/withAuth.test.ts` (2) fail on this branch. Run alone they fail identically, and
they fail identically on a clean `git archive e86b10664` extraction with the same fixture. Not this
branch's.

## Gate

`env -u DATABASE_URL bun run ci` → `[ci] build PASS`, `[ci] all checks passed`, **exit 0**.

## Production impact — NOT measured (do not run this from an agent)

Events stranded in `extracting`, per company:

```sql
SELECT company_id, count(*)
FROM capture_events
WHERE status = 'extracting'
  AND updated_at < now() - interval '1 hour'
GROUP BY 1
ORDER BY 2 DESC;
```

No retry picks these up. This change stops new ones; it does not recover the existing rows — that
needs a worker or a one-off re-route, which is out of scope here.

## Two notes for the merge

1. **This widens the window in which a capture event sits at `'received'`.** Previously routeEvent's
   first SELECT was queued inside the request's own transaction; now the event is visible at
   `'received'` from COMMIT until the callback picks it up. Anything that posts or acts on a
   `'received'` event during that window depends on the **R-058 branch's predicates**, which are not
   yet merged. Land R-058 first, or with this.
2. **R-077** (registered separately) covers the stranded-event recovery path; it is not fixed here.

---

# Round 2 — the two LOWs from the blind review of `e4113b405`

## LOW-1 — three converted callbacks updated by bare primary key

`extractAttachmentData`, `extractStatutoryDocData` and `extractAndStoreDocMetadata` updated
`WHERE id = $1` and nothing else. Before this fix they ran on the request client under the company
GUC, with RLS as the backstop; drained callbacks run on the pool's privileged role, where there is
none. Not exploitable today — every id is a UUID returned by the same request's own
`INSERT … RETURNING` — but it made the invariant the module header advertises false for 3 of 13
callers, which is how the next converted site gets it wrong.

Two of the three tables carry **no `company_id` column**; their tenancy lives in a parent, which is
what their own RLS policies walk. Each predicate now reproduces that policy rather than inventing a
column:

| Table | Predicate added | Why this shape |
|---|---|---|
| `bank_transaction_attachments` | `AND EXISTS (SELECT 1 FROM bank_transactions bt WHERE bt.id = …bank_transaction_id AND bt.company_id = $n)` | No `company_id`; this is the table's own RLS `WITH CHECK`, verbatim. |
| `company_documents` | `AND company_id = $n` | Has the column. |
| `procurement_documents` | `AND entity_type = $n AND entity_id = $n` | No `company_id`, and the INSERT never had one: tenancy is `(entity_type, entity_id) -> parent`, which is what `tenant_isolation_via_parent` walks. `uploadDocument` has no companyId to thread, so the predicate restates the identity the request supplied and `withAuth` authorised. |

`afterCommit.ts`'s header now states the obligation precisely — self-scoping, normally an explicit
`company_id`, and these two tables' parent-scoped exceptions named — instead of a rule that 3 of its
callers silently broke.

`extractAttachmentData` and `extractStatutoryDocData` were module-private; both are now exported so
the test can call them with a foreign tenant. Named exports beside a Next API route's default are an
established pattern here (`reports-html.ts`, `companies.ts`, `depreciation-export.ts`, …).

### Re-check of every other converted callback against the invariant

| Callback | Statements | Verdict |
|---|---|---|
| `routeEvent` (upload, imap mirror) | `captureRouterService.ts:115,136,159,174,182,194`, `documentStorage.ts:72-74` | `company_id` on every one. OK |
| `runLlmResidualPass` (×2) | `llmCategorizationPass.ts:183,199,233,252` | `company_id` on every one. OK |
| …its auto-post sweep | `autoPostGateService.ts:150,167,253,278` | `company_id` on every one. OK |
| `recalculateNudge` (×2) | `flowWalletService.ts:574-600` | `WHERE company_id = $1`. OK |
| `fireWebhook` | see LOW-2 | endpoint SELECT scoped; the two endpoint UPDATEs now scoped too |
| `checkAndAlert` | `healthAlertService.ts:26,45,61` — `admin_settings` only | Platform-global table, no tenant column and no tenant meaning. Correct as-is; drained from `withAdmin`. |
| the three above | | fixed |

## LOW-2 — `webhookService.ts` `fireWebhook`, the floating IIFE

`fireWebhook` was `async` but its whole body sat in `void (async () => { … })()`, so its
`INSERT INTO webhook_deliveries` and `UPDATE webhook_endpoints` — both **after** an outbound
`safeFetch` — always ran detached, whatever the caller did. That is R-075's shape exactly, and it was
absent from round 1's census tables. Safe today only because its single caller
(`emailNotificationService.ts:115`) was converted; a second caller under `withAuth` would have
reopened it silently.

**Converted, not just documented.** The IIFE is gone: the body already swallows every error, so the
function is safe to await, and detachment is now the *caller's* decision — `runAfterCommit` inside a
request, a plain un-awaited call outside one. Its two endpoint UPDATEs also gained
`AND company_id = $n` (the id is derived from a scoped SELECT, but the invariant is the invariant).
Census row:

| Site | Disposition |
|---|---|
| `src/modules/.../core/webhookService.ts:98` (`fireWebhook`) | **Converted** — no longer self-detaching; awaitable, so a caller under a request transaction can hold or defer it. Sole caller reaches it through `runAfterCommit`. |

## Round-2 tests

- `tests/integration/r075-callback-tenant-scope.int.test.ts` (6) — each of the three callbacks, in
  **both directions**: given another company's scope it writes nothing; given its own it still
  writes. Real `isaflow_schema_fixture` rows for two companies; only the OCR/VLM boundary is mocked.
- `tests/unit/services/fireWebhookAwaitable.test.ts` (3) — the post-fetch writes have been issued by
  the time `await fireWebhook(...)` resolves; the endpoint UPDATE binds the company (checked on the
  bound values, not the query text); it still never throws to the caller.

### Round-2 mutations

| # | Mutation | Result |
|---|---|---|
| M9 | `bank_transaction_attachments` UPDATE back to bare id | 1 failed |
| M10 | `company_documents` UPDATE back to bare id | 1 failed |
| M11 | `procurement_documents` UPDATE back to bare id | 1 failed |
| M12 | `webhook_endpoints` UPDATE back to bare id | 1 failed |
| M13 | restore the floating IIFE in `fireWebhook` | 2 failed |

Baseline after restore: 6/6 integration, 3/3 unit; the four mutated files byte-identical to their
backups.

---

# Round 3 — the three LOWs from the blind review of `925c18c5b`

## LOW-1 — the `procurement_documents` fence was not a fence

Round 2's predicate was `AND entity_type = $n AND entity_id = $n`, with both values passed in by
`uploadDocument` — the same values it had just INSERTed into that row. The clauses compare the row's
own columns to themselves, so they can never be false: the callback had **no tenant fence at all**,
and it did not reproduce the policy either. The review is right.

`pg_policies` for `procurement_documents` (`tenant_isolation_via_parent`) is a six-branch disjunction:
`supplier_invoice → sage_supplier_invoices`, `customer_invoice → customer_invoices`,
`supplier_payment → supplier_payments`, `customer_payment → customer_payments`,
`credit_note → credit_notes`, `purchase_order → purchase_orders`, each `EXISTS (p.id = entity_id AND
p.company_id IN (<the user's companies>))`.

`UploadDocumentInput` now carries `companyId` — `pages/api/accounting/documents.ts:141` has it in
scope already and passes it — and the UPDATE is that policy verbatim with the membership subquery
replaced by this request's company. All six branches, so a document whose parent belongs to another
tenant matches nothing. `extractAndStoreDocMetadata`'s signature is `(buffer, mimeType, docId,
companyId)`; the useless `entityType`/`entityId` arguments are gone.

Observation, not changed (outside this fix's scope): `verifyEntityOwnership`
(`documentStorageService.ts:84-94`) — the route's pre-check — covers only five of the six tables; it
omits `purchase_orders`. It fails **closed** (a purchase-order document is refused upload), so it is
not a leak, but it and the policy disagree. Worth its own register item.

## LOW-2 — the success log fired over a zero-row UPDATE

All three callbacks logged `'… stored'` on reaching the end of the function, so a fenced UPDATE that
matched nothing still logged success — measured by the reviewer on a foreign-scope run. That is
precisely the false "extraction complete" that made R-075 invisible in production for however long it
has been live.

All three now `RETURNING id` and branch on the row count: `log.info('… stored')` only when a row was
written, `log.warn('… discarded — … is not this company's', { docId, companyId })` when the fence
matched nothing. Pinned in both directions by the integration test, which now asserts on the log
lines as well as the row.

## LOW-3 — `checkAndAlert` is a third exception the header did not name

`afterCommit.ts`'s header listed the two parent-scoped tables but implied every callback must carry a
tenant predicate. `checkAndAlert` touches only `admin_settings`, which has no `company_id` column and
no tenant meaning. Named in the header as the one genuinely tenant-free shape, and the
log-by-outcome rule from LOW-2 written in beside it, since a fenced statement that matches nothing is
the failure the rule exists to make visible.

## Round-3 mutations

| # | Mutation | Result |
|---|---|---|
| M14 | procurement fence keeps the parent EXISTS but drops the company (`p.company_id IS NOT NULL`) | 1 failed |
| M15 | procurement fence back to round 2's self-referential `entity_type`/`entity_id` clauses | 1 failed |
| M16 | all three callbacks log success unconditionally again | 3 failed |

Baseline after restore: 6/6 integration. M15 failing is the direct proof that round 2's predicate was
not a fence.
