# Next-Level Reporting Programme

> **For agentic workers:** This is the programme document. Do not execute from it. Each workstream has (or will get) its own plan under `docs/superpowers/plans/2026-09-*-reporting-*.md`, executed with `superpowers:subagent-driven-development`. Phase 1 is `2026-09-05-reporting-phase1-foundation.md`.

**Goal:** Make every statement, management account and pack in IsaFlow render through one renderer built on IBCS notation (ISO 24896), with drill-through, variance, trend and commentary as first-class features, and packs that are the same React page the user saw.

**Research brief:** https://claude.ai/code/artifact/e325a82b-ac18-4552-ad11-ed346915790e

**Grill decisions (2026-09-05, Hein):**
1. Nobody uses reporting yet. All five statement surfaces, including AFS, migrate in Phase 1.
2. Foundation is serial on one branch. Parallel workstreams start only after it merges. ECharts wrapper and Playwright PDF pipeline have no grid dependency and may start in parallel.
3. Acceptance per surface: grid computes nothing (unit test); foots to the cent against Britech and Velocity Fibre with a real `DATABASE_URL`; browser screenshot on the PR; blind review.
4. Cross-tenant benchmarking is out of this programme. It gets its own roast and grill later.

## Global Constraints

- **The grid never computes a figure.** Every number rendered comes from a service field. A subtotal derived in a component is a defect.
- **Statement names follow IFRS for SMEs**: Financial Position, Comprehensive Income, Changes in Equity, Cash Flows, Notes. Page titles may keep the plain-English label; the pack and AFS use the IFRS names.
- **IBCS notation**: actual solid ink, prior period light grey, budget outline, forecast hatched. Green/red mean favourable/unfavourable only. Same unit, same scale on a page.
- **Figures**: tabular numerals, right-aligned, negatives in parentheses, thousands separators, symbol on first row and totals only.
- **Licence spend: R0.** ECharts (Apache 2.0), TanStack Table (MIT), Tremor patterns (MIT), shadcn. AG Grid Enterprise is not in scope; raise it as a decision if pivot mode is demanded.
- **AI commentary is a draft** until a named user approves it; approval is audited. Nothing AI-written reaches a share link or PDF unapproved.
- **No cross-tenant reads.** Benchmarking is out of scope.
- **Repo rules apply**: branch first, stage by path, no stash, 300-line files, `log` not `console`, `company_id` on every query, `withAuth(withErrorHandler(...))`.

## Workstreams and dependency DAG

```
WS0 Foundation (serial, one agent, ~1 week)
 ├─ StatementGrid + row model + adapters (IS, BS)
 ├─ KpiTile (replaces KpiCard and KPICard)
 ├─ formatMoney + typography tokens
 ├─ migrate: income-statement, balance-sheet, management-accounts,
 │           report-packs, AfsStatementsTab
 └─ footing integration test (Britech, Velocity)

WS-E ECharts wrapper (parallel with WS0, no grid dependency)
 └─ src/lib/charts: registry, theme from --ff tokens, <EChart> SSR-safe

WS-P Playwright PDF pipeline (parallel with WS0, no grid dependency)
 └─ src/lib/pdf/renderPage.ts: authenticated page → PDF, print stylesheet contract

           ── WS0 merges ──

WS1 Charts + presentation      WS2 Packs + exports        WS3 Share + commentary
 ├─ waterfall (existing data)   ├─ pack = React page        ├─ expiring share links
 ├─ cash-flow sankey            │   rendered by WS-P        │   (reuse portal auth
 ├─ bullet row (budget)         ├─ cover, TOC, page nos     │    pattern)
 ├─ 12-mo small multiples       ├─ pptxgenjs export         ├─ commentary draft →
 ├─ presentation mode           └─ AFS PDF gets ECharts SVG │   approve → publish
 └─ owner/accountant toggle                                 └─ line annotations
```

WS1, WS2 and WS3 own disjoint files (see ownership below). A change outside a workstream's files goes to the owner as a request, not a commit.

## Team

| Role | Agent | Model | Owns |
|---|---|---|---|
| Programme lead | this session | fable | plans, merges, gates, decisions to Hein |
| WS0 implementer | `coder-hard` | opus | `src/components/accounting/statement/**`, `src/components/accounting/kpi/**`, `src/lib/format/**`, the five migrated surfaces |
| WS-E implementer | `coder` | sonnet | `src/lib/charts/**` |
| WS-P implementer | `coder` | sonnet | `src/lib/pdf/**`, `scripts/pdf/**` |
| WS1 implementer | `coder-hard` | opus | `src/components/accounting/charts/**`, `pages/accounting/reports/present/**` |
| WS2 implementer | `coder` | sonnet | `src/modules/accounting/services/packs/**`, `pages/api/accounting/packs/**`, `pages/accounting/reports/report-packs.tsx` |
| WS3 implementer | `coder-hard` | opus | `src/modules/accounting/services/share/**`, `pages/api/accounting/share/**`, `pages/share/**`, commentary approval |
| Blind reviewer | `/review` | sonnet | every PR, zero session context |
| Ledger reviewer | adversarial | sonnet | WS3 only (commentary approval writes audit rows) |
| Browser QA | `browser-qa` | sonnet | screenshot per migrated surface, attached to PR |

One worktree per implementer. Branch names: `feat/reporting-ws0-foundation`, `feat/reporting-ws-echarts`, `feat/reporting-ws-pdf`, `feat/reporting-ws1-charts`, `feat/reporting-ws2-packs`, `feat/reporting-ws3-share`.

## Gates (every PR)

1. `bun run ci` green in the worktree.
2. Unit tests for the new files, mutation-checked: the implementer must show one production mutation that turns a new test red.
3. For any migrated statement surface: footing integration test passes with `DATABASE_URL` set (Britech `d27bac33…` and Velocity Fibre); the test must not be the skip-when-no-DB kind.
4. Browser screenshot of each touched page at month-end, attached to the PR.
5. `/review` blind review; all HIGH/MEDIUM/LOW fixed.
6. WS3 additionally: adversarial ledger review for the approval audit rows.

No auto-merge. Every PR in this programme touches an existing production path, so it is outside the Level 3 boundary; Hein or the lead merges after gates.

## Sequencing

| Week | Running |
|---|---|
| 1 | WS0 (serial), WS-E, WS-P |
| 2 | WS0 finishes and merges; WS1, WS2, WS3 plans written against the real grid API |
| 3–4 | WS1, WS2, WS3 in parallel |
| 5 | Integration week: packs on ECharts, share links on packs, AFS PDF through WS-P; deploy to dev; Hein walkthrough |

## Out of scope

Benchmarking across tenants. AG Grid Enterprise. Embedded BI of any kind. Scenario toggle on actuals (Phase 4 in the brief; revisit after WS1–3 ship). Mobile-specific layouts beyond responsive tables.

## Decisions still open for Hein

- Share-link auth: expiring signed URL with no login (Syft style) vs portal login (the existing `pages/portal` pattern). Lead recommends signed URL with 30-day expiry, read-only, revocable, audited, decided when WS3's plan is written.
- Chromium on the production host for WS-P: install as a system package or run Gotenberg in Docker next to the WeasyPrint sidecar. Lead recommends Gotenberg, same operational shape as WeasyPrint.
