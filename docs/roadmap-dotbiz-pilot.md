# IsaFlow Differentiation Roadmap — Dotbiz Pilot (2026)

**Status:** Approved via grill-me planning session, 2026-06-11.
**Owner:** Hein. **Design partner:** Dotbiz (Marneweck firm).

## Decisions (locked)

1. **GTM: firm-led.** Accounting firms are the buyer; their clients come in underneath. SME self-serve is not the acquisition channel.
2. **Design partner: Dotbiz.** Roadmap is anchored to their real workflow, real Sage clients, real filing calendar.
3. **Pilot scope: full stack.** Dotbiz is buying the consolidation thesis — books + bank recon + VAT + payroll + AFS replacing Sage + payroll software + Draftworx in one system.
4. **Go-live is staged, build is up-front.** ALL pillars are built before the pilot starts ("literally everything"), but Dotbiz cuts over module by module through gates.
5. **Calendar anchor:** start ASAP; quicker is better. Target Gate 1 = Jul–Aug VAT period filed by end September 2026.

## Positioning

> Sage and Xero record what happened. IsaFlow finishes the work — posts it, queries the client, files it, compiles it.

One system replacing four subscriptions: bookkeeping (Sage/Xero) + AFS compilation (Draftworx/CaseWare) + payroll (VIP/SimplePay) + practice management (Karbon/XPM).

## Current state (repo audit 2026-06-11)

Most pillars already exist in some form — pre-pilot work is **completion + hardening, not greenfield**:

| Pillar | Exists | Gap |
|---|---|---|
| VAT201/SARS | `vat201Service`, `vatReturnService`, `vatSubmissionService`, `pages/accounting/sars/vat201.tsx`, EMP201/EMP501 APIs, EasyFile export | Exception-report quality; real-data validation vs Sage |
| Payroll | 35+ services: PAYE/UIF/SDL/ETI engines, UIF declarations | **Parallel-run comparison tooling (new build)** |
| WhatsApp | Bidirectional Twilio WABA: `whatsAppInboundService` (webhook + media), `whatsAppReplyService` (outbound) | **Query loop (new build)**; `TWILIO_AUTH_TOKEN` unset in prod; WABA template approvals |
| Bank feeds | `openBankingService` + sync orchestration, provider stubs | Stubs are Basiq/Tink/Plaid — **none serve SA. Stitch integration (new build)** |
| Capture/OCR | Bank-statement OCR (VLM), `evidenceAttachmentService`, email + WhatsApp media capture | Mobile (PWA camera) surface — thin new UI over existing pipeline |
| Owner home | `/home` + `ClientHomeView` + metrics/work-items API shipped | Plain-language cash-position polish |
| Firm cockpit | Triage board + work-items feed shipped | **Compliance calendar generating work items (new build)** |
| AFS | Full engine: 53 services — generation, notes, rendering, CIPC, review, portal | Validate against a Draftworx output at Gate 3 |
| Sage migration | Chrome extension + server-side pull, COA branch, compare service | Fidelity proof on a real Dotbiz client |

Net-new builds are only four: payroll comparison report, WhatsApp query loop, Stitch bank feeds, compliance calendar.

## Phase 0 — Pre-pilot build sprint (now → pilot start)

Ordered by gate-criticality. Targets ~3–4 weeks at agent-team velocity.

**Day 1 — external dependencies with lead times (start immediately, all outside our control):**
- Meta/Twilio WABA message-template approval submissions (days–weeks)
- Stitch (bank feed) commercial application
- `TWILIO_AUTH_TOKEN` set in prod (one-liner, needs Hein)

**Workstream A — VAT filing pack (Gate-1 critical).** Validate `vat201Service` against real Sage data (Britech/Demo). Build the exceptions list: unclassified-VAT transactions, missing tax codes, GL-vs-invoice mismatches, VAT-control-account vs VAT201-box reconciliation. *Done when:* a migrated client's VAT201 matches Sage's to the cent, and seeded errors all appear on the exception report.

**Workstream B — Sage migration fidelity (Gate-1 critical).** Full migration of a real Dotbiz sample client; diff COA/TB/open items vs Sage; fix gaps. *Done when:* the diff report shows zero unexplained differences.

**Workstream C — Payroll parallel-run tooling (Gate-2 critical, new).** Per-employee comparison report — IsaFlow vs their current payroll (gross, PAYE, UIF, SDL, ETI, net) with cent-level diffs, plus an import path for the incumbent's output. *Done when:* a known-good month reconciles to the cent.

**Workstream D — WhatsApp client query loop (new).** Accountant flags a bank transaction → templated WhatsApp to the client → reply (text or slip photo) attaches back to the transaction via the existing capture pipeline → resolution queue in the cockpit. *Done when:* a full round-trip works on the demo company with a real phone.

**Workstream E — Compliance calendar → cockpit (new).** Per-client recurring obligations (VAT cycle category, EMP201 monthly, EMP501 seasons, provisional tax, CIPC annual return) auto-generate triage-board work items with due dates. *Done when:* Dotbiz's pilot clients' next 90 days of deadlines render as work items.

**Workstream F — Bank feeds via Stitch (new).** Implement the SA provider behind the existing `openBankingService` abstraction. *Done when:* one real account syncs daily. **Constraint:** commercial lead time is external; if Stitch drags >2 weeks past the rest of Phase 0, pilot starts on CSV/OCR import (already solid) and feeds land mid-pilot. This is the one agreed exception to "everything before pilot."

**Workstream G — Owner home polish + mobile capture.** Plain-language cash position ("can I pay salaries?", who owes me, VAT set-aside) on `/home`; PWA camera capture feeding `evidenceAttachmentService`. *Done when:* a slip photographed on a phone attaches to a transaction.

## Pilot gates

**Gate 1 — Books + VAT (target: file by end Sep 2026).** Migrate 5–10 Dotbiz Sage clients in early July; run the Jul–Aug VAT period entirely in IsaFlow; Dotbiz submits to SARS from IsaFlow numbers. *Pass:* filed, exceptions list caught real issues, Dotbiz prefers it to Sage.

**Gate 2 — Payroll (parallel Aug, cutover Sep).** Parallel run on 2–3 clients for August; cutover when net pay/PAYE/UIF/SDL match to the cent; September pay run from IsaFlow. *Pass:* zero cent-level discrepancies at cutover; EMP201 filed from IsaFlow.

**Gate 3 — AFS (first year-end in pilot window).** Compile one pilot client's AFS in IsaFlow; Dotbiz reviewer signs off against what Draftworx would have produced.

**Differentiator validation (during pilot):** ≥5 real client queries resolved over WhatsApp; ≥1 bank account on live feeds; compliance calendar drives Dotbiz's daily triage.

**Commercial success:** Dotbiz commits to migrating the rest of their book / lets the Sage renewal lapse.

## Explicitly NOT building (cut list)

- SARS direct eFiling API integration — filing packs + EasyFile export only
- General-purpose AI chat copilot
- Native mobile apps — PWA only
- Multi-firm/marketplace features beyond what exists — pilot is one firm
- Any new pillar work beyond the seven workstreams until Gate 1 passes

## Risks

- **Payroll correctness** is the highest-stakes failure (real salaries). Mitigation: parallel month + cent-level gate; cutover slips before accuracy does.
- **External lead times** (WABA templates, Stitch contract) are the likeliest pilot-start delay. Mitigation: day-1 submissions; Stitch exception rule above.
- **Migration fidelity on real data** — unknowns until Workstream B runs on a genuine Dotbiz client. Run it in week 1, not last.
- **Support load vs build load** — pilot support pre-empts all remaining Phase 0 work once Dotbiz is live.
- **Single design partner** — Dotbiz's idiosyncrasies may not generalize. Accepted for now; second firm is post-Gate-1 business development, not roadmap.

## Validation discipline

Every workstream PR: blind `/review`, browser verification on the demo company, and where applicable a real-data diff against Sage/incumbent output. No workstream is "done" on build alone — each has the *done when* evidence above.
