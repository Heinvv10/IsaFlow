# Confidence Auto-Post — Design Spec

**Date:** 2026-06-10
**Status:** Approved (brainstorm 2026-06-10; safety model, threshold, cap, unification, and audit/undo each confirmed with the user)
**Phase:** UI-modernization Phase 3, increment 2 (follows #150 keyboard row-stream)

## Goal

One gated, auditable, silent auto-poster for bank transactions. High-confidence
categorization suggestions post journal entries without human action — but only
through a per-company safety gate (opt-in, confidence threshold, amount cap),
with run-level audit and one-click bulk-undo.

This increment also **retrofits the existing PRD-05 provisional poster** under
the same gate. Today `bankImportService` calls `autoProvisionalBatch` on every
import's outflows and posts real JEs at ≥0.7 predictor confidence with no
opt-in and no cap. After this increment, that path only runs for companies
that have enabled auto-post, at their threshold and cap.

## Decisions (user-confirmed)

| Question | Decision |
|---|---|
| Safety model | Gated silent auto-post (not a bulk-accept queue) |
| Threshold | Per-company, default **0.90**, opt-in **OFF** by default |
| Amount cap | Per-company, default **R10,000**; `0` = no cap |
| Relation to PRD-05 provisional | **Unify** — one gate service, both paths route through it |
| Audit & undo | Run record per sweep + bulk-undo of a whole run |

### Why 0.90

Confidence sources today: rule matches are hardcoded 0.95 (and rules already
have their own `auto_create_entry` silent path), seeded merchant patterns are
0.80–0.90, learned patterns default 0.80, historical matches 0.40–0.70, the
provisional predictor is 0–1. At 0.90 the high-confidence patterns qualify but
weaker learned/historical matches do not. The accountant lowers it per client
as trust builds.

## Data model — migration `492_bank_auto_post.sql`

```sql
CREATE TABLE IF NOT EXISTS bank_auto_post_settings (
  company_id     UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  enabled        BOOLEAN NOT NULL DEFAULT FALSE,
  min_confidence NUMERIC(3,2) NOT NULL DEFAULT 0.90,
  amount_cap     NUMERIC(14,2) NOT NULL DEFAULT 10000,  -- 0 = no cap
  updated_by     UUID,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bank_auto_post_runs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source         TEXT NOT NULL CHECK (source IN ('import','categorization','manual')),
  min_confidence NUMERIC(3,2) NOT NULL,   -- snapshot at run time
  amount_cap     NUMERIC(14,2) NOT NULL,  -- snapshot at run time
  posted_count   INTEGER NOT NULL DEFAULT 0,
  total_amount   NUMERIC(14,2) NOT NULL DEFAULT 0,  -- sum of |amount|
  created_by     UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  undone_at      TIMESTAMPTZ,
  undone_by      UUID
);
CREATE INDEX IF NOT EXISTS idx_bapr_company ON bank_auto_post_runs(company_id, created_at DESC);

ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS auto_post_run_id UUID REFERENCES bank_auto_post_runs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_bt_auto_post_run ON bank_transactions(auto_post_run_id)
  WHERE auto_post_run_id IS NOT NULL;
```

**No settings row = disabled.** At deploy, every company's provisional
auto-posting therefore switches OFF until someone opts in. This is the
intended behavior change.

## Service — `src/modules/accounting/services/bank/autoPostGateService.ts`

Mirrors the capture-side `autoPublishGateService` decision-ladder shape.
Max 300 lines; split a `autoPostUndoService.ts` if needed.

### `evaluate(tx, confidence, settings): GateDecision` — PURE

Decision ladder, first failure wins:

1. `settings.enabled` is false → skip `'disabled'`
2. `tx.status !== 'imported'` → skip `'not eligible'`
3. `confidence != null && confidence < settings.min_confidence` → skip
   `'confidence too low'` (`confidence: null` defers this rung to the poster —
   only the provisional path does this, and `postProvisional` enforces
   `minConfidence` internally)
4. `settings.amount_cap > 0 && |tx.amount| > settings.amount_cap` → skip `'over amount cap'`
5. No postable target (no `suggested_gl_account_id` for the suggestion path /
   no prediction for the provisional path) → skip `'no target'`
6. → `post`

Returns `{outcome:'post'} | {outcome:'skip', reason}`. Pure function — the
primary TDD target.

### `sweep(companyId, txIds, source, userId): SweepResult`

- Load settings; **early-out if absent/disabled** (no run row, no queries per tx).
- For each tx: evaluate → if `post`, lazily create the run row (first post
  only — a sweep that posts nothing leaves no run row), post, then tag
  `bank_transactions.auto_post_run_id`.
- Posting reuses existing plumbing — **no new JE construction code**:
  - **Suggestion path** (tx has `suggested_gl_account_id` + `suggested_confidence`):
    call `allocateTransaction(companyId, txId, suggestedGlAccountId, userId,
    description, 'account', undefined, suggestedVatCode)` — byte-identical to
    a human accepting the suggestion. Add one optional trailing
    `opts?: { postingAgent?: string }` param to `allocateTransaction`,
    threaded to its `createJournalEntry` call (which already accepts
    `postingAgent` meta — see `postProvisional`); the sweep passes
    `'auto-post:v1'`, human callers pass nothing and are unaffected.
  - **Provisional path** (import sweep, outflows without suggestions): the
    predictor's confidence is only computed inside `postProvisional`, so the
    gate runs rungs 1/2/4 (enabled, status, cap) up front via `evaluate` with
    `confidence: null` treated as "defer", then calls
    `postProvisional(companyId, txId, userId, { minConfidence: settings.min_confidence })`,
    which enforces the confidence rung internally and keeps the
    `ai-provisional:v1` + `needs_evidence` + chase-job lifecycle. Its
    `skipped: 'low confidence'` result is recorded as a gate skip.
- Per-tx failures: log + continue (same posture as `autoProvisionalBatch`),
  never abort the sweep. NOT silent — every skip/failure is logged with reason.
- Finalize run row (`posted_count`, `total_amount`).
- Returns `{ runId: string | null, posted: number, skipped: Array<{txId, reason}> }`.

### `undoRun(companyId, runId, userId)`

- Load run (company-scoped); reject if already `undone_at`.
- For each tx tagged with the run: if since `reconciled` → **skip** (books
  hygiene); else reverse via the existing unmatch path
  (`reverseJournalEntry` + tx reset in `bankAllocationService`), clear
  `auto_post_run_id`.
- Provisional-path txs reverse their `provisional_je_id` the same way.
- Mark run `undone_at`/`undone_by`. Returns `{reversed, skipped}` — partial
  undo (some reconciled) leaves the run marked undone with the counts in the
  response and log.

### Settings accessors

`getAutoPostSettings(companyId)` (absent row → disabled defaults) and
`updateAutoPostSettings(companyId, patch, userId)` (upsert; validate
`0 < min_confidence <= 1`, `amount_cap >= 0`).

## Wiring (two call sites)

1. **`bankImportService`**: replace the direct `autoProvisionalBatch(...)`
   call with `sweep(companyId, outflowIds, 'import', systemUser)`. The
   try/catch non-fatal posture stays. `autoProvisionalBatch` export is removed
   (gate-only entry).
2. **`smart-categorize` POST** (`bulkCategorize` flow): after suggestions are
   written, `sweep(companyId, categorizedTxIds, 'categorization', userId)` —
   so enabling auto-post + running categorization sweeps the queue in one go.

## API — `pages/api/accounting/bank-auto-post.ts`

Standard stack: `withAuth(withErrorHandler(handler as never))` + `withCsrf` +
`withWriteAccess` on mutations, `apiResponse` helpers, zod body validation.

- `GET` → `{ settings, runs }` (settings or defaults; last ~20 runs with counts)
- `PUT` `{ enabled?, minConfidence?, amountCap? }` → upsert settings
- `POST` `{ action: 'undo', runId }` → `undoRun` result

## UI

- **Settings card** — toggle + threshold + cap, added to
  `pages/accounting/accounting-settings.tsx` following its existing
  settings-card patterns. Copy must say plainly: "Posts journal entries automatically. Transactions
  above the cap or below the confidence threshold always go to review."
- **Runs panel** on the bank-transactions page — recent runs:
  "Auto-posted 14 (R23,410) · 2h ago · Undo". Auto-posted txs leave the New
  queue naturally (status changes); they carry an "Auto" badge in
  Allocated/Matched views via `auto_post_run_id IS NOT NULL`.
- No new nav entry (no new page).

## Multi-tenant & safety invariants

- Every query carries `company_id` (settings PK, runs scoped, undo scoped).
- Gate default is **OFF**; absence of a row must behave exactly as
  `enabled=false` everywhere.
- `evaluate` is the only place eligibility logic lives — both paths and any
  future source (LLM tier) must go through it.
- Undo never touches reconciled transactions.

## Testing

TDD (tests first) in `tests/unit/services/`:

- `evaluate` — every rung of the ladder, boundary values (confidence exactly
  at threshold posts; amount exactly at cap posts; cap 0 = uncapped).
- `sweep` — disabled early-out creates no run; lazy run creation; per-tx
  failure isolation; run totals.
- `undoRun` — reconciled-skip, already-undone rejection, company scoping.

Browser verification on the **ISAFlow Demo company only** — auto-post writes
real JEs (same rule as the standing recon-accept demo-verify TODO; never on
Brightsphere's real books).

## Out of scope (this increment)

- Per-source toggles (rules/patterns/historical) — needs `matchSource`
  persisted on `bank_transactions`; future increment if wanted.
- LLM categorization tier (Phase 3 later increment) — will feed the same gate.
- Inflow/receipt auto-post beyond what suggestions already cover.
- Changes to bank-rule `auto_create_entry` (separate, pre-existing mechanism).
