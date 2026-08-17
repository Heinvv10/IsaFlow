> **There is a second open handoff:** `.claude/handoffs/2026-08-17-0941-mcp-connector-next-features.md` (MCP connector — next-features roadmap, Tier 1 payments vs VAT201 wedge). Read it if continuing that work. NOTE: it references master @ `16b0b7f2`, which is stale — master is now `6b81b3c8`.

# Handoff — 2026-08-17 09:55 SAST

**Project:** IsaFlow
**Branch:** `master`, clean, in sync with `origin/master` @ `6b81b3c8`
**Session goal:** Continue from the prior handoff; ended up fixing the group-companies feature end to end, which uncovered a systemic API-envelope defect class. **Next session's job: triage and fix that class.**

## Status

Production = master = **`6b81b3c8`**, deployed 2026-08-17 09:46:59 SAST (business hours, on Hein's explicit instruction). 0 migrations, golden paths 12/12, integrity 15/15, 0 restarts, 0 journal errors. Rollback target **`cb4476fc`** at `/home/velo/isaflow-rollback`.

The group-companies feature now works and **was verified in a real browser** — `/accounting/group` renders Incendio Global with 3 entities, populated stat cards and a reconciling entity table, zero console errors. Screenshot at `/tmp/claude-1003/-home-hein-Workspace-IsaFlow/2ff16a3a-fb35-43c8-9ae3-43ba4c5ecf40/scratchpad/group-renders.png` (temp — copy it if you need it).

**The open work is a defect class, not a feature.** A blind-review repo sweep (~483 `.json()` call sites) found **13 HIGH/HIGH-MEDIUM UI bugs** where a call site re-guesses the API response envelope. Full detail in memory: **`project_api_envelope_defect_class`**.

## What got done this session

Four PRs, all merged and deployed:

| PR | Squash | What |
|---|---|---|
| #248 | `f631ad70` | continuous-close 42703 — 4 dead schema references |
| #249 | `3e20746f` | vestigial `bank_accounts` table read in 3 live call sites |
| #250 | `1f75cddb` | 16 user-identity `::UUID` casts throwing `text = uuid` |
| #251 | `cb4476fc` | group setup surface — 9 casing/action breakages |
| #252 | `6b81b3c8` | group dashboard page crash + 5th envelope instance |

Also deployed the 8 pentest fixes that were merged-but-undeployed at session start (incl. a live cross-tenant NL-query bypass).

New CI step **`user-id-casts`** (`scripts/ci/audit-user-id-casts.ts` + `userIdCastRules.ts`, 14 own unit tests) wired into BOTH `scripts/ci/run-ci.sh` and `.github/workflows/ci.yml`.

**Incendio Global group created in prod** (`ac239a4d-b912-4fdf-9f0b-94507304cbd8`): Brightsphere, H10 Holdings, Velocity Fibre. `holding_company_id` is **NULL by Hein's decision** — Incendio itself is the holding company and has no company record in IsaFlow. **Do not create an Incendio tenant or set a holding company without asking.**

## What's next

**Triage and fix the API-envelope defect class.** Read `project_api_envelope_defect_class` in memory first.

### Confirmed by direct code inspection (6)

| # | File | Reads | API returns | Symptom |
|---|---|---|---|---|
| 1 | `pages/admin/users/[id].tsx:158` | `json.data.token` | `pages/api/admin/users/[id]/impersonate.ts:116` → `{data:{redirect}}`, never a token (auth is cookie-based) | **Admin "Login As" 100% broken** — always throws `'No token returned'` AFTER the impersonation succeeded server-side |
| 2 | `src/components/dashboard/widgets/VatSummaryWidget.tsx:52-56` | `output_vat`/`outputVat`/`input_vat`/`inputVat`/`net_vat`/`netVat` | `vatReturnService.ts:187-189` → `outputVAT`/`inputVAT`/`netVAT` (full-caps VAT) | **Dashboard VAT always R0.00** |
| 3 | `pages/accounting/settings/currencies.tsx:33` | `json.data?.currencies` | `pages/api/accounting/currencies.ts:20` → `apiResponse.success(res, currencies)` = bare array | Currencies list always empty |
| 4-6 | `pages/accounting/migration/{ar-invoices,customers,opening-balances}.tsx` | `sessionJson.data?.id` | `pages/api/accounting/migration/session.ts:31,46` → `{data:{session:{...}}}` | **3 of 4 migration flows always fail "No active session."** `migration/index.tsx:76` unwraps correctly (`json.data.session ?? json.data`) — proves the other three are the regression, not shape ambiguity |

### Reported by the sweep, NOT independently verified (7) — verify before fixing

- `pages/accounting/expenses/[id].tsx:117` — `json.data?.accounts`; GL account dropdown always empty
- `pages/accounting/batch-payments/[batchId].tsx:178` — `batch.payments`; claim is the mapper never sets it at all
- `src/components/.../CaptureApiKeysSection.tsx` + `ThreeWayMatchPanel.tsx` — `json.error` assumed string, actually `{code,message}` → React "objects are not valid as a child" **crash**
- `pages/accounting/capture/settings.tsx` — inbox address never shows
- `pages/accounting/suppliers/[supplierId]/rules.tsx` — cost-centre picker never renders
- `src/components/.../TimeEntryForm.tsx` — templates/work-items/rate all broken
- `OverviewTab.tsx` (provisional-entries banner), `DetailsTab.tsx` + `company-settings.tsx` (documents tab empty)
- plus ~10 LOW `{error:string}` vs `{error:{code,message}}` → `[object Object]` toasts across practice/bank/financial-years pages

## Open questions / blockers

- **HEIN'S DECISION, still unanswered: structural fix vs patch round.** Options put to him: (a) build a typed `apiFetch<T>()` forcing callers to import the real response type, plus a CI guard banning bare `.json()` casts, THEN sweep; (b) fix the worst 3-4 now (Login-As, VAT widget, migration sessions) and defer the structural work; (c) catalogue and decide later. **My recommendation was (a)** — this class was declared closed twice and was wrong twice; fixing 13 sites against the same untyped floor yields a 14th. Counter-argument: the typed-client work is day-shaped, and three of the bugs are user-facing and cheap now.
- **Proposed CI guard shape** (narrow, to stay decidable): flag files that BOTH declare a local `interface`/`type` AND contain `res.json()` / `json.data ?? json`, requiring an explicit opt-out comment. Precedent that worked: `scripts/ci/audit-user-id-casts.ts`.
- **Off-host backup destination** — unchanged, asked repeatedly across sessions, still unanswered. Daily dumps + weekly base + continuous WAL + Sunday restore drill all exist but ALL on this one machine. Options: `fibreflow-wa-vps` over Tailscale, or cloud object storage.

## Context the next session needs

- **The defect is NOT scoped by directory.** Two sweeps were scoped by folder and both missed live bugs. The defect shape is "a UI file declares its own copy of an API response shape and feeds an untyped `res.json()` into it". Sweep repo-wide by shape.
- **The fix pattern that works:** stop redeclaring — import or re-export the service's own exported type. In #252, deleting one local redeclaration surfaced **26 compile errors** that had all been silent `undefined` reads. tsc becomes the guard once the local type is gone.
- **A test asserting a hardcoded fixture against a TYPE is decorative.** Mine passed 8/8 with the production page reverted to the exact crash, while its own comment claimed it would fail. Blind review caught it. Test the real service against the real schema; let tsc guard field names. Deleted file: `tests/unit/components/groupDashboardContract.test.ts`.
- **A dead code path hides its own bugs.** Three times this session, repairing a path exposed the next defect behind it: #250's guard threw before #249's repaired queries ran; #251's casing fix would have activated an ungated `holdingCompanyId` (pentest-H1 vector); #252's crash only became reachable once #250 and the group creation both landed. When reviving a dead path, re-review every guard it passes and every field it forwards.
- **"The SQL works" is not "the route works", and "the API works" is not "the page renders."** I reported the group dashboard fixed twice on query-level proof. It crashed on the first real browser load. For anything user-facing, load it.
- **Integration-test baseline is 33 failures / 14 files** (`api/health`, `api/zod-validation`, `csp-headers`, `rls-policy-coverage`) — pre-existing, need a running dev server + GoTrue. `bun run ci` exits 1 because of them. Compare the failing FILE SET against `origin/master`, not the pass count.
- **`bun run ci` runs integration only if `DATABASE_URL` is exported.** In a bare shell it silently skips. `.env.local` cannot be `source`d (line 34 `SMTP_FROM=ISAFlow <noreply@...>` is unquoted).
- **Query params on `/api/accounting/company-groups` are snake_case; JSON bodies are camelCase.** Deliberate, not a tidy-up target — the DELETE branches read `req.query.member_id`. `src/components/accounting/group/groupRequests.ts` encodes both.
- **Fixture UUIDs must be valid hex.** `...cu01` and `...bas0` were both rejected (`u`, `s` are not hex). Cost two round trips.
- **`pgrep -f "next dev|next-server"` self-matches your own shell** whose cmdline contains the pattern. It produced three false "dev server running" alarms. Verify via `/proc/PID/cwd` and `ls -la /proc/PID`, or check the listening port owner. Port 3200 belongs to **ApexSignal**, not IsaFlow.
- **Deploy timing:** a ~6-minute deploy started after ~07:52 on a weekday WILL cross the 08:00 gate. Don't treat "started before 08:00" as "finished before 08:00".
- **Read the rollback target off the deploy log's `Snapshotting current release (SHA)` line.** I twice stated a stale prod SHA from memory; the snapshot line is the authority.

### DO NOT RESURRECT

- **`userCreatedGroup` on the `auto-map` handler** — it was applied there by accident (Python `str.replace()` has no count limit and `auto-map` had a byte-identical guard block), reverted after review. `auto-map` is membership-only. `userCreatedGroup` exists ONLY to let a group creator add the FIRST member, and must NOT be folded into `userBelongsToGroup`, which fronts consolidated financial reads and stays membership-only.
- **`listGroups()`** in `groupCrudService.ts` — unscoped, returns every tenant's groups. No caller; documented as a footgun. Use `listGroupsForUser(userId)`.
- **A local `interface` mirroring an API response** anywhere in `pages/` or `src/components/` — that IS the defect class.

## Git state

- **Uncommitted:** clean (`.claude/audit-manifest.json` and `.claude/handoffs/LATEST.md` were modified earlier this session and have since been committed/superseded)
- **Unpushed commits:** none
- **Stashes:** 16, all pre-dating this session
- **Worktrees:** 15

## Session teardown

Nothing from this session is running. These belong to **other projects** and were already running — do not kill them:
- PID 1195412 / 1195418 — `next dev` in `/home/hein/Workspace/FF_Next.js-actions` (FibreFlow)
- PID 3147030 — `next dev` in `/home/hein/Workspace/FF_Next.js-histstock` (FibreFlow)

No `gh run watch`, no test DB containers, no IsaFlow dev server.

## Where to resume

```bash
git fetch origin && git log origin/master --oneline -5
curl -s https://app.isaflow.co.za/api/health
```

Then read memory `project_api_envelope_defect_class`, and **ask Hein the structural-vs-patch question before writing code** — it changes the shape of the whole task.
