# K-018 — fix

**Trigger.** Sync on a `basiq`/`tink`/`plaid` bank-feed connection. `syncBankFeed` returned early only for `manual_csv` and `extension`; everything else fell through to `buildSampleTransactions`.

**Before.** 5–10 rows of `Math.random()` amounts (R100–R5,100) with descriptions off two hardcoded arrays were INSERTed into the tenant's `bank_transactions` as `status='imported'`; the sync log and connection were marked `success` and the route returned 200. Nothing marked the rows fake, and they feed reconciliation, bank rules and allocation.

**After.** Those providers are refused: `markSyncFailed` records the reason, then `syncBankFeed` throws the typed `BankFeedProviderNotImplementedError`. The route catches it and answers 400, so `withAuth` COMMITs (it only ROLLBACKs on >= 500) and the failed sync log plus `last_sync_status='failed'` and `last_sync_error` are durable; the Bank Feeds page reads `error.message` off that envelope and shows the reason. The generator, its `StubTransaction` type, the description arrays and the orphaned `insertTransaction` are deleted. The create-connection Zod enum, `createBankFeedConnection`'s allowlist and the UI provider picker narrow to `manual_csv | extension`. Legacy basiq/tink/plaid cards render a "not supported" notice with Sync disabled.

**Files.** `openBankingSyncService.ts` (−110/+8), `openBankingConnectionService.ts`, `openBankingService.ts` (header), `pages/api/accounting/bank-feeds/index.ts`, `AddConnectionModal.tsx`, two `.claude.md` files + `AGENTS.md` mirrors.

**Tests.** `tests/integration/k018-open-banking-fabricated-transactions.int.test.ts` — 12 on real PostgreSQL (3 validator cases, durable 400 refusal read after COMMIT, typed error, 3x retry, wrong-tenant sync, 3 creation refusals, 2 implemented providers unchanged). `tests/unit/services/bankFeedSyncRouteRefusal.test.ts` — 5, real route + real service over a mocked SQL layer. `tests/unit/components/bankFeedUnsupportedProvider.test.tsx` — 5 (components config). `tests/unit/services/openBankingSyncService.test.ts` — 2, unchanged. Mutation checks in `green.log`: reverting the service turns 7 of the integration tests RED, reverting the route's catch turns 3 route tests RED. `tsc --noEmit` and `eslint` clean.

**Migration / rollback.** None. Revert the commit to restore prior behaviour.

**Historical-data impact.** Fabricated rows survive in any tenant that synced these providers. Read-only, NOT run on production:
```sql
SELECT bt.company_id, count(*) AS fake_rows,
       min(bt.transaction_date), max(bt.transaction_date),
       count(*) FILTER (WHERE bt.status <> 'imported') AS already_actioned
  FROM bank_transactions bt
 WHERE bt.bank_reference ~ '^(basiq|tink|plaid)-stub-'
 GROUP BY 1;
```
Any row not still `imported` was reconciled or posted to the GL and needs reversal, not deletion. This fix stops new fabrication; it cleans up nothing.

**Limits.** Legacy `basiq`/`tink`/`plaid` connection rows stay — no migration deactivates them; the card now disables Sync and labels them not supported. `bank_feed_connections.provider` has no DB CHECK, so direct SQL can still create one. The `Provider` union keeps all five values so existing rows map. The integration test keys on `bank_reference LIKE '<provider>-stub-%'`, so it would not catch a future generator using a different prefix.
