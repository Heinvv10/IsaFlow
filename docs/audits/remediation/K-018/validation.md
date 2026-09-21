# K-018 — Unsupported open-banking providers insert fabricated transactions

**Claim.** Selecting Basiq, Tink or Plaid and syncing writes randomly generated sample
transactions into a real tenant bank account and reports success.

**Corrected trigger.** `syncBankFeed` returns early only for `manual_csv` (openBankingSyncService.ts:161)
and `extension` (:173). Every other provider falls through to `buildSampleTransactions` (:22, called
at :189): 5-10 rows of `Math.random()` amounts between R100 and R5,100, descriptions drawn from two
hardcoded arrays (:19-20), INSERTed into the tenant's `bank_transactions` as `status = 'imported'`
(:71-85). `markSyncComplete` then writes `last_sync_status = 'success'` with an imported count and the
route returns 200. Nothing marks the data as fake.

**Disposition: confirmed.**

**Evidence.** File unchanged 5661d6f0..ebeac9ca. RED integration test, real PostgreSQL, one case per
provider: all three inserted invented rows (e.g. "Telkom invoice" -2459.09, "Client payment"
5020.58) and reported success. 3 failed / 3.

**Reachability.** `POST /api/accounting/bank-feeds` accepts all five providers (Zod enum,
index.ts:21; same allowlist at openBankingConnectionService.ts:48), and `bank_feed_connections`
has no CHECK on `provider`. Then `POST /api/accounting/bank-feeds/[id]/sync`. No UI offers the
three, so the caller is the API — an integration or an agent.

**RED test.** `tests/integration/k018-open-banking-fabricated-transactions.int.test.ts` —
3 failed / 3. Log: `docs/audits/remediation/K-018/red.log`.

**Proposed minimal fix.** Refuse rather than fabricate. Add a guard beside the `extension` branch:
for `basiq | tink | plaid`, call `markSyncFailed` and throw a clear "provider not implemented"
error, and delete `buildSampleTransactions` and the `StubTransaction` type with it — leaving a stub
generator in the file is how it gets reached again. Narrowing the Zod enum and the service allowlist
to the two implemented providers closes the door at creation time as well.

**Historical-data impact.** Fabricated rows are identifiable by their `bank_reference` prefix and
survive in any tenant that ever synced one of these providers. Read-only:
```sql
SELECT bt.company_id, count(*) AS fake_rows, min(bt.transaction_date), max(bt.transaction_date),
       count(*) FILTER (WHERE bt.status <> 'imported') AS already_actioned
  FROM bank_transactions bt
 WHERE bt.bank_reference ~ '^(basiq|tink|plaid)-stub-'
 GROUP BY 1;
```
Any row not still `imported` has been reconciled or posted to the GL and needs reversal, not just
deletion.

**Risks.** Low. No test imports `buildSampleTransactions`; the only unit test on this service
covers the `extension` early return and the IDOR guard.
