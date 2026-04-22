# ISaFlow Third-Party Integrations Roadmap

> Drafted: 2026-04-21
> Scope: external APIs that IsaFlow needs to integrate with, beyond what is already live.
> Companion to `docs/prd/ROADMAP.md` (feature modules).

---

## 1. Current Integration Landscape

### Live in production

| Service | Category | Used for |
|---------|----------|----------|
| **Stitch.money** | Bank feeds (legacy) | OAuth + GraphQL `user.bankAccounts` query. **⚠️ See §2.5 — Stitch has pivoted to payments; bank-feed product is not a strategic go-forward bet.** |
| **PayFast** | Payments | Customer invoice payment links |
| **Netcash** | EFT payments | Supplier EFT batches (falls back to mock when no key) |
| **Signum** | E-signature | AFS partner signing, client portal approvals |
| **Anthropic Claude** | LLM | AFS note generation, narrative synthesis |
| **vLLM (self-hosted)** | Vision OCR | Invoice / receipt / statutory document extraction |
| **Nodemailer (SMTP)** | Email | Transactional mail (invoices, statements, reminders) |
| **Sentry** | Error tracking | Tenant-tagged errors, PII scrubbed, sourcemaps |
| **Neon** | Database | Serverless Postgres primary store |
| **Sage (file-based)** | Migration | CSV/Excel imports — GL, AP, AR, contacts |

### Stubbed (env var or schema only, no real calls)

| Service | State | Blocker |
|---------|-------|---------|
| **Stripe** | `stripe_customer_id` columns exist | No SDK usage, no checkout, no webhooks |
| **Resend** | `RESEND_API_KEY` env var | SMTP is primary; Resend path never wired |
| **Basiq / Tink / Plaid** | Code paths exist | Returns mock transactions; no real keys |
| **CIPC annual returns** | Filing guide checklist | No submission endpoint, no auth to CIPC eServices |

---

## 1.5 SA Bank Feed Provider Analysis (2026)

**Context:** Bank feeds are IsaFlow's #1 daily-use data source — they drive reconciliation, cash-flow, VAT matching, and AFS cash flow statements. The initial roadmap listed Stitch.money as the open-banking provider, but a market scan confirms Stitch has repositioned as a **payment gateway** (Capitec Pay, Pay-by-Bank, DebiCheck, VRP) and no longer markets bank-data aggregation as a core product. IsaFlow's Stitch integration still works via legacy GraphQL endpoints but there is no public roadmap or support commitment for the data product.

**Action needed:** Replace Stitch as the primary bank-feed provider and design a multi-source strategy. The practical 2026 landscape:

### Option A — Direct bank APIs (most reliable, requires per-bank onboarding)

| Bank | API Product | Coverage | Pricing | Notes |
|------|-------------|----------|---------|-------|
| **FNB** | Bank Feed API / Integration Channel | FNB business + retail | Free for Sage-partnered; others negotiate | Non-exclusive, publicly documented. Covers ~25% of SA SME market. Requires formal partnership application. |
| **Nedbank** | API Marketplace (Accounts API) | Nedbank retail + business | Marketplace tiers | First SA bank with public open-banking-style marketplace. |
| **Investec** | Programmable Banking API | Private Bank clients only | Free to customers | Developer-friendly; narrow demographic (high-net-worth) but strong brand signal. |
| **Capitec** | Capitec Pay | Payments only, **not data** | — | Data aggregation not exposed; only payment initiation. |
| **Standard Bank** | Developer Portal | Limited; mostly B2B/corporate | Bespoke | Most SME access is via aggregators, not direct. |
| **ABSA** | Absa Pay + limited data | Payments primary | Bespoke | Similar story to Standard Bank. |

**Verdict:** Direct APIs for **FNB + Nedbank + Investec** give us ~60-70% of the SA SME market with official, sanctioned, high-quality feeds. Capitec, Standard Bank, ABSA, Discovery need the aggregator route.

### Option B — Aggregator platforms (single integration, variable coverage)

| Provider | SA Coverage | Model | Notes |
|----------|-------------|-------|-------|
| **TrueID** | All major SA banks (claimed) | API platform, SA-based | Local SA open-finance startup. Claimed unified access across tier-1 banks. Smaller than Plaid/Tink but actually SA-focused. **Best aggregator candidate for IsaFlow.** |
| **Mono.co** | 7 SA financial institutions (beta) | Subscription API | Pan-African (Nigeria-primary). SA support still maturing; may not cover all tier-1s. |
| **Yodlee** | Historical (Nedbank MyFinancialLife, Pastel My Money) | Credentials-based scraping | Works but is screen-scraping, not true open banking — fragile when banks add MFA/2FA (Capitec and Investec already blocked it historically). Strategic dead end. |
| **Finch Technologies (Gathr)** | SA-focused, KYC/verification-centric | API platform, Cape Town | Not primarily a bank-feed product — stronger on identity, proof of address, income verification. Possible KYC partner, not feed provider. |
| **Plaid / Tink / TrueLayer** | Listed but SA coverage is not native | Would need partnership | Primarily US/UK/EU; SA remains a gap. |
| **Stitch.money** | Legacy `user.bankAccounts` still available | OAuth + GraphQL | Works today; unclear future. Keep as legacy fallback; do not invest further. |

### Option C — File-based / statement import (fallback, already shipped)

- **CSV / OFX / MT940** — already supported in IsaFlow.
- **PDF statement parsing** (vLLM + bank-specific regex) — already shipped for ABSA, FNB, Nedbank, Standard Bank, Capitec.
- **DEA IDX / EasyDebit** — commercial instant-statement services used in credit/underwriting; possible fallback for onboarding one-off imports.

### Recommended bank-feed strategy

**Phase 1 (6w):** FNB Bank Feed API + Nedbank API Marketplace → covers largest SA SME + retail base with official feeds.

**Phase 2 (4w):** Evaluate + integrate **TrueID** as the aggregator for Capitec, Standard Bank, ABSA, Discovery, Investec. Scope contingent on sandbox access + coverage validation.

**Phase 3 (3w):** Investec direct API — nice-to-have for brand signal; small customer base.

**Legacy:** Deprecate the Stitch.money bank-feed path once FNB + Nedbank are live. Leave Stitch payments open as a separate consideration (VRP / Capitec Pay may have value for IsaFlow's collections module).

---

## 2. Priority Tiers

### P0 — Compliance / revenue blocking

| # | Integration | Why | Effort |
|---|-------------|-----|--------|
| 1 | **SARS eFiling API** (VAT201 / EMP201 / EMP501 / IRP5 / IT14) | Payloads are all built but never submitted — every client exports PDF and manually files. Core compliance gap. | 6–8w |
| 2 | **Bank feed replacement — FNB + Nedbank direct APIs** | Stitch is deprioritising its bank-data product (see §1.5); FNB + Nedbank direct APIs cover ~50% of SA SME base with official feeds. Without a strategic replacement, IsaFlow's reconciliation workflow degrades as Stitch's legacy endpoints age. | 6w |
| 3 | **Stripe billing** | IsaFlow itself can't self-serve subscriptions. Schema ready. Directly monetises. | 4w |
| 4 | **AWS S3 / Cloudflare R2** | AFS PDFs, invoices, payslips on local FS — no POPIA-grade archival, no backup, not portable across compute nodes. | 2–3w |

### P1 — High user value / unlocks differentiation

| # | Integration | Why | Effort |
|---|-------------|-----|--------|
| 5 | **TrueID aggregator** (Capitec, Standard Bank, ABSA, Discovery) | Covers remaining ~40% of SA SME base not served by FNB/Nedbank direct APIs. Local SA provider, better-aligned than Plaid/Tink. | 4w |
| 6 | **OpenAI / extended Claude usage** for bank rule + COA suggestions | Claude is only used for AFS today. Bank-rule AI saves accountants 2–3 hrs/month — highest UX leverage point. | 3–4w |
| 7 | **AWS Textract / Google Document AI** | vLLM + regex is ceiling. Production-grade OCR lets us match Dext/Hubdoc automation. | 3w |
| 8 | **CIPC Lookup + SARS VAT status check** | Verify company registration, director names, VAT number at onboarding. Currently fully manual. | 2–3w |
| 9 | **DirectID / bank-account verification** | Instant bank account verification (supplier payments, customer refunds). Could also be fulfilled by Finch Technologies Gathr. | 2w |
| 10 | **Clickatell / BulkSMS** | No SMS today for payment reminders, approvals, OTP. Pairs with collections module. | 2w |
| 11 | **Investec Programmable Banking API** | Small audience but strong brand signal; developer-friendly and free to customers. | 2w |

### P2 — Nice-to-have / market expansion

| # | Integration | Why | Effort |
|---|-------------|-----|--------|
| 9 | **Peach Payments / Yoco / Ozow** | Payment gateway alternatives to PayFast. | 3w each |
| 10 | **WhatsApp Business API** | Customer/supplier messaging — popular in SA SME segment. | 3w |
| 11 | **Xero / QuickBooks live API sync** | Live data sync for clients migrating in (not just CSV one-shot). | 4w |
| 12 | **OpenExchangeRates / Frankfurter** | Multi-currency GL — currently single-ZAR ledger. | 2w |
| 13 | **DocuSign** | Non-AFS document signing (contracts, supplier agreements). | 2w |
| 14 | **TransUnion / Experian / XDS** | Customer/supplier credit bureau checks. | 3w |
| 15 | **Posthog / Plausible** | Product analytics — feature usage, cohorts, funnel tracking. | 1w |
| 16 | **Google Maps / PostNet** | SA address validation, postal code lookup. | 1w |
| 17 | **SimplePay / PaySpace / Sage Payroll** | Payroll-side imports from competing products. | 3w each |
| 18 | **SAICA member lookup** | Validate accountant credentials on practice signup. | 1w |
| 19 | **LexisNexis / Truid / Smile Identity / DocFox** | SA KYC/AML onboarding. | 3w each |

---

## 3. Roadmap Options

### Option A: Compliance-First (recommended)

**Rationale:** SARS eFiling closes the biggest compliance gap in the product — every VAT201/EMP201 client today must leave IsaFlow to file. Ship this and IsaFlow becomes end-to-end. Stripe runs alongside because it's small and monetises existing traffic.

```
Q2 2026 (May → Jul)
  ├── Stream A: SARS eFiling API              (7w) — P0
  │     Phase 1: mTLS cert + OAuth flow       (2w)
  │     Phase 2: VAT201 submission            (2w)
  │     Phase 3: EMP201 / EMP501 / IRP5       (2w)
  │     Phase 4: Resubmission queue + UI      (1w)
  ├── Stream B: Bank feed replacement         (6w) — P0
  │     Phase 1: FNB Bank Feed API            (3w)
  │     Phase 2: Nedbank API Marketplace      (3w)
  │     (runs partly in parallel with SARS    cert-provisioning waits)
  └── Stream C: Stripe billing                (4w) — P0
        Phase 1: SDK + plans mapping          (1w)
        Phase 2: Checkout + webhooks          (2w)
        Phase 3: Dunning + admin UI           (1w)

Q3 2026 (Aug → Oct)
  ├── TrueID aggregator integration           (4w) — P1
  ├── AWS S3 / R2 storage migration           (3w) — P0
  ├── OpenAI bank rule suggestions            (4w) — P1
  └── AWS Textract OCR upgrade                (3w) — P1

Q4 2026 (Nov → Jan 2027)
  ├── Investec direct API                     (2w) — P1
  ├── CIPC + SARS VAT verification            (3w) — P1
  ├── DirectID bank verification              (2w) — P1
  ├── Clickatell SMS gateway                  (2w) — P1
  ├── Deprecate Stitch legacy feed path       (1w)
  └── WhatsApp Business API                   (3w) — P2
```

### Option B: Revenue-First

**Rationale:** If the immediate goal is monetisation + top-of-funnel conversion, Stripe + AI + analytics land first. SARS shifts to Q3.

```
Q2 2026
  ├── Stripe billing                      (4w)
  ├── OpenAI bank rule suggestions        (4w)
  └── Posthog analytics                   (1w)

Q3 2026
  └── SARS eFiling API                    (7w)
  └── AWS Textract OCR                    (3w)

Q4 2026
  └── CIPC + DirectID + SMS               (7w)
```

### Option C: Parallel Streams (needs 2 engineers)

```
Q2 2026:
  Stream A → SARS eFiling (Phases 1-2)
  Stream B → Stripe billing (full)

Q3 2026:
  Stream A → SARS eFiling (Phases 3-4)
  Stream B → S3 + OpenAI bank rules

Q4 2026:
  Stream A → CIPC + DirectID
  Stream B → Textract + SMS + WhatsApp
```

---

## 4. Integration Dependency Graph

```
SARS eFiling ── requires ──▶ S3 (for signed PDF archival of submissions)
                └── requires ──▶ Sentry alerts (submission failure visibility — ✅ done)

Stripe billing ── requires ──▶ Admin platform (✅ done)
                 └── feeds ──▶ Dunning emails via SMTP (✅ done)

OpenAI bank rules ── requires ──▶ Bank feeds (Stitch, ✅ done)
                   └── feeds ──▶ Bank Recon UI (✅ done)

Textract ── requires ──▶ S3 (cloud storage for doc pipeline)
         └── replaces ──▶ vLLM + regex fallback

CIPC lookup ── feeds ──▶ Company onboarding wizard
            └── feeds ──▶ AFS cover page (director names, reg number)

DirectID ── feeds ──▶ Supplier master (account verification before first payment)
         └── feeds ──▶ Customer refund flow

SMS / WhatsApp ── feeds ──▶ Collections module (AR reminders)
                └── feeds ──▶ Approval workflows
```

**Critical path:** S3 must land before Textract and before SARS archival. Stripe is fully independent. OpenAI only needs Stitch (already live).

---

## 5. Env Vars to Provision

### Already configured
```
STITCH_CLIENT_ID, STITCH_CLIENT_SECRET, STITCH_REDIRECT_URI
PAYFAST_MERCHANT_ID, PAYFAST_MERCHANT_KEY, PAYFAST_SANDBOX
SIGNUM_API_URL, SIGNUM_API_KEY, SIGNUM_WEBHOOK_SECRET
ANTHROPIC_API_KEY
SENTRY_DSN, SENTRY_AUTH_TOKEN
SMTP_HOST, SMTP_USER, SMTP_PASS
VLLM_BASE_URL, VLM_MODEL, VLLM_API_KEY
DATABASE_URL
VF_STORAGE_URL
```

### To add (P0–P1)
```
SARS_EFILING_URL
SARS_CERT_PATH, SARS_CERT_PASSPHRASE        # mTLS
SARS_CLIENT_ID, SARS_CLIENT_SECRET           # OAuth

STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
STRIPE_PUBLISHABLE_KEY

OPENAI_API_KEY

AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
AWS_REGION, AWS_S3_BUCKET

TEXTRACT_REGION                              # if split from S3 region

CIPC_API_KEY
DIRECTID_API_KEY, DIRECTID_CLIENT_ID

CLICKATELL_API_KEY   # or BULKSMS_USERNAME / BULKSMS_PASSWORD
```

### To add (P2)
```
WHATSAPP_BUSINESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID
OPENEXCHANGERATES_APP_ID
POSTHOG_API_KEY, POSTHOG_HOST
TRANSUNION_API_KEY   # or EXPERIAN_API_KEY
GOOGLE_MAPS_API_KEY
```

---

## 6. Risk & Compliance Notes

| Integration | Risk | Mitigation |
|-------------|------|------------|
| SARS eFiling | mTLS cert rotation; payload schema changes per tax year | Per-tax-year payload version table; cert expiry alerts in Sentry |
| Stripe | PCI scope creep if we touch card data | Use Stripe Elements / Checkout only — never store PAN |
| S3 | POPIA — cross-border data transfer | Use `af-south-1` (Cape Town region); SSE-KMS at rest |
| OpenAI | Client data leakage to third-party LLM | Redact PII before send; use ZDR endpoints; opt-out of training |
| DirectID | Consent capture for bank account lookups | Log consent with timestamp + user + IP per POPIA |
| CIPC | Rate limits on lookup endpoints | Cache company info for 30 days; async enrichment queue |
| WhatsApp | Template approval delays (Meta) | Submit templates 2 weeks before go-live |

---

## 7. Open Questions

1. **SARS eFiling ISV certification** — does IsaFlow qualify as an ISV already, or do we register? (Affects timeline by 4–6 weeks if registration is required.)
2. **FNB partnership application** — FNB bank-feed API is non-exclusive but requires formal partnership; what's the lead time for approval? Is there a revenue-share or flat fee?
3. **TrueID sandbox access** — can we get a trial to validate actual bank coverage + feed quality before committing? Are Capitec and Investec actually delivered through it, or is that marketing claim?
4. **Stitch.money roadmap** — do they plan to sunset the legacy data API? If yes, when? Determines how urgent Phase 1 is.
5. **Stripe vs local alternative** — Stripe charges ZAR but settles to USD-denominated accounts in SA; is PayFast subscriptions a viable ZAR-native alternative?
6. **Cloud region for S3** — Cape Town (`af-south-1`) for POPIA, or US/EU for cost? Latency impact on PDF generation?
7. **Bank rule AI — Claude vs OpenAI** — we already pay Anthropic for AFS; reuse the same vendor or multi-vendor for redundancy?
8. **Which SMS provider** — Clickatell (established SA), BulkSMS (cheaper), or Twilio (global but poorer ZA delivery)?

---

## 8. Recommendation

Go with **Option A (Compliance-First)**, and start with **two parallel tracks in Q2 2026**:

- **Track 1 (senior eng):** SARS eFiling — 7 weeks, compliance-critical
- **Track 2 (mid eng):** Stripe billing — 4 weeks, pure revenue unlock

Then a sequential Q3:
- S3 migration (unblocks Textract + SARS archival)
- OpenAI bank rules (highest user-value win)

Revisit Q4 scope at end of Q3 based on adoption signals from Stripe + SARS.
