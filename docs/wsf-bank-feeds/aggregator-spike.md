# WS-F — Bank-feed aggregator spike (Salt Edge + Mono)

Goal: decide whether a paid aggregator is worth adding for *automated* SA big-5 feeds, on top of the file-import baseline (OFX/CSV/QIF/PDF/MT940) that already covers all big-5 today. The single blocker is **named big-5 coverage confirmation** — neither vendor publishes it.

Stitch is out (it pivoted to payments-only ~2021). truID is deferred: sales-gated (no sandbox), seed-stage, and built for one-time credit-underwriting pulls, not continuous feeds.

## What only you can do (account creation — I can't)
Creating accounts + entering business/KYB details is yours. Each is **self-serve sandbox, free, no contract**:

### Salt Edge
1. Sign up: https://www.saltedge.com/ → "Get API keys" / dashboard registration (Account Information / AIS product, **not** Payment Initiation).
2. In the dashboard, create a **Test** app. Copy `App-id` and `Secret`.
3. Provide them to me as env vars: `SALTEDGE_APP_ID`, `SALTEDGE_SECRET`.
4. Docs: https://docs.saltedge.com/account_information/v5/

### Mono
1. Sign up: https://mono.co/ → dashboard (keys typically issued within 24–48h).
2. Copy the **test** secret key.
3. Provide it as `MONO_SECRET_KEY`.
4. Docs: https://docs.mono.co

Hand me any of those env vars and I run `scripts/wsf-aggregator-probe.ts` (below) — it lists each vendor's **South Africa** institutions and prints YES/NO for FNB, Absa, Standard Bank, Nedbank, Capitec automatically.

## Coverage-confirmation questions to email each vendor
Before any paid contract, get these answered **in writing** (the probe confirms sandbox coverage; these confirm production + reliability):

1. Do you provide **live transaction + balance data** (not just one-time statement pulls) for these five SA banks, by name: **FNB, Absa, Standard Bank, Nedbank, Capitec**? State each individually.
2. For each: is the connection a **bank-authorised API** or **screen-scraping** (credential capture)? What is your measured uptime per connector over the last 6 months?
3. **Refresh cadence**: how often can we pull per connected account (daily? on-demand?) and what is the per-account/per-call cost?
4. **Data residency**: where is SA customer financial data processed/stored? Do you sign a **POPIA operator agreement**? (Salt Edge contracts from Canada/EU — this is a live POPIA question.)
5. Production onboarding: KYB requirements + realistic time-to-live for a SA business. (Stitch was dropped over onboarding friction — quantify it.)
6. What is the **breakage SLA**: when a bank changes its login/OTP flow and a scraped connector breaks, what's your fix turnaround + customer notification?

## Decision criteria (pick the winner)
Score each vendor:
- **Coverage**: all 5 big-5 confirmed by name (hard gate — fail = reject).
- **Method**: bank-API > screen-scraping (scraping = fragility risk).
- **POPIA**: SA residency or signed operator agreement (hard gate for a SA accounting SaaS).
- **Onboarding**: self-serve sandbox cleared (both pass) + production lead-time ≤ 4 weeks.
- **Cost**: per-account at pilot scale (5–10 clients) within budget. Mono publishes ZAR pricing (R603–R12k/mo); Salt Edge is sales-only.

Recommendation if **both** fail the coverage/POPIA gates: stay on file-import for the pilot, add the **Nedbank direct OAuth API** (the only genuinely open big-5 bank API) as the first real feed, and revisit aggregators when SA open-banking regulation lands (FSCA framework, 2026+).

## Integration shape (when a winner is chosen)
The bank-feed layer is already provider-abstracted: `Provider = 'manual_csv' | 'basiq' | 'tink' | 'plaid' | 'extension'` (`src/modules/accounting/services/bank/openBankingTypes.ts`). Adding the winner is **additive**:
1. Add a provider key (e.g. `'saltedge'` / `'mono'` / `'nedbank_api'`) to `Provider`.
2. Implement a sync adapter behind `bankFeedSyncService` that maps the vendor's transaction shape → `ParsedBankTransaction` (same target as the file parsers).
3. Wire the consent/OAuth flow through the existing `bankFeedOAuthService` + `pages/api/bank-feeds/connect.ts` + `callback.ts`.
Estimate: ~3–4 days of code once sandbox access exists; the real cost is the commercial/coverage spike, not the build.
