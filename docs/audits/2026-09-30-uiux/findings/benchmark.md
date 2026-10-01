# Benchmark — audit (modern AI-driven accounting + practice management, 2025–2026)

Code read at `/home/hein/Workspace/IsaFlow/.worktrees/uiux-audit` (origin/master 66e776d81). No browser used for this area; IsaFlow claims below cite `file:line`. Competitor claims cite URLs at the bottom (`[S#]`); anything I could only find in marketing copy or third-party reviews is marked **(vendor claim)**, and anything I could not confirm is marked **unverified**.

## Verdict
IsaFlow has more working back-end than the UI shows. The engines are all there: a governed close agent, autonomous capture with supplier-cadence learning and chasing, WhatsApp client queries, a statutory compliance calendar, AI pack commentary, SA payroll and AFS/CIPC, and ~123 MCP tools. Leaders like Xero and Puzzle are only now shipping some of these (Xero's Partner Hub and document chasing arrive October 2026 or later [S1][S2]). The experience is still legacy-shaped in four ways:
- There is no single place where the accountant's day starts. There are four "homes", and the one login lands on (`/bureau`) is not in the nav.
- The practice CRM client list and the books portfolio are two unlinked client lists.
- Client questions are one WhatsApp message per bank line, with no batched to-do list the client can work through.
- The AI shows up as widgets, not as the way work gets done: there is no in-app ask box, and the NL-query API has no UI caller.

The next-level move is not new modules. It is one exceptions-first "Today" surface that joins what already exists.

## (a) The accountant's ideal day — target journey (synthesised from Xero Partner Hub, Karbon Triage/My Week, Puzzle, Digits Inbox, Keeper/Uncat)
1. **Log in and land on the firm "Today" view.** It shows one list across all clients, ranked by deadline × risk, with SARS dates (EMP201 7th, VAT 25th, EMP501, IRP6, CIPC) as rows rather than a separate calendar. The model is Xero Partner Hub: "book health, work status and month-end readiness" in one view [S1][S2], plus Karbon My Week [S5].
2. **See each client's book health at a glance.** A score or traffic light covers bank rec, uncoded lines, missing documents, unreconciled control accounts, TB balance and VAT readiness. Clicking a cell opens the fix in context, not a module landing page (Dext Precision health scores [S10], Xero [S1]).
3. **Clear the AI "ready to post" queue in bulk.** Categorisations, matches and accrual or depreciation journals are each shown with evidence, and nothing posts without approval (QBO Accounting Agent "Ready to post" [S3], Puzzle "nothing posts until your team approves" [S7], Digits Schedules [S8]).
4. **Batch the unknowns into one client request.** Uncoded or undocumented lines become a single client to-do list sent as a magic link or WhatsApp message, with automatic reminders and replies that attach themselves to the transaction (QBO "magic links" [S3], Keeper Client Portal [S11], Uncat [S12], JAX Document Requests [S1]).
5. **Work the email/WhatsApp inbox as a triage queue.** Each inbound message is labelled by AI, routed to the right client and job, and turned into a task or linked to a transaction (Karbon Triage AI [S5][S6]).
6. **Drive the close from one checklist per client.** Tick-offs are auto-verified from ledger state, the agent proposes adjustments, and sign-off locks the period and posts nothing silently (Puzzle AI Close [S7], XeroForce month-end agent, early access [S1]).
7. **Get flux review for free.** Period-over-period anomalies are flagged on the P&L and BS with a one-line "why" and a drill-down to transactions (QBO anomaly flags [S3], Digits Reporting Agent [S9], Syft Assist [S14]).
8. **Publish the management pack with AI commentary.** The accountant edits the draft commentary, approves it and shares it, and client-context goals feed the narrative (Fathom Commentary Writer, Syft [S14]).
9. **Handle SA statutory work without leaving the flow.** EMP201/VAT201 prepared, IRP5/EMP501 reconciled, and AFS drafted from the TB with CIPC XBRL (SimplePay [S16], Draftworx [S15]).
10. **Price and bill the work from the same data.** Scope is priced from observed volume (transactions, employees, entities) through a proposal and engagement letter with e-sign. Acceptance creates recurring jobs and billing, and out-of-scope work is billed as it happens (Ignition [S13], Karbon billing [S5]).
11. **Advise from signals.** After the health checks pass, the system surfaces "conversations worth having": cash gaps, unusual P&L moves, scenario models (Xero Partner Hub + Scenario Planning [S1][S2]).
12. **Ask anything, anywhere.** An in-app ask box answers over this client's or the whole firm's data, and the same tools are exposed to Claude, ChatGPT or M365 (Ask Digits [S9], Puzzle Chat [S7], Xero integrations [S1]).

## (b) Capability matrix

✓ = shipped · ◐ = partial / beta / coming soon · ✗ = absent · ? = unverified

| Capability | **IsaFlow** (evidence) | Xero (JAX + Partner Hub/XPM) | QBO Accountant + Intuit agents | Karbon | Digits | Puzzle | Sage (contrast) |
|---|---|---|---|---|---|---|---|
| Firm portfolio landing (all clients, readiness) | ◐ Three surfaces: `/bureau` cockpit (`pages/bureau/index.tsx:1-10`, login target `src/lib/auth/resolveLanding.ts:16`), Portfolio grid (`pages/accounting/portfolio-workbench.tsx:1-6`), and a per-company Dashboard. `/bureau` is not in `TABS` (`src/components/accounting/accountingNavConfig.ts:29-35`) | ◐ Partner Hub readiness view from Oct 2026 [S1][S2]; Xero HQ client list/insights ✓ [S4] | ◐ "business feed" of agent work + suggestions [S3]; layout **unverified** | ✓ My Week + client list (practice data, not ledger) [S5] | ◐ firm/multi-dashboard **unverified** | ✓ firm dashboard across entities [S7] | ◐ Sage for Accountants client list; readiness **unverified** [S17] |
| Exceptions-first to-do | ◐ Bureau feed (overdue/due-soon, `bureauClientTriageService.ts`); month-end cards; per-company `TodoWidget` (`dashboard/TodoWidget.tsx`). Three separate lists | ◐ JAX flags unreconciled/dupes/missing docs [S1] | ✓ agent to-dos + "ready to post" [S3] | ✓ Triage + My Week [S5] | ✓ Inbox (uncategorised, unmatched, questions) [S9] | ✓ | ✗/? |
| Close workflow + agent | ✓ `CloseAgentPanel` proposals with evidence, approve-only, accuracy stats (`close-agent/CloseAgentPanel.tsx:1-8`), 8-card workbench (`monthEndWorkbenchService.ts:359-366`) | ◐ XeroForce month-end agent (early access) [S1] | ✓ Accounting Agent close help [S3] | ◐ checklists/templates only [S5] | ✓ AGL + Schedules [S8] | ✓ AI Close [S7] | ✗/? |
| Client questions / document requests | ◐ WhatsApp query per bank line (`BankTxQueryModal.tsx:1-8`), reply auto-attached (`capture/.claude.md` bankTxQueryReplyService); supplier missing-invoice chase (`missingInvoiceChaseService.ts`). No batched client to-do list or portal | ◐ JAX Document Requests with reminders (coming soon) [S1] | ✓ to-do list + magic links [S3] | ✓ client requests + auto reminders [S5] | ✓ questions in Inbox [S9] | ◐ Cowork gathers docs [S7] | ? |
| Fees / proposals / engagement letters | ◐ billing model hourly/fixed/retainer on client and job (`practice/jobs/new.tsx:15-16`), WIP → invoice. No proposal, e-sign, pricing calculator or auto price increase | ◐ via Ignition app [S13] | ◐ via apps | ✓ engagements + billing [S5] | ✗ | ✗ | ✗ |
| In-context AI (suggestions inside the work) | ✓ LLM categorisation/auto-post gate, VLM capture, AFS note AI, pack commentary with approve/reject (`commentary/useCommentary.ts:1-10`), cash-flow forecast AI | ✓ | ✓ | ✓ summaries/drafts [S6] | ✓ | ✓ | ◐ Copilot [S17] |
| In-app chat / ask box | ✗ `/api/accounting/nl-query` exists but has no UI caller (grep of `src`/`pages` finds only the API route) | ✓ JAX | ✓ Intuit Assist | ✓ Kai (emerging) [S5] | ✓ Ask Digits [S9] | ✓ Chat [S7] | ✓ Copilot |
| External AI connectors | ✓ ~123 MCP tools with writes (`src/lib/mcp/tools/*`, `grep -c name:` = 123) | ✓ Claude/ChatGPT/M365 [S1] | ? | ? | ✓ Connect API [S8] | ? | ? |
| AI report commentary / flux | ◐ commentary on packs ✓; no flux "why" on the IS/BS **(unverified in UI)** | ◐ P&L anomalies via Partner Hub [S2] | ✓ period-over-period flags [S3] | ✗ | ✓ Reporting Agent [S9] | ◐ | ? |
| Command palette / global search | ◐ Ctrl+K over 7 entity types, single company only (`globalSearchService.ts:39-44`); 6 static quick actions (`:27-35`); no cross-client jump | ? | ◐ "My Menu" customisable [S3] | ? | ✓ shortcut manager [S9] | ? | ? |
| SA payroll (EMP201/IRP5/EMP501) | ✓ `pages/payroll/{emp501,irp5,...}`, `pages/accounting/sars/emp201.tsx` | ◐ via SimplePay [S16] | ✗ (SA) | ✗ | ✗ | ✗ | ✓ Sage Payroll SA ? |
| SA AFS / CIPC | ✓ AFS module, sign, client portal (`pages/accounting/afs/{sign,portal}`), CIPC guide (`cipcFilingGuideService.ts`) | ◐ via Draftworx [S15] | ✗ | ✗ | ✗ | ✗ | ◐ via Draftworx/CaseWare [S15] |
| Practice CRM ↔ books linkage | ✗ `PracticeClient` has `linkCustomerId` (AR billing) but no link to the client's books company (`practiceClientService.ts:7-22`) | ✓ XPM ↔ Xero orgs [S4] | ✓ QBOA client ↔ file | ✓ via integrations | n/a | n/a | ◐ |

**Read:** IsaFlow matches or beats the field on engines: close agent, capture/chasing, SA statutory, MCP. It trails on **surfacing** (one home, one client model, one client to-do list, an ask box) and on **commercial practice** (proposals and pricing).

## Findings
| ID | Sev | Type | Route / flow | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|---|
| BMK-01 | P1 | navigation | login → `/bureau` | Firm users land on `/bureau`, but no nav tab leads back to it, so after the first click the cockpit is reachable only by URL. Portfolio and Dashboard compete as "home". | `src/lib/auth/resolveLanding.ts:16`; `accountingNavConfig.ts:29-35` (no bureau tab); `grep "/bureau"` in `src/components/layout` returns nothing | Merge `/bureau` and Portfolio into one "Today" tab (IDEA-BMK-01) |
| BMK-02 | P1 | workflow | Practice ↔ Portfolio | Two unlinked client lists. The Practice CRM (`practice_clients`: billing model, partner, jobs) cannot open that client's books, and the Portfolio (companies the user belongs to) cannot see jobs, WIP or fees. | `practiceClientService.ts:7-22` (no books-company field); `portfolioWorkbenchService.ts:1-20` (`getUserCompanies`) | Link a practice client to a books company (IDEA-BMK-02) |
| BMK-03 | P1 | workflow | bank tx → client query | A client query is one WhatsApp message per bank line. There is no batched request, reminder cadence or client-side list, even though the reply-ingest plumbing exists. | `BankTxQueryModal.tsx:1-8`; `capture/.claude.md` (bankTxQueryReplyService) | Client to-do list (IDEA-BMK-03) |
| BMK-04 | IDEA | idea | global | The NL-query back end (with SQL safety validation) has no UI, so in-app AI is invisible to a user who is not on Claude/MCP. | `pages/api/accounting/nl-query.ts`; `nlQueryValidationService.ts:1-20`; no caller in `src`/`pages` | Ask box in the command palette (IDEA-BMK-05) |
| BMK-05 | P2 | navigation | Ctrl+K | The palette searches only the active company and offers 6 hard-coded create actions. An accountant cannot type a client's name to jump to it, or type "close March for X". | `globalSearchService.ts:27-44` | Cross-client and verb-aware palette (IDEA-BMK-06) |
| BMK-06 | IDEA | idea | practice | No proposal, engagement letter, e-sign or scope pricing. Fees are keyed in by hand (fixed amount / budgeted hours). | `pages/accounting/practice/jobs/new.tsx:15-16,209-220` | Volume-priced engagements (IDEA-BMK-07) |

## (c) Ten highest-leverage "next-level" ideas

| ID | Idea | Why it changes the accountant's day | Proven by | Builds on (IsaFlow) |
|---|---|---|---|---|
| IDEA-BMK-01 | **One "Today" home for firms.** Merge `/bureau` triage and the Portfolio grid into one ranked queue: SARS deadlines, close blockers, client replies waiting, AI proposals awaiting approval. Each row carries a one-click action that switches company and deep-links to the fix. | Replaces three homes with one starting point, and removes the nav dead end (BMK-01). | Xero Partner Hub (Oct 2026) [S1][S2]; Karbon My Week [S5]; Digits Inbox [S9] | `bureauWorkAggregatorService`, `portfolioWorkbenchService`, `complianceCalendarEngine`, `switch-company` flow already in `portfolio-workbench.tsx:108-127` |
| IDEA-BMK-02 | **One client entity.** Link a practice client to its books company, so the client page shows book health, the jobs/WIP/fee strip and statutory dates together. | Removes the biggest structural silo. Makes fee realisation and advisory possible. | XPM ↔ Xero org [S4]; Karbon client summaries [S6] | `practice_clients`, `bureau_companies` |
| IDEA-BMK-03 | **Client to-do list, batched and auto-chased.** A "Questions for client" basket per period collects uncoded lines, missing receipts and payroll changes. It goes out as one WhatsApp or magic-link page, sends reminders on a schedule, and routes each reply to its line. | Stops the per-line WhatsApp ping-pong. This is the biggest time sink in bookkeeping. | QBO magic links [S3]; Keeper Client Portal [S11]; Uncat [S12]; JAX Document Requests [S1] | `bankTxQueryService`, `bankTxQueryReplyService`, `whatsAppChaseService`, `list_unsupported_transactions` |
| IDEA-BMK-04 | **Book-health score per client.** A 0–100 score from bank-rec coverage, uncoded %, missing evidence above a threshold, subledger↔GL differences, TB balance and VAT readiness. Trend it and sort the portfolio by it. | Gives an objective "who needs me" signal, and quality is visible before the close. | Dext Precision health scores [S10]; Xero book health [S2] | `data_integrity_checks`, `reconcile_subledger`, `bank_statement_coverage`, month-end cards |
| IDEA-BMK-05 | **In-app "Ask IsaFlow".** Put it in the command palette and as a side panel on every report. It answers over the active client (or the whole firm for practice questions) and reuses the MCP tool layer and the NL-query validator. It cites the records it used and offers the next action ("draft journal", "send query"). | The AI becomes the way into the product, not a separate integration. This reuses ~123 governed tools instead of building a new stack. | Ask Digits [S9]; Puzzle Chat [S7]; Intuit Assist [S3]; Sage Copilot [S17] | `src/lib/mcp/registry.ts`, `nl-query.ts` |
| IDEA-BMK-06 | **Verb-aware, cross-client command palette.** Typing "Brightsphere" jumps to that client, "close march" opens the workbench on 2026-03, "VAT201 Demo" opens the return, and recent records persist across clients. | Keyboard-first speed for power users, with no menu diving through the Library flyout. | Digits shortcut manager [S9]; QBO My Menu [S3] | `CommandPalette.tsx`, `globalSearchService.ts` |
| IDEA-BMK-07 | **Volume-priced engagements.** A proposal wizard prices recurring bookkeeping, payroll, VAT and AFS from observed volumes (bank lines/month, employees, VAT cadence, entities) and a firm rate card. It produces the engagement letter, e-sign and a recurring invoice, auto-creates jobs, and flags out-of-scope work when volume drifts. | Fee calculation is an explicit owner goal. IsaFlow uniquely holds the volume data that Ignition has to ask the client for. | Ignition (AI Price Insights, auto price increases, billing on acceptance) [S13]; Karbon billing [S5] | `practiceStaffRateService`, WIP → invoice, `pages/accounting/afs/sign` e-sign pattern |
| IDEA-BMK-08 | **Flux review with "why".** On the IS/BS, flag period-over-period moves above a threshold with an AI one-liner and drill-down, feeding the Review card and the pack commentary. | Turns reports from lists into answers, and catches mispostings before the client sees them. | QBO anomaly flags [S3]; Digits Reporting Agent [S9]; Syft Assist [S14] | `commentaryService`, `budget_variance`, `packAiSummaryService` |
| IDEA-BMK-09 | **Close checklist as recurring work.** Each month auto-generates a per-client close job whose checklist ticks itself from ledger state (the 8 workbench cards) and whose sign-off locks the period. Time logged against it feeds fee realisation. | Joins practice management and the close: "is it done?" and "did we make money on it?" come from one object. | Karbon work templates [S5]; Keeper Close Page [S11]; Puzzle scheduled checklists [S7] | `practiceRecurringTaskService`, `monthEndWorkbenchService`, `close_fiscal_period` |
| IDEA-BMK-10 | **SA statutory autopilot lane.** In the Today queue, EMP201, VAT201, EMP501 interim/annual, IRP6 and CIPC each appear as a prepared-and-checked item ("VAT201 ready: 3 exceptions") with the evidence pack attached. Submission still requires a human click. | The SA moat. Xero/QBO rely on SimplePay/Draftworx add-ons for this, and IsaFlow has it native. | SimplePay one-click EMP201/UIF [S16]; Draftworx TB → XBRL [S15] | `complianceCalendarEngine`, `vat_exceptions`, `emp201_status`, AFS/CIPC services |

## Page inventory
| Route / file | Loads? | Breadcrumb | Notes |
|---|---|---|---|
| `pages/accounting/index.tsx` (Dashboard) | not browser-tested | n/a | per-company KPIs + TodoWidget + WorkbenchSection |
| `pages/accounting/portfolio-workbench.tsx` | not browser-tested | n/a | 8-column status grid; switches company, then opens the month-end workbench |
| `pages/accounting/month-end-workbench.tsx` | not browser-tested | n/a | 8 cards + CloseAgentPanel |
| `pages/bureau/index.tsx` | not browser-tested | n/a | login landing for firms; not in nav |
| `pages/accounting/practice/**` | not browser-tested | n/a | clients/jobs/tasks/time/WIP/reports; separate client model |
| `src/lib/mcp/tools/*` | n/a | n/a | ~123 tools |

This area was a benchmark done from code and web sources. Visual and runtime claims about these pages belong to the other area agents.

## Top 5 recommendations for this area
1. IDEA-BMK-01: one "Today" home (fixes BMK-01).
2. IDEA-BMK-03: batched, auto-chased client to-do list (fixes BMK-03).
3. IDEA-BMK-02: link practice clients to books companies (fixes BMK-02).
4. IDEA-BMK-05 + 06: surface the AI through an ask box and a cross-client palette (fixes BMK-04/05).
5. IDEA-BMK-07: volume-priced engagements (the owner's fee-calculation goal; fixes BMK-06).

**Strongest counter-argument:** Xero's own reviewer warns "don't build a service line on" agent features that are still beta [S2-thefirm]. IsaFlow should ship the surfacing (01–04) on existing engines before adding new autonomous behaviour.

## Sources
- [S1] Xerocon Denver 2026 — https://blog.xero.com/product-updates/xerocon-denver-2026-agentic-workflows-ai-era/ ; press: https://www.xero.com/us/media-releases/new-ai-innovations-xerocon-denver/
- [S2] Xerocon London 2026 — https://www.xero.com/us/media-releases/xero-announces-new-ai-innovations-xerocon-london/ ; critique of shipping vs coming soon: https://www.thefirm.media/articles/xerocon-london-2026-announcements-what-actually-matters
- [S3] QBO AI agents for accounting pros — https://www.firmofthefuture.com/product-update/accounting-pro-guide-quickbooks-ai-agents/ ; https://quickbooks.intuit.com/global/resources/accountants/quickbooks-ai-agents-accountants/ ; tiers: https://www.usecarly.com/blog/quickbooks-ai/
- [S4] Xero HQ / XPM client insights — https://www.xero.com/us/xero-hq/client-insights/ ; https://www.xero.com/us/xero-practice-manager/
- [S5] Karbon overview — https://karbonhq.com/resources/what-is-karbon/ ; Triage: https://karbonhq.com/solution/email-management/
- [S6] Karbon AI release notes (31 Mar 2026) — https://karbonhq.com/release-notes/mar-31-2026/
- [S7] Puzzle — https://puzzle.io/ai-close ; https://puzzle.io/blog/accounting-firm-month-end-close-software (vendor claim: 98% auto-categorisation)
- [S8] Digits — https://www.globenewswire.com/news-release/2026/05/07/3290106/0/en/digits-pioneers-ai-native-accrual-accounting-launches-automated-schedules-inside-the-ledger.html ; https://www.globenewswire.com/news-release/2026/02/09/3234583/0/en/Digits-Named-a-2026-Top-New-Product-for-Accountants-by-Accounting-Today.html
- [S9] Digits UI review / Ask Digits — https://thedigitalmerchant.com/digits-review/ ; https://blog.insightfulaccountant.com/digits-launches-ask-digits-real-time-ai-assistant
- [S10] Dext data health — https://dext.com/en/partner/product/ensure-client-data-health
- [S11] Keeper — https://docs.keeper.app/getting-started-guide ; https://keeper.app/customer-stories/how-on-the-books-corrects-700-transactions-per-month-using-keepers-file-review/
- [S12] Uncat — https://www.uncat.com/ ; https://www.uncat.com/blog/announcing-uncat-receipts
- [S13] Ignition — https://www.ignitionapp.com/accountants (AI Price Insights named, mechanics unverified)
- [S14] Fathom/Syft AI commentary — https://www.fathomhq.com/blog/best-ai-accounting-tools-what-to-use-and-why ; https://claryx.ai/blog/syft-analytics-review/
- [S15] Draftworx — https://draftworx.com/ ; https://draftworx.helpjuice.com/cloud/draftworx-cloud-importing-a-trial-balance ; CaseWare Africa: https://www.casewareafrica.com/products/smart-engagement/
- [S16] SimplePay — https://www.simplepay.co.za/for-accountants ; https://www.simplepay.co.za/features ; PaySpace AI Assist/WhatsApp ESS: https://www.payspace.com/southafrica
- [S17] Sage Copilot for Accountants — https://www.sage.com/en-gb/accountants/ ; https://www.sage.com/en-us/news/press-releases/2026/04/sage-expands-ai-agents-across-finance-hr-and-operations-to-automate-workflows/
- Pilot (contrast, not in matrix): autonomous AI Accountant Feb 2026; "Meridian" for firms Jun 2026 — third-party report only, **unverified**: https://beancount.io/blog/2026/08/22/pilot-ai-accountant-autonomous-bookkeeping-small-business-guide
