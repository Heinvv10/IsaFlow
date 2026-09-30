# IsaFlow UI/UX audit — shared brief (read fully before starting)

## Goal
The owner wants IsaFlow (SA accounting SaaS for accountants/bookkeepers) to feel like a modern,
AI-driven, turnkey end-to-end product — NOT like Sage / QuickBooks / Xero legacy flows. The persona
is an accountant who logs in and needs: overviews, to-dos, reports, practice management and fee
calculation, payroll, month-end — all flowing without dead ends. Your job is to AUDIT (find and
evidence problems + opportunities), not to fix.

## Environment
- Code under audit: `/home/hein/Workspace/IsaFlow/.worktrees/uiux-audit` (detached at origin/master 66e776d81).
  Read code with Read/Grep there. DO NOT edit any file in the repo. No git commands that write.
- App: production build served at `http://localhost:3200` (dev database `isaflow_dev`, NOT prod).
- Harness dir: `/tmp/claude-1003/-home-hein-Workspace-IsaFlow/39ab110c-b4c0-4cac-98ac-8c3fd893dcee/scratchpad/audit`
  (call it $AUD).
- Session: `bash $AUD/mint-session.sh $AUD/sessions/<your-area>.json [company_id]` mints a logged-in
  browser session for the dev QA user `reporting-qa@isaflow.dev` ONLY. Default company is
  ISAFlow Demo (`00000000-0000-0000-0000-000000000001`, richest data). Brightsphere is
  `d27bac33-cdc0-4e58-bf6b-709c1597d41c`. Mint YOUR OWN session file (refresh tokens rotate; sharing
  breaks other agents). If a page redirects to /login, re-mint. NEVER mint for any other user.
- Bulk capture: `node $AUD/capture.mjs --session S.json --out $AUD/shots/<area> [--mobile] /route1 /route2 ...`
  → a full-page PNG + JSON per route (final URL, title, h1, breadcrumb, console errors, page errors,
  failed /api calls, suspicious text like NaN/undefined/Invalid Date, horizontal overflow, internal links).
  Run it from any cwd. Batch ~10–20 routes per call.
- Interactive flows: write your own small Playwright `.mjs` scripts in `$AUD/scripts/<area>-*.mjs`,
  copying the `createRequire(...)`/`chromium.launch()`/`storageState` pattern from capture.mjs. Click
  through menus, open records, press Back, follow breadcrumbs, open forms and trigger validation.
  Use `waitUntil:'domcontentloaded'` then wait for a selector (networkidle can hang).
- **LOOK at the screenshots** with the Read tool (it renders PNGs). JSON alone is not a visual audit.
  Read at least every page you make a claim about. Full-page shots can be tall; that is fine.

## Hard safety rules
- Read-only intent. You may create DRAFT records in ISAFlow Demo only if needed to walk a flow;
  prefix any name/reference with `UXAUDIT`. Do not post, finalise, approve, allocate, reconcile,
  run payroll, close periods, or delete existing data.
- NEVER trigger anything outbound: email/send invoice/statement runs/dunning/reminders/WhatsApp/
  SARS eFiling submit/payments/Paystack/Netcash/bank-feed connect/invites. If a button might send,
  do not click it — note it instead.
- Do not start/stop servers, do not run `bun run build`/`ci`, do not kill processes.
- Do not write to memory files or CLAUDE.md.
- Keep concurrency modest: one browser at a time per agent.

## What to evaluate (per page and per flow)
1. Works: loads without errors, no failed API calls, no NaN/undefined/blank states with data present.
2. Navigation: how you get here (menu path), breadcrumb present + correct + each crumb goes to the
   right parent, Back/Cancel/Save return to the logical previous page (not a generic list or the
   dashboard), deep-link/refresh works, active nav tab highlights correctly, no dead ends/orphans.
3. Workflow flow: next-step affordances (after creating an invoice → send/print/record payment?),
   cross-links between related records (invoice ↔ customer ↔ payment ↔ journal), bulk actions,
   empty states that tell you what to do, keyboard/search.
4. Visual/UI: hierarchy, density, consistency of headers/buttons/tables/filters with the rest of
   the app, typography, number formatting (R, thousands separators, negatives), dates (SA format),
   alignment, truncation, dark-mode if cheap to check, mobile (390px) for key pages.
5. "Next-level" gap: where does this feel legacy (form-first, module silos, report-as-a-list) vs
   modern (inbox/to-do driven, AI suggestions surfaced in context, exceptions-first, one-click next
   action, explanations of numbers)? Name concrete improvements.

## Output (write to `$AUD/findings/<area>.md`, then return a SHORT summary)
Markdown, in this structure:
```
# <Area> — audit
## Verdict (3–5 lines)
## Findings
| ID | Sev | Type | Route / flow | Finding | Evidence | Recommendation |
```
- ID `<AREA>-NN`. Sev: P0 (broken/blocks work or wrong numbers shown), P1 (major UX/navigation
  defect, dead end, wrong back target), P2 (inconsistency, polish), IDEA (next-level opportunity).
- Type: broken | navigation | breadcrumb | workflow | visual | consistency | mobile | a11y | empty-state | idea.
- Evidence: screenshot path(s) under $AUD/shots and/or `file:line` in the repo. No claim without evidence.
- Then `## Page inventory` — one row per route you covered: route | loads? | breadcrumb | notes.
- Then `## Top 5 recommendations for this area` (the ones that most change the accountant's day).
Be concrete and honest: if something is good, say so briefly; if you could not test something, say so.
Your final reply to the orchestrator: ≤15 lines — counts by severity, the P0s, and the file path.
