# ABSA scraper fixtures

PII-scrubbed samples captured 2026-04-29 from a live ABSA Business Banking session via the Playwright MCP. Used by the `chrome-extension/bank-connector/` ABSA scraper unit tests.

## Endpoints captured

| File | Endpoint | Notes |
|---|---|---|
| `balance-enquiry-response.json` | `POST /axob/BalanceEnquiryFacadeGetAllBalances.exp` | Returns `accountList[]` — one row per linked bank account. Mapped to `BankScraper.listAccounts()`. |
| `transaction-history-request.json` | `POST /axob/TransactionHistoryFacadeGetTransactionHistory.exp` | Request body shape. Date range capped server-side at 180 days (confirmed via "Date range exceeds 180 days" error). |
| `transaction-history-response.json` | same as above | `transactionHistory.accountHistoryLines[]` is the list of transactions. Mapped to `ParsedBankTransaction`. |
| `archived-statement-list-response.json` | `POST /axob/ArchivedStatementFacadeGetArchivedStatementList.exp` | Older monthly PDF statements. `documentKey` is the download handle. **Not used by v1 scraper** — kept for future PDF-backfill path. |

## Scrubbing rules applied

- Account numbers → `0000000001` / `0000000002`
- Account names → `Test Cheque` / `Test Savings`
- Vendor / counter-party names → `Sample Vendor` / `Inbound Transfer`
- Session tokens (`jsessionid`, `esessionid`, `wfpt`, `xfpt`, `nonce`) → `FIXTURE_*` placeholders
- Source IP → `0.0.0.0`
- Document keys → `FIXTURE_KEY_*`
- Folder names → `FIXTURE_FOLDER`
- Balances and amounts kept verbatim — they're not PII on their own once names are scrubbed.

If you need fresh fixtures, capture a session with `mcp__plugin_playwright_playwright__execute` listening on `response`, run scraper actions in the bank UI, then dump and scrub via the rules above.
