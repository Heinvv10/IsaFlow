# SARS Central Tax Hub / Peppol e-invoicing — Readiness Spike

**Phase:** A–Z programme P4.3 (doc only — no build). **Date:** 2026-07-06.
**Purpose:** map the Peppol five-corner / Central Tax Hub model onto IsaFlow's existing invoice engine, produce an "e-invoicing ready" gap list, and feed Hein's pilot application. Companion to `docs/sars/2026-07-VAT201-isv-dossier.md` (VAT201 ISV is the near-term table-stakes; this is the 2028 horizon).
**Method:** primary SARS/OpenPeppol sources where available; the SARS technical layer (CIUS, XSD, endpoints) is **not yet published**, so §3–4 are directional, not implementable, until SARS releases subordinate regulations.

---

## 1. Legal & timeline (2026) — which Act actually carries e-invoicing

- SARS's VAT Modernisation programme (from the Sept 2023 consultation paper) confirmed, in a Feb 2026 position paper, a **Peppol-based five-corner architecture anchored by a SARS "Central Tax Hub"** ([KPMG, 2026-02-11](https://kpmg.com/us/en/taxnewsflash/news/2026/02/south-africa-tax-authority-confirms-multi-year-e-invoicing-digital-reporting-reform.html); [peppol.nu, 2025-12-08](https://www.peppol.nu/blog-items/south-africa-einvoicing-mandate-2028/)).
- Rollout: **pilots / voluntary onboarding from 2026**, largest VAT contributors (Category C filers) + major B2G + high-risk sectors first; **Central Tax Hub "full operational capability" targeted for 2028**; medium enterprises later. No hard 2029/30 commencement dates are attested.
- **Current state (mid-2026): nobody is under a mandatory e-invoicing obligation.** Ordinary VAT Act invoice rules still apply.

> **✔ Legal-timing clarified — corrects the memory's claim.** IsaFlow's memory records "Tax Administration Laws Amendment Act 2026, effective 1 Apr 2026" as a verified *e-invoicing* fact. That conflates two different instruments:
> - The enacted **Tax Administration Laws Amendment Act 4 of 2026** (assented 31 Mar 2026, gazetted GG 54447, 1 Apr 2026) is real — but it covers **dispute resolution / collections (estimated assessments, s164 payment-suspension, penalty relief) and contains NO e-invoicing or VAT digital-reporting provisions** ([businesstech.co.za, 2026-04](https://businesstech.co.za/news/finance/855948/ramaphosa-signs-big-tax-changes-for-south-africa-into-law/)).
> - The e-invoicing legal vehicle is the **separate 2025 Draft Tax Administration Laws Amendment Bill (TALAB)** (published for comment 16 Aug 2025, closed 12 Sept 2025), which as of the 3 Feb 2026 SARS/Treasury position paper was **still in the parliamentary pipeline — not yet law, no enacted effective date** ([KPMG, 2026-02](https://kpmg.com/us/en/taxnewsflash/news/2026/02/south-africa-tax-authority-confirms-multi-year-e-invoicing-digital-reporting-reform.html)).
>
> **Bottom line for Hein:** do NOT cite "1 April 2026" as an e-invoicing effective date — it belongs to an unrelated Act. There is **no mandatory e-invoicing obligation on anyone yet**, the reporting cadence is **near-real-time** (not strict real-time), and the wire format is unpublished. Confirm the draft TALAB's current parliamentary status before quoting any mandate date.

- **Model flavour:** SARS is reported to adopt a **non-blocking, parallel 5-corner (DCTCE)** model — invoice exchange and reporting to SARS happen in parallel, explicitly contrasted with Italy's pre-clearance SdI — though one minority source claims pre-delivery clearance. Treat "non-blocking parallel" as the working assumption, **UNVERIFIED** until SARS publishes the transaction flow.

---

## 2. The Peppol five-corner model as it applies to SARS

Standard **4-corner**: **C1** seller → **C2** seller's Access Point → **C3** buyer's Access Point → **C4** buyer. The **5-corner / CTC** extension adds **C5 = the tax authority (SARS)**, receiving transaction data in parallel.

| Corner | Role in SARS's model |
|---|---|
| C1 | Sending company (SA VAT-registered) |
| C2 | Sender's **Access Point** — certified provider that validates + separately reports to SARS |
| C3 | Receiver's Access Point |
| C4 | Receiving company |
| **C5** | **SARS** — near-real-time transaction data in parallel |

**Discovery layer:** **SML** (DNS-based locator) → **SMP** (per-participant metadata: Peppol ID, supported doc types, serving Access Point). Participant IDs are ISO 6523 `<ICD>:<value>`. **No ZA ICD scheme is confirmed** (VAT-number vs CIPC-registration-number based) — a hard blocker for participant discovery, to be tracked against SARS releases.

**Access Point paths for a vendor:** (a) **connect through an existing certified AP** (Pagero/Tickstar/Storecove/EDICOM) — the realistic low-overhead path, no OpenPeppol membership; or (b) **become an accredited AP** — OpenPeppol membership + ISO 27001 + Transport Infrastructure Agreement + 3-stage conformance testing (heavy). SARS additionally references its own **"Accredited Service Provider"** layer whose criteria are **not yet published**.

---

## 3. Invoice document standard

**Peppol BIS Billing 3.0** = a CIUS of **EN 16931**, expressed as **UBL 2.1** (`Invoice`/`CreditNote`). Key mandatory business terms: invoice number (BT-1), issue date (BT-2), type code (BT-3), currency (BT-5), specification identifier (BT-24), seller name/VAT ID/electronic address/country (BT-27/31/34/40), buyer name/VAT ID/electronic address/country (BT-44/48/49/55), buyer-reference or PO (BT-10/BT-13), totals (BT-106/109/112/115), per-category VAT breakdown (BT-116/117/118), and line items (BT-126/129-130/131/146/151/153). VAT category codes: **S** standard, **Z** zero-rated, **E** exempt, **AE** reverse charge, **O** outside scope (EU-only G/K/L/M have **no SA equivalent**). Tax structure in UBL: `cac:TaxTotal → cac:TaxSubtotal → cac:TaxCategory/cbc:ID → cac:TaxScheme/cbc:ID='VAT'`.

**No SA-specific CIUS is published** — expected alignment is vanilla BIS 3.0 / UBL 2.1, but SA's tiered tax-invoice thresholds, locally-defined categories, and CIPC identifiers cannot be expressed without a CIUS extension. **Any XML generator built today against plain BIS 3.0 will likely need rework once SARS's CIUS lands.**

---

## 4. Mapping onto IsaFlow's invoice engine — HAVE vs GAP

Based on the current schema (`customer_invoices`, `customer_invoice_items`, `companies`, `customers`, `suppliers`):

| Peppol BIS 3.0 requirement | IsaFlow today | Status |
|---|---|---|
| Invoice number (BT-1), issue date (BT-2), currency (BT-5) | `customer_invoices.invoice_number/invoice_date/currency` | ✅ Have |
| Seller legal name (BT-27), VAT ID (BT-31) | `companies.name`, `companies.vat_number` | ✅ Have |
| Seller postal address (BG-5), country (BT-40) | `companies.physical_address_line1/2`, `physical_city`, `registered_address` — but **no ISO country code** | ⚠ Partial (add ISO-3166 country) |
| Buyer name (BT-44), VAT ID (BT-48), address | `customers` name/address; **buyer VAT ID field to confirm** | ⚠ Partial |
| Line items: qty, unit, net amount, item name (BT-126/129/131/153) | `customer_invoice_items` (quantity, line_total) | ✅ Have (unit code may need mapping) |
| Per-line + per-category VAT (BT-116/117/118, BT-151) | `tax_rate`/`tax_amount`; `vat_classification` on supplier items; `vat_type` on GL | ⚠ Partial — **map local categories → Peppol S/Z/E/O/AE** |
| Document totals (BT-106/109/112/115) | `subtotal`, `tax_amount`, `total_amount` | ✅ Have |
| **Seller/Buyer electronic address = Peppol endpoint ID (BT-34/BT-49)** | none | ❌ **Gap** (blocked on ZA ICD scheme) |
| Buyer reference / PO reference (BT-10/BT-13) | PO ref on some invoices; confirm always-present | ⚠ Partial |
| **UBL 2.1 XML generation** (Invoice + CreditNote) | none | ❌ **Gap** |
| **EN16931/Peppol Schematron validation** pre-send | none | ❌ **Gap** |
| **Access Point connection** (send/receive over AS4) | none | ❌ **Gap** (connect through a certified AP) |
| **MLR + Invoice Response handling** | invoice status model exists; no Peppol response ingest | ❌ **Gap** |
| **Central Tax Hub (C5) reporting leg** | none | ❌ **Gap** (protocol unpublished) |
| Structured-invoice + transmission audit trail | tenant audit patterns exist; extend for e-invoice trail | ⚠ Extend |

**Net:** IsaFlow already holds most of the *invoice-content* substrate (parties, lines, VAT, totals, currency). The gaps are the *e-invoicing plumbing* — UBL serialisation, participant IDs, an Access Point, response handling, and the SARS reporting leg — plus a VAT-category **mapping layer** and an **ISO country code**.

---

## 5. "E-invoicing ready" capability checklist

Buildable-today first, blocked-on-SARS last:

1. **[standard]** UBL 2.1 `Invoice`/`CreditNote` export from the invoice engine, mapping current fields → mandatory BTs (§3). Forward-compatible base layer regardless of the eventual CIUS.
2. **[standard]** Add an **ISO-3166 country code** + confirm buyer VAT ID capture on `customers`.
3. **[standard]** A **VAT-category mapping layer** so IsaFlow's `vat_type`/`vat_classification` (standard/zero_rated/exempt/…) re-points to Peppol S/Z/E/O/AE (assume G/K/L/M dropped).
4. **[standard]** Schematron (EN16931/Peppol BIS 3.0 rules) validation as a pre-send gate.
5. **[standard]** Select a **commercial Access Point** partner (do not pursue OpenPeppol AP accreditation directly) — vendor-selection + API integration.
6. **[standard]** Ingest **Message Level Response** + **Invoice/Business Response** into the invoice status model (sent → validated → accepted/rejected).
7. **[SARS-specific]** **Track SARS's Ministerial Regulations + CIUS publication directly** (not via blogs) — highest-leverage open item; resolves wire format, category mapping, and clearance-vs-parallel.
8. **[SARS-specific]** Obtain a **ZA Peppol participant-identifier scheme** for tenant companies once registered (VAT or CIPC based) → populate the seller/buyer endpoint IDs.
9. **[SARS-specific]** Register for the SARS **"Accredited Service Provider"** framework once its criteria exist (distinct from Peppol AP + from VAT201 ISV status).
10. **[SARS-specific]** Implement the **Central Tax Hub (C5) reporting leg** once its protocol is published (via AP relay or direct API — unconfirmed).
11. **[SARS-specific]** Add a **"large taxpayer / priority sector" readiness flag** to tenant onboarding — the phased rollout brings large/B2G-heavy tenants into scope years before SMEs.

---

## 6. Confidence & gaps

**Well-verified:** the Peppol 5-corner/DCTCE mechanics; BIS 3.0 = EN16931/UBL 2.1 + its mandatory BT set; Access-Point accreditation mechanics; the SARS programme's design (5-corner + Central Tax Hub) and phased 2026-pilot → ~2028-full timeline.

**UNVERIFIED / build risk:** whether SARS is truly non-blocking vs pre-clearance; **the legal-timing conflict (§1)**; whether a ZA ICD participant scheme exists/will exist; existence/content of a SA-specific CIUS (universally "pending"); the AP-↔-Central-Tax-Hub protocol; SARS "Accredited Service Provider" criteria; any SA vendor's claimed Central-Tax-Hub readiness (no sourced announcement found).

---

## 7. Recommendation for Hein's pilot application

1. **Sequence it after VAT201 ISV** — VAT201 direct-submit (dossier P4.1) is the near-term revenue/parity move; e-invoicing is the 2028 horizon. Different accreditation fronts.
2. **Build the [standard] layer now as low-risk optionality** — a UBL export + VAT-category mapping + ISO country code are useful regardless (PDF-alternative, cross-border) and de-risk the eventual mandate. Do **not** build the SARS-specific legs against a guess.
3. **Register interest for the pilot** citing IsaFlow's existing invoice-content substrate (§4) and the exceptions-gate quality control already shipped (VAT201 P4.2) as evidence of data-integrity discipline — a credible "cloud-enabled SME tool" SARS says it wants.
4. **Connect through a certified Access Point**, not become one — keep the accreditation burden off the roadmap.
5. **Set a single watch item:** SARS Ministerial Regulations + CIUS publication. Everything SARS-specific unblocks there.
