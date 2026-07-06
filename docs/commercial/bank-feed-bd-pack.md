# IsaFlow — Bank-feed BD pack (1-pager)

> **Purpose:** a business-development brief for bank-feed partnerships — what
> IsaFlow needs from an aggregator or direct-bank programme, what it already has,
> and the exact gates a partner must clear. Prepared by agent (Phase 6); **Hein
> owns** all commercial outreach, account creation and contract terms.
>
> **Source of truth:** `docs/wsf-bank-feeds/aggregator-spike.md` +
> `memory/project_differentiation_roadmap` (WS-F). Verified against code
> 2026-07-06.

---

## The ask (one line)

Get IsaFlow **automated live transaction feeds for the SA big-5 banks** (FNB,
Absa, Standard Bank, Nedbank, Capitec) — either by getting listed on a direct
bank feed programme, or via an aggregator that passes our coverage + POPIA gates.

**This is BD, not a build.** The integration is ~3–4 days of additive code once
sandbox access exists (see §5). The real work is commercial: coverage
confirmation and a POPIA operator agreement.

---

## 1. What IsaFlow already has (the baseline the feed improves on)

- **File-import covers all big-5 today.** Parsers for **OFX, CSV, QIF, PDF and
  MT940** (SWIFT — the format Standard Bank BOL / FNB Enterprise / Nedbank
  business export). A live feed removes the manual download step; it does not
  unlock a bank we can't otherwise reach.
- **Provider-abstracted feed layer already in the codebase:**
  `bankFeedService`, `bankFeedConnectionService`, `bankFeedOAuthService`,
  `bankFeedSyncService`, plus `openBankingService` / `openBankingConnectionService`
  / `openBankingSyncService`. The `Provider` type
  (`src/modules/accounting/services/bank/openBankingTypes.ts`) already enumerates
  `manual_csv | basiq | tink | plaid | extension` — adding a new provider key is
  additive.
- **4-tier smart matching + rules engine** already reconciles imported
  transactions with confidence scoring — a live feed plugs straight into it.

**BD implication:** IsaFlow is a *low-integration-risk* partner. The plumbing
exists; a partner is wiring into a working reconciliation engine, not a greenfield.

---

## 2. The SA landscape (verified)

| Channel | Status | Note |
|---------|--------|------|
| **Direct bank feed programmes** | FNB + Standard Bank run direct feed programmes; **Sage is a named target**. | Getting IsaFlow listed is a BD conversation, not a build. This is the cleanest path (bank-authorised, no scraping). |
| **Nedbank direct OAuth API** | The **only genuinely open** big-5 third-party transaction API. | The recommended first *real* feed if aggregators fail the gates — additive `nedbank_api` provider key. |
| **Salt Edge** (aggregator) | Self-serve sandbox, free, no contract. AIS/Account-Information product. | Contracts from Canada/EU → **POPIA operator agreement is a live question**. Pricing is sales-only. |
| **Mono** (aggregator) | Self-serve sandbox; keys in 24–48h. Publishes **ZAR pricing (R603–R12k/mo)**. | African open-banking survivor. Confirm big-5 coverage by name. |
| **Stitch** | **Out.** Pivoted to payments-only (~2021); no data-feed product. | Evaluate only for invoice pay-now rails, not feeds. |
| **truID** | **Deferred.** Sales-gated (no sandbox), seed-stage, built for one-time credit pulls not continuous feeds. | Revisit if it ships a continuous-feed product. |
| **Okra / Mono-Flutterwave / Basiq / Tink / Plaid** | Not SA-viable for big-5 feeds. Okra dead; Plaid/Tink/Basiq have no SA big-5 coverage. | Present in the `Provider` enum as generic stubs only. |

**Regulatory context:** SA has **no open-banking mandate** yet, so aggregators
reach the big-5 mostly via fragile screen-scraping (credential capture). An FSCA
open-banking framework is expected 2026+. Until then, **bank-authorised >
screen-scraping** on reliability.

---

## 3. Hard gates a feed partner MUST clear

A partner is rejected on any hard-gate failure:

1. **Coverage (hard gate):** live transaction + balance data — **not** one-time
   statement pulls — for all five big-5 banks, **confirmed by name in writing**.
2. **POPIA (hard gate):** SA data residency **or** a signed **POPIA operator
   agreement**. Non-negotiable for a SA accounting SaaS holding client financial
   data.
3. **Method (strong preference):** bank-authorised API over screen-scraping.
   Scraping = breakage risk every time a bank changes its login/OTP flow.
4. **Onboarding:** self-serve sandbox cleared + production lead-time ≤ 4 weeks.
5. **Cost:** per-account at pilot scale (5–10 clients) within budget.

---

## 4. Questions to get answered in writing (before any contract)

1. Live transaction **+ balance** data (not one-time pulls) for **FNB, Absa,
   Standard Bank, Nedbank, Capitec** — state each individually.
2. Per bank: **bank-authorised API or screen-scraping**? Measured connector
   uptime over the last 6 months?
3. **Refresh cadence** + per-account / per-call cost.
4. **Data residency** + will you sign a **POPIA operator agreement**?
5. **KYB** requirements + realistic time-to-live for a SA business.
6. **Breakage SLA:** when a bank changes its flow and a connector breaks, fix
   turnaround + customer-notification process.

---

## 5. What Hein does vs what the agent does

| Step | Owner |
|------|-------|
| Create Salt Edge / Mono **sandbox** accounts (KYB / business details) | **Hein** (agent cannot create accounts) |
| Approach FNB / Standard Bank direct-feed programmes | **Hein** |
| Sign any contract / POPIA operator agreement | **Hein** |
| Run `scripts/wsf-aggregator-probe.ts` once env vars exist → YES/NO per big-5 | agent |
| Draft the coverage-confirmation emails (from §4) | agent |
| Build the sync adapter once a winner is chosen (~3–4 days) | agent |

**Env vars to hand the agent after sandbox signup:** `SALTEDGE_APP_ID` +
`SALTEDGE_SECRET`, and/or `MONO_SECRET_KEY`. The probe then lists each vendor's
**South Africa** institutions and prints YES/NO for the big-5 automatically.

---

## 6. Integration shape (when a winner is chosen)

Additive, behind the existing abstraction:

1. Add a provider key (`'saltedge'` / `'mono'` / `'nedbank_api'`) to `Provider`.
2. Implement a sync adapter behind `bankFeedSyncService` mapping the vendor's
   transaction shape → `ParsedBankTransaction` (same target as the file parsers).
3. Wire consent/OAuth through the existing `bankFeedOAuthService` +
   `pages/api/bank-feeds/connect.ts` + `callback.ts`.

**Estimate:** ~3–4 days of code once sandbox access exists. The cost is the
commercial/coverage spike, not the build.

---

## 7. Recommendation

- **Primary:** pursue the **FNB / Standard Bank direct feed programmes** (Sage is
  already a target — ask for the same) — cleanest, bank-authorised, no scraping.
- **If aggregators are needed:** run the probe on **Mono** first (publishes ZAR
  pricing, SA-native) and **Salt Edge** (broad coverage but interrogate POPIA
  residency hard). Reject on any hard-gate failure.
- **If both aggregators fail coverage/POPIA:** stay on file-import for the pilot
  and build the **Nedbank direct OAuth adapter** as the first real feed. Revisit
  aggregators when the FSCA open-banking framework lands.

---

*Last updated 2026-07-06 (Phase 6). Facts verified against
`docs/wsf-bank-feeds/aggregator-spike.md` and the bank-feed services in
`src/modules/accounting/services/bank/`.*
