# Auto-post LLM tier — design

**Date:** 2026-06-10
**Branch:** `feat/auto-post-llm-tier` (off `origin/master` @ b8fab2d0)
**Roadmap:** UI-modernization Phase 3 — reconciliation; follows confidence auto-post (#154) and the keyboard row-stream (#150).

## Problem

The bank categorization pipeline has three confidence sources — **rules 0.95**,
**patterns ≥0.80**, **historical 0.40–0.70** (`smartCategorizationMatchingService`,
`toConfidenceLevel`: ≥0.85 HIGH / ≥0.60 MEDIUM). With the auto-post gate's default
0.90 threshold (#154), effectively **only rules auto-post**, and the genuinely
uncertain residual — transactions no rule/pattern/history confidently matches —
falls entirely to manual review.

An LLM categorization tier already exists in code (`aiCategorizationService`
prompt/parse + `pages/api/accounting/ai-categorize.ts`, model
`claude-haiku-4-5-20251001`) but is **NOT wired into the bulk pipeline or the
auto-post gate**, and is currently inert everywhere because `ANTHROPIC_API_KEY`
is unset in both prod and dev.

## Decisions (user-confirmed)

1. **Tiered.** The LLM **always** fills suggestions for the uncertain residual;
   a **separate, stricter opt-in** lets those LLM suggestions auto-post.
2. **Execution.** Runs **in-process, fire-and-forget, after Smart Categorize**,
   bounded concurrency, UI polls (no cron/queue — IsaFlow is a persistent Node
   server).
3. **Model.** Haiku 4.5 (`claude-haiku-4-5-20251001`) — the model `ai-categorize`
   already uses; cheap classification.
4. **Build now, verify later.** Build + unit-test fully (LLM HTTP call mocked),
   merge **dormant**. Live verification + prod function wait until the user sets
   `ANTHROPIC_API_KEY`. The key is the activation step (an external secret — the
   agent never enters it).

## Architecture

### 1. Residual selection (pure)
After the existing rules→patterns→history pass, a tx is **residual** if it has no
suggestion OR its persisted `suggested_confidence` is below MEDIUM (`< 0.60`).
Pure `selectResidualTxIds(txRows)` — the TDD target. Only residuals get an LLM
call; bounds cost.

### 2. Execution (in-process background)
`smart-categorize` returns immediately with the rule/pattern/history results
(unchanged response). It then fires a `void runLlmResidualPass(companyId,
residualIds, userId)` that:
- loads the company chart of accounts once,
- runs each residual through `buildCategorizationPrompt` + a Haiku call,
  bounded by `src/lib/bulkUpload/concurrencyQueue.ts` (default 4 in flight),
- persists each result to the tx's `suggested_gl_account_id`,
  `suggested_confidence`, `suggested_vat_code`, and the new
  `suggested_strategy='llm'` as it completes,
- if `llm_enabled`, calls the existing `sweep(..., source='categorization')` for
  the freshly-LLM-tagged ids so eligible ones auto-post under the LLM gate.

Fire-and-forget means a server restart mid-pass loses the in-flight batch — this
is acceptable: the pass is idempotent and re-runnable by clicking Smart
Categorize again (logged via `log.warn` if it aborts).

**UI surfacing — bounded client-side poll (NEW; the page does NOT poll today).**
The host page calls `loadTransactions()` ONCE when `smart-categorize` returns,
which fires BEFORE the background LLM pass completes — so without a poll the LLM
suggestions never appear until a manual refresh. The `smart-categorize` response
gains a `residualCount` field. When `residualCount > 0`, the page runs a **bounded
poll**: `loadTransactions()` every 4s, up to 8 times (~32s ceiling), stopping
early once two consecutive reloads show no new `suggested_strategy='llm'` rows in
the New queue. No job record needed; the poll is purely client-side and
self-terminating. A small "AI is categorizing N transactions…" inline indicator
shows while the poll is active.

### 3. Persistence (migration 493)
- `ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS suggested_strategy TEXT`
  — values `'rules'|'patterns'|'history'|'llm'`. The existing pipeline writes its
  source; the gate reads it to apply the correct tier. (Match source is not
  persisted today.)
- `ALTER TABLE bank_auto_post_settings ADD COLUMN IF NOT EXISTS`:
  - `llm_enabled BOOLEAN NOT NULL DEFAULT false`
  - `llm_min_confidence NUMERIC NOT NULL DEFAULT 0.95`
  - `llm_amount_cap NUMERIC NOT NULL DEFAULT 2000`
- Prefix **493** (next unused on origin/master @ b8fab2d0). Re-verify free at
  apply time — parallel sessions may stage a colliding prefix (see
  `feedback_parallel_agent_migrations`); renumber to 494+ if so. `IF NOT EXISTS`
  on every statement.

### 4. Tiered auto-post gate (the safety core)
Extend `autoPostGateService`:
- `AutoPostSettings` gains `llmEnabled/llmMinConfidence/llmAmountCap`.
- `evaluate(tx, confidence, settings, strategy)` gains the suggestion strategy.
  - **standard strategy** (`rules|patterns|history`): existing
    `enabled/minConfidence/amountCap` ladder — UNCHANGED.
  - **`llm` strategy**: **excluded from the standard gate entirely**; posts only
    if `llmEnabled` AND `confidence ≥ llmMinConfidence` AND within `llmAmountCap`.
    So an overconfident LLM can never ride the normal 0.90 path — it is
    quarantined behind its own default-OFF, stricter, lower-capped opt-in.
- `sweep` reads `suggested_strategy` alongside `suggested_confidence` and passes
  it to `evaluate`. The import path (`source='import'`, provisional, confidence
  null) is unaffected (it never has an LLM strategy).

### 5. Cost controls
- Residual-only (never re-LLMs a confident tx).
- Per-run residual cap (default 200 LLM calls/run; `log.warn` the truncation —
  no silent cap).
- Reuse `ai-categorize`'s rate limits (30/ip, 60/company per 15 min) via the
  shared `checkRateLimit`.
- Per-company **daily** LLM-call ceiling (default 1000/day) checked before the
  pass; over-ceiling logs and no-ops.

### 6. UI
Settings card (`pages/accounting/accounting-settings` auto-post section) gains the
three LLM knobs (enable toggle + confidence + cap), mirroring the existing
standard auto-post controls. No new page; nav unchanged. The runs panel
(`AutoPostRunsPanel`) already shows posted/undo; LLM-sourced posts appear there
via the same `bank_auto_post_runs` record (source `categorization`).

## Data flow (unchanged endpoints)
`smart-categorize` (POST, withAuth) → existing bulk categorize → response now
carries `residualCount` → **NEW** residual fire-and-forget → Haiku per residual →
persist `suggested_*`+`suggested_strategy` → optional `sweep` under the LLM gate.
Client runs the bounded poll when `residualCount > 0`. No new API route; the
settings PUT (`bank-auto-post.ts`) extends to the three LLM fields.

## Testing
Pure/mocked unit tests are the TDD targets — no key needed:
- `selectResidualTxIds` (no-suggestion / low-confidence / confident exclusion).
- `evaluate` LLM-tier matrix: llm-disabled skip; llm below `llmMinConfidence`
  skip; llm over `llmAmountCap` skip; llm eligible post; standard strategy
  unaffected by LLM settings; LLM suggestion NOT posted by the standard gate even
  when standard threshold/cap would pass.
- settings validation (`llm_min_confidence ∈ (0,1]`, `llm_amount_cap ≥ 0`,
  COALESCE-upsert preserves false/0).
- the residual pass with the LLM HTTP call **mocked** (persists strategy='llm',
  respects the per-run cap, bounded concurrency, daily-ceiling no-op).
React glue (settings card) verified by type-check/build (repo has no RTL infra).

**Live verification (deferred until key set):** on the Demo only (posts real JEs).
Set `ANTHROPIC_API_KEY` in dev → click Smart Categorize on a residual-heavy
account → confirm LLM suggestions appear (strategy='llm'), the LLM gate quarantine
holds (standard auto-post doesn't fire on them; opt-in LLM gate does within cap),
runs panel + undo work → revert seed.

## Risk / safety
LLM journal entries are quarantined behind a **default-OFF, stricter (0.95),
lower-capped (R2,000)** gate; the standard auto-post path is untouched; default
behavior is unchanged until a company opts into the LLM tier. The feature is
**doubly dormant** in prod — both the per-company LLM opt-in AND the absent
`ANTHROPIC_API_KEY` must change for any LLM JE to post. No PII leaves the system
beyond the transaction description + chart-of-accounts names already sent by the
existing `ai-categorize` endpoint.

## Out of scope (YAGNI)
- Durable cron/queue execution (chosen against; in-process is enough with no real
  users yet).
- LLM confidence recalibration model (trust Haiku's self-reported score, clamped
  only by the gate — never trusted onto the standard path).
- Per-row "Ask AI" button (separate manual flow; not this feature).
