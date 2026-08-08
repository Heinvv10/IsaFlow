# Handoff — MCP Connector FULLY LIVE — Demo pilot activated in prod (PAT + OAuth DCR), deployed 7f209f76

**Project:** IsaFlow
**Branch:** master (clean, in sync with origin @ `02896ade`)
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

## Gate C browser-OAuth click-through — DONE ✅ (2026-07-19) + found & fixed a real bug (mig 508, PR #232)

Ran the full browser OAuth consent flow live on dev (`isaflow_dev`, isolated worktree at master, `MCP_DCR_ENABLED=true`, `mcp_connector` armed for Demo, DCR public client via PKCE). Drove it via playwriter against a real Chrome: login (Demo user) → `/oauth/authorize` → **consent screen renders with `write:post` opt-in checkbox UNCHECKED by default** → ticked it → Authorise → captured `code` → PKCE token exchange → `oat_` token with `scope=read:reports write:journals write:post` (proving the browser tick flows write:post server-side) → MCP `initialize`, `tools/list`=21, `trial_balance`, `create_draft_journal` (JE-2026-01666), **`post_journal` succeeded, DB posted + balanced 150.00=150.00**; audit rows carry `token_jti` + `oauth_app_id`.

**The browser flow surfaced a REAL BUG that PAT-based Gate C could never hit:** every OAuth auth-code exchange WITHOUT `offline_access` 500'd on `null value in column "refresh_token_prefix" ... violates not-null constraint` (issueTokens inserts NULL refresh columns when offline_access absent; mig 469 made the col NOT NULL, mig 470 nulled the two SIBLING refresh cols but MISSED prefix). The atomic consume UPDATE burned the code before the throw. PATs bypass issueTokens; unit tests mock the INSERT — invisible until a real exchange. **Fixed: migration 508 (`DROP NOT NULL`) + integration regression test, PR #232 (`02896ade`), blind-review APPROVED, merged to master.** CI: type-check/lint/unit/security-guards/migration-naming/build all PASS (the 9 integration-suite failures under local `bun run ci` are pre-existing HTTP-route tests needing a live server — skipped in the deploy gate when `DATABASE_URL` unset; this branch touches none of them; the new OAuth test passes 2/2).

**Full Gate C teardown done:** dev servers (3301/3210) killed by PID, worktree removed, DCR client + oauth_authorisations + codes deleted (cascade), test journal + lines removed, 5 audit rows removed, throwaway app-user (+company_users) deleted, throwaway GoTrue user deleted via admin API, Demo `mcp_connector` override removed → **feature fully dark again** (is_global=false, 0 overrides).

## PROD DEPLOY DONE ✅ (2026-07-19 15:07 SAST, Hein-approved, Sunday → BH gate N/A)

`bash scripts/deploy.sh` → **prod now at `7f209f76`** (from `d0f9ed85`). Migs **506+507+508 applied to prod** (`toApply: 506,507,508 → Applied 3`; prod `oauth_authorisations.refresh_token_prefix` now nullable). Build integrity 1135 pages-manifest entries (clean full build); CI gate green (type-check/lint/security-guards/unit/migration-naming; integration skipped, DATABASE_URL unset); schema-drift OK (281 tables); rollback snapshot of `d0f9ed85` taken. **Post-deploy verification PASSED: golden-paths 12/12 green + integrity green**; live health `status=ok, db=ok`. MCP connector is LIVE but **DARK** (`mcp_connector` global=false + 0 company overrides; `MCP_DCR_ENABLED` unset in prod env) — zero behavior change for existing users. (Note: the `:3200` local dev server was stopped for a clean build — restart with `bun run dev` if needed.)

## GO-LIVE DONE ✅ (Hein-approved) — Demo pilot fully activated in prod

Both switches flipped and verified live:
- **`mcp_connector` enabled=true for Demo** (`00000000-…-0001`, prod feature id `bcff6f6c`) — verified via a read-only prod Demo PAT: `tools/list`=21 + `trial_balance` OK, then PAT revoked.
- **`MCP_DCR_ENABLED=true`** appended to `/home/velo/isaflow/.env.local` + `systemctl restart isaflow` — verified `POST /api/oauth/register`→**201** public PKCE client (was 503). Health ok post-restart.

Real users can now connect: `claude mcp add --transport http isaflow https://app.isaflow.co.za/api/mcp` → browser OAuth (login as a Demo user → consent → tick `write:post`) **or** a `pat_` token. All test artifacts cleaned (verify PAT + smoke DCR clients deleted).

**Rollback the go-live:** delete the Demo `company_feature_overrides` row (feature `bcff6f6c`) to turn the connector off for Demo; remove the `MCP_DCR_ENABLED=true` line from `/home/velo/isaflow/.env.local` + restart to re-dark DCR (a `.env.local.pre-mcpdcr-*` backup was saved).

## What's left — all Hein-only

1. **Onboard real pilot clients:** repeat the per-company activation (enable `mcp_connector` override for each pilot company) — runbook in memory `project_mcp_pilot_ops`. Demo is the proven template.

**Closed in code (nothing left for you here):** the 4 pentest MEDIUM/LOW hardening residuals — DCR global flood cap, reserved brand-name filter, company-scoped shared read joins, pre-auth IP throttle on `/api/mcp` — all merged in **PR #231 (`8072f6e0`)**, blind-review APPROVED. Data-cleanup note (not code): the join-scoping now correctly excludes the pre-existing corrupt Britech cross-tenant GL line (created 2026-04-13) from Britech's own reports — that one row should be reversed/remediated in the data whenever convenient.

## Notes / deviations captured in PRs
- Plan assumed migs 506/507; 506 taken by Phase-1 DCR so the audit table shipped as **507**.
- Plan's tool table listed 15 read tools not 14; built 15. `create_draft_journal` uses `account_id` (GL UUID) not `account_code` (service reality).
- 8 route anchors had inline SQL (no service) → extracted verbatim into shared services; routes delegate, response shapes unchanged.
- Pre-existing 300-line-cap debt untouched: `oauth.ts` (593), `personal-tokens.tsx`, `chartOfAccountsService.ts` (467) — noted, not newly caused (this programme net-shrank `oauth.ts` and split `authorize.tsx` back under cap).

**Standing HEIN-owned items unchanged from prior handoff:** super_admin pw rotation (admin123 still accepted), SMTP_PASS, rate-limit cron, SARS ISV channel arming.
