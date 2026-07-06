# SARS eFiling ISV Integration for VAT201 — Technical & Commercial Dossier

**Prepared for:** Hein (Founder, IsaFlow) — to register IsaFlow as a SARS-approved Independent Software Vendor (ISV) able to submit VAT201 returns directly from the product.
**Date:** 2026-07-06 · **Phase:** A–Z programme P4.1 · **Status of the build:** P4.2 ships the env-gated channel (dark until Hein onboards); this dossier is what Hein acts on to light it up.
**Method:** primary SARS sources first, then vendor + Big-4/tax-tech secondary sources. Non-obvious claims carry an inline source + date. Anything unconfirmed online is labelled **UNVERIFIED**.

---

## 0. TL;DR — what this means for IsaFlow

1. **SARS ISV integration is TWO-TIER.**
   - **Tier 1 (vendor onboarding):** IsaFlow signs SARS's *ISV Systems Interface Terms & Conditions*, passes SARS acceptance testing, and is switched on. The reward: **"IsaFlow" appears in the eFiling *ISV Activation* dropdown**, exactly like Sage/Xero/Konsise today. The VAT201 wire spec is released **only after** this step (relationship/NDA-gated — not public).
   - **Tier 2 (per-taxpayer activation):** each client runs *Organisations → ISV Activation* in their own eFiling profile, selects IsaFlow, and gets a **login name + login key** they paste into IsaFlow. That shared secret authorises IsaFlow to submit on their behalf.
2. **The activation-key mechanism is still live in 2026** — not replaced by OAuth or the separate "Third Party Data" bulk channel. Verified against current Xero, Sage, and Konsise docs.
3. **What IsaFlow already has (P4.2):** an env-gated submit channel (`sarsEfilingConfig/Client/Repo/SubmissionService`), a submission audit log (migration 504), submit/poll API routes, and the **exceptions gate differentiator** — the server refuses to file a VAT201 unless the pre-filing exceptions report is clean. It is contract-tested against a mock ISV server and is **dark by default**. (This lands in PR #214, pending merge to master — not yet in production.)
4. **What is blocked on Hein (commercial/legal):** signing the SARS ISV T&Cs, obtaining the real VAT201 interface spec, passing acceptance testing, and getting IsaFlow into the eFiling dropdown. Only then does the provisional wire format get reconciled to reality and the channel armed in production.

---

## 1. SARS eFiling ISV programme — registration & activation-key mechanism (2026)

### 1a. Registering as an ISV

SARS runs a formal but low-key ISV programme ([SARS "Independent Software Vendors", accessed 2026-07-06](https://www.sars.gov.za/individuals/i-need-help-with-my-tax/your-tax-questions-answered/independent-software-vendors/)). The public entry point is minimal: **complete and sign the "ISV Systems Interface Terms and Conditions" and email the signed copy to the SARS ISV mailbox** (widely cited as **isv@sars.gov.za** — **UNVERIFIED**, confirm on the live page). For Tax Directives specifically SARS also requires form **INF001** + spec IBIR-006; whether an equivalent extra form is needed for VAT201 is **UNVERIFIED**.

The governing contract is the **ISV Systems Interface Terms & Conditions (v3, 21 June 2017)** ([SARS PDF](https://www.sars.gov.za/wp-content/uploads/Docs/InterfaceSpecs/Final-v3-ISV-Systems-Interface-Terms-and-Conditions-21-June-2017.pdf), read in full). Material clauses:

- **3.1–3.2** — Authorisation is at SARS's sole discretion, requires passing **SARS acceptance testing**, and **production activation needs SARS's prior written approval** after that testing.
- **3.3.1** — after authorisation the ISV builds the interface "in accordance with the specifications provided by SARS."
- **3.4.2 — commercial gate:** minimum volume targets **per tax type: 1,000 submissions in year 1, 5,000 by year 2, 10,000 by year 3.** SARS may withdraw authorisation for missing them (3.4.3).
- **3.4.4** — authorisation is "not an endorsement" and may not be marketed as one.

**Scarcity signal:** one SA practitioner source states only **~29 entities hold SARS ISV approval** (23 software providers + 6 practitioner firms) ([financialemigration.co.za, 2026](https://www.financialemigration.co.za/how-you-talk-with-sars-is-important-why-a-tax-practitioner-with-its-own-sars-isv-link-matters/)) — single-source, **UNVERIFIED**, but signals a tightly gate-kept programme (a moat once IsaFlow is in).

### 1b. The activation-key / shared-secret mechanism (current, 2026)

The historical **ISV login + per-profile activation key** model is **still live in 2026**. Confirmed by three independent current vendor docs describing the identical flow:

- **Xero** — *Organisations → Organisation → ISV Activation → select Xero → Activate* generates an ISV login name + key; reusable across the profile's authorised organisations. ([Xero Central, accessed 2026-07-06](https://central.xero.com/s/article/Set-up-eFiling-for-VAT-in-Xero))
- **Sage** — *Organisation → ISV activation → choose Sage → copy login key → activate*, then enter Login Name + Login Key into Sage. ([Sage ZA KB, accessed 2026-07-06](https://za-kb.sage.com/portal/app/portlets/results/viewsolution.jsp?solutionid=210702123130000))
- **Konsise** — activate Konsise as the ISV on the eFiling profile; the unique login key is entered into Konsise. ([Konsise, accessed 2026-07-06](https://www.konsise.com/vat201-integration-to-sars-efiling-with-konsise/))

**Mechanism:** taxpayer/practitioner logs into eFiling → *Organisations → ISV Activation* → selects the vendor → eFiling generates a **login name + unique login key (shared secret)** → user pastes both into the product → the product authenticates machine-to-machine to SARS with that secret. **Not OAuth2, not a public token exchange.** SARS's separate **"Third Party Data"** platform (Connect:Direct/HTTPS bulk — IT3/FATCA/CRS/dividends) does **not** carry VAT201.

### 1c. Is there a public developer portal / spec?

Partially. There is a formal *contractual* onboarding (the T&Cs) and per-tax-type interface specs, but **the VAT201 ISV spec is not public** — the only publicly downloadable spec is IBIR-006 (Tax Directives). The T&Cs say specs are "provided by SARS" *after* authorisation (3.3.1). **Conclusion: the VAT201 interface spec is NDA/relationship-gated, released post-onboarding. There is no public self-service sandbox.**

### 1d. Test/sandbox + certification path

A **mandatory acceptance-testing step exists** (T&Cs 3.2.1): production activation requires SARS's prior written approval after acceptance testing, and no interface change is permitted without prior testing + written approval (3.4.5). The specific name/mechanics of the VAT201 ISV test environment are **UNVERIFIED** (communicated to the vendor during onboarding).

---

## 2. VAT201 submission specification

### 2a. Canonical VAT201 fields (transcribed from the official SARS/Treasury VAT201 form, FV V2016)

Source: [Treasury VAT201 form PDF](https://www.treasury.gov.za/research/NT-SDF/Available%20Datasets/Value-Added%20Tax%20-%20VAT%20201%20form.pdf), cross-checked against [SARS GEN-ELEC-04-G01 completion guide](https://www.sars.gov.za/wp-content/uploads/Ops/Guides/GEN-ELEC-04-G01-Guide-for-completing-the-Value-Added-Tax-VAT201-Declaration-External-Guide.pdf).

**Part A — Output tax & imported services**

| Field | Label |
|---|---|
| 1 | Standard rate (excl. capital goods/services) — value; ×15/115 → Field 4 |
| 1A | Standard rate (only capital goods/services) — value; → Field 4A |
| 2 | Zero rate (excl. exported goods) |
| 2A | Zero rate (only exported goods) |
| 3 | Exempt and non-supplies |
| 4 / 4A | Output tax on Field 1 / 1A |
| 5–9 | Accommodation (>28 days, ≤28 days, totals, output tax) |
| 10 / 11 | Change in use & export of second-hand goods / its output tax |
| 12 | Other and imported services (output) |
| **13** | **TOTAL OUTPUT TAX = 4 + 4A + 9 + 11 + 12** |

**Part B — Input tax**

| Field | Label |
|---|---|
| 14 / 14A | Capital goods supplied to you / imported by you (input) |
| 15 / 15A | Other goods & services supplied to you / imported by you (input) |
| 16 | Change in use |
| 17 | Bad debts |
| 18 | Other |
| **19** | **TOTAL INPUT TAX = 14 + 14A + 15 + 15A + 16 + 17 + 18** |
| **20** | **VAT PAYABLE / REFUNDABLE = Field 13 − Field 19** |

(Standard rate 15% since 2018-04-01; Fields 12/18 carry residual 14%-era transactions. Qualifying vendors also have a **Diesel refund** section — its exact field numbers are **UNVERIFIED** from the sources fetched. Header carries VAT ref no., tax period, contact/banking details, declaration.)

> **IsaFlow mapping gap (recorded for the build):** `generateVAT201` currently produces a simplified `field1..field11` set and does **not** split 1A/2A/14A/15A or compute 16/17. The P4.2 client passes the fields map through verbatim; the full Fields-1–20 mapping is done when SARS releases the real spec.

### 2b. Submission channels for third parties

- **eFiling web form** — manual keying, any vendor.
- **ISV activation-key channel (machine-to-machine)** — the channel IsaFlow needs.
- **The exact protocol/format is NOT public** (SOAP vs REST, XML schema vs JSON) — released to accredited ISVs under the T&Cs ("in the format prescribed by SARS", 3.4.1). **UNVERIFIED.**
- **Behavioural evidence it is async/batch:** Konsise states submissions are "queued and processed by SARS between **6 PM and 7 AM nightly**," with email notification ([Konsise](https://www.konsise.com/vat201-integration-to-sars-efiling-with-konsise/)) — implying an overnight batch/async channel, **not** instant synchronous acceptance. *(The P4.2 client is modelled async: submit → correlationId → poll — consistent with this.)*

### 2c. Required identifiers

- **VAT reference: 10 digits starting with "4"** (e.g. 4123456789). ([SARS Register for VAT](https://www.sars.gov.za/types-of-tax/value-added-tax/register-for-vat/)) *(Enforced in `sarsEfilingSubmissionService` — a bad/missing VAT number blocks filing.)*
- **Tax period** by VAT category: **A/B** bi-monthly, **C** monthly, **D** six-monthly (farming), **E** annual ([SARS tax periods](https://www.sars.gov.za/types-of-tax/value-added-tax/tax-periods-for-vat-vendors/)). Wire encoding (likely `YYYYMM` of period-end) **UNVERIFIED**.
- **Authorisation** = the per-profile ISV login name + login key. A separate per-submission PIN is **UNVERIFIED**.

### 2d. Response / acknowledgement model

Async: submit → SARS processes (overnight batch) → success notification → status in-product. On eFiling a VAT201 moves to "Filed through eFiling"; VAT201 is a self-assessment (SARS raises an assessment + Statement of Account). The **machine-readable status enumeration the ISV API returns is UNVERIFIED** (released with the spec). *(P4.2 maps a provisional `accepted|rejected|processing` set to submission statuses; remapped when the real codes land.)*

---

## 3. What competitors expose in their UIs

| Vendor | VAT201 story | Classification |
|---|---|---|
| **Konsise** (SA tax-tech) | Activate Konsise as ISV → paste key → **submit VAT201 directly to SARS in one platform**; overnight processing; status + email confirmation in-product. Whole positioning is SARS-integration-first. | **Direct submit (ISV).** Closest competitor. |
| **Sage** (Accounting/Business Cloud ZA) | Listed ISV; VAT201 wizard populates amounts and "at the click of the submit button automatically uploads to SARS"; prepare/submit/track from within Sage. | **Direct submit (ISV).** |
| **Xero** | Listed ISV; ISV login+key (reusable across orgs); submits VAT201 to SARS and shows filing status/history. GA since a 2020 SARS beta. | **Direct submit (ISV).** |
| **Zoho Books SA** | Generates a VAT201 report "following SARS standards" + VAT audit report + DRC — but submission to eFiling is done **separately by the user**. | **Prepare/report only.** |
| **ZYNO Books** | Markets "integrates directly with SARS eFiling" but gives no ISV-activation mechanics; language reads prepare-then-submit. | **UNVERIFIED — claims direct, no ISV mechanism evidenced.** |

Sources: [Konsise](https://www.konsise.com/vat201-integration-to-sars-efiling-with-konsise/) · [Sage Advice](https://www.sage.com/en-za/blog/sage-eliminates-the-hassle-and-headache-of-vat-201-submissions/) · [Xero Central](https://central.xero.com/s/article/File-a-VAT201-return-with-SARS) · [Zoho Books ZA](https://www.zoho.com/za/books/help/vat/vat201-report.html) · [ZYNO/elitemindz](https://elitemindz.co/products/zynobooks/integrations).

**Takeaway for positioning:** direct submit is table stakes (Konsise/Sage/Xero have it), but **none is evidenced in their public marketing to front-load a pre-filing exceptions gate that blocks a dirty return** (an absence-from-marketing signal, not a proven product gap) — IsaFlow's "do not file" gate (P4.2) is the differentiator on top of parity.

---

## 4. E-invoicing / Central Tax Hub context (brief — full spike separately)

SA plans a **Peppol-based five-corner** e-invoicing model routed through a SARS **"Central Tax Hub"**, with pilots/voluntary onboarding from 2026 (largest VAT contributors — Category C filers, major B2G, high-risk sectors — first) and full Central-Tax-Hub operation targeted ~2028; reporting is **near-real-time**, not strict real-time. **Correction to the programme's earlier working assumption (resolves the memory's claim):** the enacted *Tax Administration Laws Amendment Act 4 of 2026* (gazetted GG 54447, 1 Apr 2026) IS real, but it covers **dispute-resolution / collections and contains NO e-invoicing provisions** ([businesstech.co.za, 2026-04](https://businesstech.co.za/news/finance/855948/ramaphosa-signs-big-tax-changes-for-south-africa-into-law/)). The e-invoicing legal vehicle is a **separate 2025 Draft Tax Administration Laws Amendment Bill (TALAB)** (published for comment 16 Aug 2025) which, as of the 3 Feb 2026 SARS/Treasury position paper, was **still in the parliamentary pipeline — not yet law, with no enacted effective date** ([KPMG, 2026-02](https://kpmg.com/us/en/taxnewsflash/news/2026/02/south-africa-tax-authority-confirms-multi-year-e-invoicing-digital-reporting-reform.html)). **So do NOT cite "1 April 2026" as an e-invoicing effective date — that date belongs to a different, unrelated Act.** Deep dive + capability checklist: `docs/sars/2026-07-central-tax-hub-peppol-spike.md`.

---

## 5. Compliance / security requirements SARS imposes on ISVs

From the ISV T&Cs (21 Jun 2017), read directly:

- **Data protection (clause 6):** the ISV must comply with SARS data-protection requirements; the T&Cs' definition of "Data" **expressly includes Personal Information under POPIA (Act 4 of 2013)**. POPIA compliance is contractually pulled in.
- **Security (clause 7 / 4.3):** no damaging code, no breaching eFiling security; liability under ss 85–88 of the ECT Act 25 of 2002; must meet SARS security requirements "advised from time to time."
- **Confidentiality + secrecy oath (clause 8):** the ISV must procure that staff exposed to SARS confidential info **sign the annexed Oath/Affirmation of Secrecy** (binding under Chapter 6 of the Tax Administration Act, 2011). **IsaFlow staff who touch SARS taxpayer data may have to sign SARS secrecy oaths.**
- **Credential-storage specifics** (encryption standard, MFA, password-storage prohibition) and an **explicit audit-trail/retention clause** are **UNVERIFIED** — not in the public T&Cs; released post-onboarding. The ISV channel is built around the login *key* (not the taxpayer's raw eFiling password), reducing exposure by design. *(P4.2 pre-empts this: audit log in migration 504, no secrets logged, redacted config status — see §6.)*

---

## 6. Integration architecture — how IsaFlow's P4.2 build maps

The P4.2 build implements the channel behind an env gate so it is **inert in production until Hein onboards**, while being fully contract-tested against a mock ISV server.

```
VAT201 page ──"Submit to SARS" (only if configured & exceptions clean)
   │
   ├── GET  /api/accounting/sars/efiling-status   → { configured }  (redacted; never leaks the key)
   └── POST /api/accounting/sars/efiling-submit    { submissionId, action: submit|poll }
          │
          ▼
   sarsEfilingSubmissionService  ── evaluateEfilingGate (SERVER-SIDE, the differentiator)
          │        │  refuse + audit 'blocked' if exceptions present / degraded / bad VAT no.
          │        ▼
          ├── getEfilingConfig()  (SARS_EFILING_ENABLED + creds; else EfilingNotConfigured)
          ├── generateVAT201()    (authoritative box totals)
          ├── sarsEfilingClient   authenticate → submitVAT201 → pollStatus  (PROVISIONAL wire)
          └── sarsEfilingRepo      persist status + append sars_efiling_events audit rows (mig 504)
```

**Design decisions and how they map to the SARS reality:**

| SARS reality (dossier) | IsaFlow implementation |
|---|---|
| Two-tier: vendor onboarding (Tier-1) + per-taxpayer login-key (Tier-2) | `SARS_EFILING_*` env = Tier-1 arming + vendor/test creds. Per-taxpayer login-name/key (Tier-2), stored **encrypted per company**, is the documented follow-up — the client already takes the credential from the passed config, so it is a config-source swap, not a transport change. |
| Async/batch (Konsise overnight) | Client is submit→correlationId→poll; `pollVAT201Status` refreshes status. |
| Wire spec not public until onboarding | `sarsEfilingClient` wire format is **PROVISIONAL**, confined to one file; contract-tested vs a mock server. Reconciled on spec release. |
| VAT no. = 4 + 9 digits; audit-trail expected | VAT number validated before filing; **migration 504 `sars_efiling_events`** is an append-only, company-scoped audit log (no secrets) capturing every submit/poll/blocked/error. |
| POPIA + no credential leakage | `efilingConfigStatus` is redacted; the activation key is never logged or returned. |
| **Differentiator (not in competitors)** | Server re-runs the pre-filing exceptions report and **refuses to file** unless clean — a "do not file" banner blocks the UI and the API enforces it. |

**What flips on when Hein completes onboarding:** (1) set `SARS_EFILING_*` env on prod; (2) replace the provisional wire in `sarsEfilingClient` with the real spec; (3) add per-company encrypted Tier-2 credential capture; (4) run SARS acceptance testing against the real test endpoint; (5) enable for pilot customers.

---

## 7. Confidence & gaps

**Well-verified (HIGH):** two-tier model; the activation-key mechanism is the live 2026 mechanism (Xero+Sage+Konsise); registration = sign ISV T&Cs + email SARS (T&Cs read in full: acceptance-testing gate, volume targets 1k/5k/10k, secrecy oath, POPIA-inclusive data definition); full VAT201 Fields 1–20; VAT number format; VAT categories A–E; a mandatory acceptance-testing + written-approval gate exists; competitor classification (Konsise/Sage/Xero direct, Zoho prepare-only).

**UNVERIFIED / Hein to confirm with SARS:** exact ISV mailbox (likely isv@sars.gov.za); the VAT201 ISV interface spec (protocol/schema/field encoding/tax-period wire format/PIN/status codes) — released only post-onboarding; test/sandbox name & mechanics; whether INF001/an NDA is required for VAT201; credential-storage security specifics + explicit audit/retention clauses; the "~29 approved ISVs" figure (single source); **the e-invoicing legal timing is now clarified** (Act 4/2026, gazetted 1 Apr 2026, is dispute-resolution only; e-invoicing is the still-unenacted 2025 Draft TALAB) — but confirm the bill's current parliamentary status before quoting any mandate date; ZYNO's "direct" claim.

---

## 8. Registration checklist for Hein

1. **Read the contract first.** ISV Systems Interface T&Cs (21 Jun 2017): [PDF](https://www.sars.gov.za/wp-content/uploads/Docs/InterfaceSpecs/Final-v3-ISV-Systems-Interface-Terms-and-Conditions-21-June-2017.pdf). Note the **volume targets (1,000 yr1 / 5,000 yr2 / 10,000 yr3 per tax type)**, the **acceptance-testing gate**, and the **staff secrecy-oath** obligation.
2. **Get the current mailbox + latest T&Cs** from the live [SARS ISV page](https://www.sars.gov.za/individuals/i-need-help-with-my-tax/your-tax-questions-answered/independent-software-vendors/) (confirm the email; likely isv@sars.gov.za).
3. **Email SARS to open onboarding** — state IsaFlow (Pty) Ltd seeks ISV authorisation to submit **VAT201** on behalf of clients; request (a) the VAT201 ISV **interface spec**, (b) **acceptance-testing / test-environment** details, (c) any **NDA/INF001** requirement. Attach company registration.
4. **Sign & return the T&Cs** (+ any NDA); prepare staff to sign the **Oath/Affirmation of Secrecy**.
5. **Build to the released spec** — reconcile `sarsEfilingClient`'s provisional wire; map IsaFlow's VAT engine to **Fields 1–20** keyed by the 4-prefixed VAT number + category tax period.
6. **Pass SARS acceptance testing** and obtain **written approval** (no production activation before this).
7. **Get "IsaFlow" into the eFiling ISV dropdown** (the Tier-1 deliverable).
8. **Build the Tier-2 per-customer activation UX** — instruct clients to activate IsaFlow in eFiling → copy Login Name + Login Key → paste into IsaFlow (store encrypted per company); reuse across a practitioner's authorised orgs.
9. **Keep VAT payment out of scope** (done separately on eFiling), matching Konsise/Sage/Xero.
10. **Compliance controls before go-live** (mostly pre-built in P4.2): POPIA operator agreements, encryption-at-rest for stored login keys, least-privilege, staff secrecy oaths, submission audit trail.
11. **Track the volume targets** post-activation (plan onboarding to clear 1,000 VAT201 submissions in year 1).
12. **Watch the 2026–2028 Central Tax Hub / Peppol programme in parallel** (`docs/sars/2026-07-central-tax-hub-peppol-spike.md`) — a separate accreditation front.

---

*Key anchors: [SARS ISV page](https://www.sars.gov.za/individuals/i-need-help-with-my-tax/your-tax-questions-answered/independent-software-vendors/) · [ISV T&Cs PDF](https://www.sars.gov.za/wp-content/uploads/Docs/InterfaceSpecs/Final-v3-ISV-Systems-Interface-Terms-and-Conditions-21-June-2017.pdf) · [INF001 form](https://www.sars.gov.za/wp-content/uploads/Ops/Forms/INF001-Access-to-SARS-Electronic-Interface-External-Form.pdf) · [VAT201 completion guide GEN-ELEC-04-G01](https://www.sars.gov.za/wp-content/uploads/Ops/Guides/GEN-ELEC-04-G01-Guide-for-completing-the-Value-Added-Tax-VAT201-Declaration-External-Guide.pdf).*
