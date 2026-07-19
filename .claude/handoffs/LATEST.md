# Handoff — 2026-07-19 ~03:40 SAST — MCP Connector programme COMPLETE (Phases 0–5), Gate C Hein-gated

**Project:** IsaFlow
**Branch:** master (clean, in sync with origin @ `34091636`)
**Plan:** `docs/superpowers/plans/2026-07-18-mcp-connector.md` (all Phase 0–4 + Gate A/B/D-automated boxes ticked)
**Session goal:** Autonomously execute the MCP Connector plan phase-by-phase (branch per phase, TDD, blind review per PR, Phase-5 verification gates). Ship the dark hosted MCP server so Claude/Codex can operate IsaFlow accounting via OAuth/PAT under the tenant/RLS model.

## Status: SUCCESS — build complete + **Gate C validated live** (Hein-authorised 2026-07-19). Only the browser-OAuth click-through remains.

The entire buildable programme is **merged to master and dark** behind the per-company `mcp_connector` flag (+ `MCP_DCR_ENABLED` for dynamic registration). Seven PRs merged, all blind-reviewed; Gate A (programme review) + Gate B (pentest) findings fixed; Gate C **run live on dev and passed**; Gate D automated checks green. Nothing is blocking; prod is untouched.

**Gate C live validation (2026-07-19, dev only):** ran a fresh dev server (isolated git worktree at master `0dca5e36`, port 3210, `MCP_DCR_ENABLED=true`) against the real `isaflow_dev` DB with `mcp_connector` armed for the Demo company, driven by two minted PATs (with/without `write:post`). PASSED: `scripts/mcp-smoke.sh` = `MCP smoke OK`; 21 tools; `trial_balance` 18 rows; `create_draft_journal` → draft `a7150db3`; **`post_journal` rejected without `write:post`, posted with it** (DB: posted, balanced 100=100); audit rows carry the correct PAT jti (rejection audited `rejected`); cross-tenant `get_invoice` → generic "Not found"; FK-ownership rejects foreign account/customer; idempotency replay returns the stored result (no double-post); DCR → 201 public client. **Teardown clean** — server stopped, worktree/DCR-client removed, PATs revoked, Demo flag returned to dark. The only piece a PAT can't exercise is the **browser OAuth consent UI** (a real `claude mcp add` login) — everything it gates is proven via PAT scopes.

## What shipped (all merged to master)

| PR | Phase | What |
|----|-------|------|
| **#224** `8c5440e1` | 0 | PRD-10 auth test suite (PAT/OAuth/dual-wrapper/withScope) — 41→155 tests; proved the boundary before building on it. |
| **#225** `6b1c0a90` | 1 | OAuth discovery (RFC 8414/9728) + RFC 7591 dynamic client registration (public/PKCE-only, dark via `MCP_DCR_ENABLED`). Mig **506** `oauth_dynamic_clients` (+ `mcp_connector` flag). |
| **#226** `41659686` | 2 | JSON-RPC transport `/api/mcp` (Bearer-only, flag-gated, rate-limited) + registry (scope fence/audit/idempotency) + strict `withBearerAuth` + **15 read tools**. Mig **507** `mcp_tool_calls`. Extracted 5 inline-SQL route bodies into shared services. |
| **#227** `a093b681` | 3 | `write:post` scope (explicit unchecked opt-in) + **6 write tools** (drafts for all; `post_journal`/`finalize_invoice` behind `write:post`). Extracted invoice create/approve into services. |
| **#228** `fdbc0b96` | 4 | Connect panel `/accounting/settings/integrations-mcp` (flag-gated) + `docs/mcp-connect.md` + `scripts/mcp-smoke.sh`. |
| **#229** `d900b5a2` | 5-GateA | Programme-review fixes: commit-before-flush buffering, idempotency args-hash conflict, audit `ON CONFLICT`, sequential batch + per-RPC rate-limit, `authorize.tsx` split, savepoint-wrap write handlers. |
| **#230** `34091636` | 5-GateB | Pentest fixes: advisory-lock against concurrent double-post, log-scrubber for `client_secret`/`refresh_token`, FK-ownership validation on `customer_id`/`account_id`, `/api/mcp` body cap. |

**21 tools total** (15 read + 6 write). Core: `src/lib/mcp/**` (registry/audit/transport/tools), `src/lib/auth/{withBearerAuth,bearerPipeline,consentScopes,oauthScopes,patScopes}.ts`, `pages/api/mcp/index.ts`, `pages/api/oauth/{register,metadata,resource-metadata}.ts`.

## Verification evidence

- **CI:** `bun run ci` GREEN on every merged PR and on final master. Full unit suite **4844 pass** / 3 skip; `tsc --noEmit` clean.
- **Gate A (blind full-programme review):** 2 independent reviewers over the 8464-line union diff → 2 P1 + 3 P2, all fixed (PR #229), re-reviewed APPROVED.
- **Gate B (targeted pentest):** 3 adversarial agents → **2 CRIT / 0 HIGH / 4 MEDIUM / 3 LOW**. Both CRIT + the exploitable MEDIUM + a LOW fixed (PR #230), blind-review APPROVED. **Report: `~/.claude/scratchpad/2026-07-19_pentest-isaflow-mcp/report.md`.**
  - CRIT-1 concurrent double-post (unlocked replay-check) → `pg_advisory_xact_lock` before replay; DB-verified.
  - CRIT-2 `client_secret`/`refresh_token` logged plaintext on `/api/oauth/token` → scrubber keys+fragments.
  - MEDIUM cross-consent FK leak (foreign `customer_id`/`account_id`) → ownership validation at the MCP write boundary.
- **Gate D (regression+integrity, automated):** CI green; local integrity **12/15** — the 3 fails (530 reconciled-txn mismatches, 6 fiscal-period, 1 cross-tenant GL line created 2026-04-13 via `auto_supplier_invoice`) are **pre-existing test-company data artifacts**, none from the dark schema-only MCP work (prod Demo is 15/15 per deployment history).
- **Smoke:** `scripts/mcp-smoke.sh` written + syntax-checked (not yet run live — needs dev + a PAT).

## What's left — all Hein-only (everything code-fixable is DONE, incl. the pentest hardening residuals, closed in PR #231)

1. **Gate C browser-OAuth click-through (the one piece not yet exercised):** on a dev server with `MCP_DCR_ENABLED=true` and `mcp_connector` armed for a test company, run `claude mcp add --transport http isaflow <dev-url>/api/mcp` → browser login (Demo: admin@isaflow.co.za) → tick `write:post` on the consent screen → confirm `tools/list`=21 and a `post_journal` succeeds. (The PAT run already proved the scope enforcement this produces; this just exercises the consent UI + `oat_` token path.) Then Gate D live: fresh golden E2E 12/12 vs Demo (delete the stale `tests/e2e/.auth/golden-session.json` first); Bugsink no new issues from dev traffic.
2. **Prod deploy:** after-hours, Hein-approved, via `bash scripts/deploy.sh`, then flip `mcp_connector` per pilot (and set `MCP_DCR_ENABLED=true` if you want dynamic registration). Prod is at 505; this adds migs **506+507** (both `IF NOT EXISTS`, apply fresh).

**Closed in code (nothing left for you here):** the 4 pentest MEDIUM/LOW hardening residuals — DCR global flood cap, reserved brand-name filter, company-scoped shared read joins, pre-auth IP throttle on `/api/mcp` — all merged in **PR #231 (`8072f6e0`)**, blind-review APPROVED. Data-cleanup note (not code): the join-scoping now correctly excludes the pre-existing corrupt Britech cross-tenant GL line (created 2026-04-13) from Britech's own reports — that one row should be reversed/remediated in the data whenever convenient.

## Notes / deviations captured in PRs
- Plan assumed migs 506/507; 506 taken by Phase-1 DCR so the audit table shipped as **507**.
- Plan's tool table listed 15 read tools not 14; built 15. `create_draft_journal` uses `account_id` (GL UUID) not `account_code` (service reality).
- 8 route anchors had inline SQL (no service) → extracted verbatim into shared services; routes delegate, response shapes unchanged.
- Pre-existing 300-line-cap debt untouched: `oauth.ts` (593), `personal-tokens.tsx`, `chartOfAccountsService.ts` (467) — noted, not newly caused (this programme net-shrank `oauth.ts` and split `authorize.tsx` back under cap).

**Standing HEIN-owned items unchanged from prior handoff:** super_admin pw rotation (admin123 still accepted), SMTP_PASS, rate-limit cron, SARS ISV channel arming.
