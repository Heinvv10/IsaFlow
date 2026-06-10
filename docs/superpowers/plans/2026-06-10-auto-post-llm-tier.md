# Auto-post LLM Tier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an LLM (Haiku 4.5) categorization tier that fills suggestions for the uncertain residual and, under a separate stricter opt-in, lets those suggestions auto-post — quarantined from the standard auto-post gate.

**Architecture:** After the existing rules→patterns→history bulk categorize, `smart-categorize` fires an in-process fire-and-forget pass that runs residual transactions through the existing `aiCategorizationService` prompt + a Haiku call (bounded by `runWithConcurrency`), persisting `suggested_*` + a new `suggested_strategy='llm'`. The auto-post gate gains a parallel LLM tier (`llm_enabled`/`llm_min_confidence`/`llm_amount_cap`) that ONLY governs `strategy='llm'` suggestions; standard-strategy suggestions keep the existing gate. A bounded client-side poll surfaces background results.

**Tech Stack:** Next.js 14 / TypeScript, Postgres (`sql` tagged template from `@/lib/neon`), Vitest (node env, `.test.ts` only — no RTL), Anthropic Messages API (Haiku 4.5), `runWithConcurrency` promise pool.

**Spec:** `docs/superpowers/specs/2026-06-10-auto-post-llm-tier-design.md`

**Key safety invariant:** A `strategy='llm'` suggestion is NEVER posted by the standard gate. It posts only when `llm_enabled` AND `confidence >= llm_min_confidence` AND within `llm_amount_cap`. Both default off/strict, and prod also lacks `ANTHROPIC_API_KEY` → doubly dormant.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `scripts/migrations/sql/493_auto_post_llm_tier.sql` | settings columns + `suggested_strategy` | Create |
| `src/modules/accounting/services/core/smartCategorizationMatchingService.ts` | extend `matchSource` union with `'llm'` | Modify |
| `src/modules/accounting/services/core/categorizationStrategy.ts` | pure `matchSourceToStrategy` mapper | Create |
| `src/modules/accounting/services/core/smartCategorizationService.ts` | persist `suggested_strategy` in bulk UPDATE | Modify |
| `src/modules/accounting/services/bank/autoPostGateService.ts` | LLM tier in `AutoPostSettings`/`evaluate`/`sweep`/settings I/O | Modify |
| `src/modules/accounting/services/bank/llmCategorizationPass.ts` | residual selector + fire-and-forget LLM pass | Create |
| `pages/api/accounting/smart-categorize.ts` | return `residualCount`, fire the pass | Modify |
| `pages/api/accounting/bank-auto-post.ts` | settings PUT accepts llm fields | Modify |
| `src/components/accounting/bank-transactions/AutoPostSettingsCard.tsx` (or current settings card) | 3 LLM controls | Modify |
| `pages/accounting/bank-transactions/index.tsx` | bounded client poll + indicator | Modify |
| `tests/unit/services/bank/autoPostGateService.test.ts` | extend evaluate/settings tests | Modify |
| `tests/unit/services/bank/llmCategorizationPass.test.ts` | residual selector + mocked pass | Create |
| `tests/unit/services/core/categorizationStrategy.test.ts` | mapper | Create |

---

### Task 1: Migration 493 — settings columns + suggested_strategy

**Files:**
- Create: `scripts/migrations/sql/493_auto_post_llm_tier.sql`

- [ ] **Step 1: Verify 493 is free**

Run: `git ls-tree -r --name-only origin/master | grep -oE 'sql/49[0-9]' | sort -u`
Expected: shows up to `490/491/492`; no `493`. If a parallel session staged `493`, renumber this file to the next free prefix (`494_…`) and keep the same content. Per `feedback_parallel_agent_migrations`, also re-check at apply time.

- [ ] **Step 2: Write the migration**

```sql
-- 493_auto_post_llm_tier.sql
-- LLM auto-post tier: separate stricter gate + persisted suggestion strategy.

ALTER TABLE bank_auto_post_settings
  ADD COLUMN IF NOT EXISTS llm_enabled        BOOLEAN       NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS llm_min_confidence NUMERIC(3,2)  NOT NULL DEFAULT 0.95,
  ADD COLUMN IF NOT EXISTS llm_amount_cap     NUMERIC(14,2) NOT NULL DEFAULT 2000;  -- 0 = no cap

-- Persisted match source for each suggestion: 'rule' | 'pattern' | 'historical' | 'llm'.
-- NULL = no suggestion yet. The auto-post gate reads this to pick the tier.
ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS suggested_strategy TEXT;
```

- [ ] **Step 3: Apply to isaflow_dev and verify columns exist**

Run:
```bash
DBURL=$(grep -E '^DATABASE_URL=' /home/hein/Workspace/IsaFlow/.env.local | cut -d= -f2-)
psql "$DBURL" -f scripts/migrations/sql/493_auto_post_llm_tier.sql
psql "$DBURL" -c "\d bank_auto_post_settings" | grep -E 'llm_enabled|llm_min_confidence|llm_amount_cap'
psql "$DBURL" -c "\d bank_transactions" | grep suggested_strategy
```
Expected: the three `llm_*` columns and `suggested_strategy` are listed. (Migration tracking by filename happens on deploy via `apply-migrations.ts`; do NOT hand-insert into `schema_migrations`.)

- [ ] **Step 4: Commit**

```bash
git add scripts/migrations/sql/493_auto_post_llm_tier.sql
git commit -m "feat(auto-post): mig 493 — LLM tier settings + suggested_strategy"
```

---

### Task 2: Pure matchSource→strategy mapper

**Files:**
- Create: `src/modules/accounting/services/core/categorizationStrategy.ts`
- Test: `tests/unit/services/core/categorizationStrategy.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { matchSourceToStrategy } from '@/modules/accounting/services/core/categorizationStrategy';

describe('matchSourceToStrategy', () => {
  it('maps matcher sources to persisted strategy tokens', () => {
    expect(matchSourceToStrategy('rule')).toBe('rule');
    expect(matchSourceToStrategy('pattern')).toBe('pattern');
    expect(matchSourceToStrategy('historical')).toBe('historical');
    expect(matchSourceToStrategy('llm')).toBe('llm');
  });
  it('is the identity for the known union (stored verbatim)', () => {
    expect(matchSourceToStrategy('llm')).toBe('llm');
  });
});
```

- [ ] **Step 2: Run it, verify FAIL**

Run: `bunx vitest run tests/unit/services/core/categorizationStrategy.test.ts`
Expected: FAIL — cannot find module `categorizationStrategy`.

- [ ] **Step 3: Implement**

```typescript
/**
 * Maps a categorization matcher's `matchSource` to the value persisted in
 * `bank_transactions.suggested_strategy`. Stored verbatim today, but isolating
 * the mapping keeps the persistence contract in one tested place.
 */
export type CategorizationStrategy = 'rule' | 'pattern' | 'historical' | 'llm';

export function matchSourceToStrategy(source: CategorizationStrategy): CategorizationStrategy {
  return source;
}

/** True when a persisted strategy must be governed by the stricter LLM gate. */
export function isLlmStrategy(strategy: string | null | undefined): boolean {
  return strategy === 'llm';
}
```

- [ ] **Step 4: Run it, verify PASS**

Run: `bunx vitest run tests/unit/services/core/categorizationStrategy.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/accounting/services/core/categorizationStrategy.ts tests/unit/services/core/categorizationStrategy.test.ts
git commit -m "feat(categorization): pure matchSource→strategy mapper + isLlmStrategy"
```

---

### Task 3: Extend matchSource union + persist suggested_strategy

**Files:**
- Modify: `src/modules/accounting/services/core/smartCategorizationMatchingService.ts` (the `CategorizationResult.matchSource` union, ~line 23)
- Modify: `src/modules/accounting/services/core/smartCategorizationService.ts` (the bulk UPDATE persist block, ~lines 175–185)

- [ ] **Step 1: Extend the union**

In `smartCategorizationMatchingService.ts`, change:
```typescript
  matchSource: 'rule' | 'pattern' | 'historical';
```
to:
```typescript
  matchSource: 'rule' | 'pattern' | 'historical' | 'llm';
```

- [ ] **Step 2: Persist the strategy in the bulk UPDATE**

In `smartCategorizationService.ts`, the matched-rows UPDATE currently sets
`suggested_gl_account_id / suggested_category / suggested_vat_code / suggested_confidence`.
Add `suggested_strategy` from the matcher result. Change the `sql` template to:
```typescript
      await Promise.all(batch.map(({ txId, result }) => sql`
        UPDATE bank_transactions SET
          suggested_gl_account_id = COALESCE(${result.glAccountId ?? null}::UUID, suggested_gl_account_id),
          suggested_category       = COALESCE(${result.category ?? null},           suggested_category),
          suggested_vat_code       = COALESCE(${result.vatCode ?? null},            suggested_vat_code),
          suggested_confidence     = ${result.confidence},
          suggested_strategy       = ${result.matchSource}
        WHERE id = ${txId}::UUID
          AND company_id = ${companyId}::UUID
          AND suggested_gl_account_id IS NULL
      `));
```

- [ ] **Step 3: Type-check**

Run: `bun run type-check`
Expected: exit 0 (the union widening is backward-compatible; existing matchers still return the narrower literals).

- [ ] **Step 4: Commit**

```bash
git add src/modules/accounting/services/core/smartCategorizationMatchingService.ts src/modules/accounting/services/core/smartCategorizationService.ts
git commit -m "feat(categorization): persist suggested_strategy from matchSource"
```

---

### Task 4: AutoPostSettings — LLM fields (type, mapper, getter, updater, validation)

**Files:**
- Modify: `src/modules/accounting/services/bank/autoPostGateService.ts`
- Test: `tests/unit/services/bank/autoPostGateService.test.ts`

- [ ] **Step 1: Write failing tests for settings validation**

Append to `autoPostGateService.test.ts`:
```typescript
import { updateAutoPostSettings } from '@/modules/accounting/services/bank/autoPostGateService';
// NOTE: updateAutoPostSettings hits the DB; validation throws BEFORE any query,
// so these assertions exercise the pure guard without a connection.

describe('updateAutoPostSettings — LLM field validation', () => {
  it('rejects llmMinConfidence outside (0,1]', async () => {
    await expect(updateAutoPostSettings('c', { llmMinConfidence: 0 }, 'u')).rejects.toThrow(/llm_min_confidence/);
    await expect(updateAutoPostSettings('c', { llmMinConfidence: 1.5 }, 'u')).rejects.toThrow(/llm_min_confidence/);
  });
  it('rejects negative llmAmountCap', async () => {
    await expect(updateAutoPostSettings('c', { llmAmountCap: -1 }, 'u')).rejects.toThrow(/llm_amount_cap/);
  });
});
```

- [ ] **Step 2: Run it, verify FAIL**

Run: `bunx vitest run tests/unit/services/bank/autoPostGateService.test.ts -t "LLM field validation"`
Expected: FAIL — `llmMinConfidence` not on the patch type / no validation.

- [ ] **Step 3: Extend the types, defaults, mapper, getter, updater**

In `autoPostGateService.ts`:

Extend `AutoPostSettings`:
```typescript
export interface AutoPostSettings {
  enabled: boolean;
  minConfidence: number;
  amountCap: number; // 0 = uncapped
  llmEnabled: boolean;
  llmMinConfidence: number;
  llmAmountCap: number; // 0 = uncapped
}
```

Extend `DEFAULTS`:
```typescript
const DEFAULTS: AutoPostSettings = {
  enabled: false, minConfidence: 0.9, amountCap: 10000,
  llmEnabled: false, llmMinConfidence: 0.95, llmAmountCap: 2000,
};
```

Extend `mapSettings`:
```typescript
function mapSettings(row: Row): AutoPostSettings {
  return {
    enabled: Boolean(row.enabled),
    minConfidence: Number(row.min_confidence),
    amountCap: Number(row.amount_cap),
    llmEnabled: Boolean(row.llm_enabled),
    llmMinConfidence: Number(row.llm_min_confidence),
    llmAmountCap: Number(row.llm_amount_cap),
  };
}
```

Extend `getAutoPostSettings` SELECT to include the new columns:
```typescript
    SELECT enabled, min_confidence, amount_cap,
           llm_enabled, llm_min_confidence, llm_amount_cap
    FROM bank_auto_post_settings
    WHERE company_id = ${companyId}::UUID
    LIMIT 1
```

Extend `AutoPostSettingsPatch`:
```typescript
export interface AutoPostSettingsPatch {
  enabled?: boolean;
  minConfidence?: number;
  amountCap?: number;
  llmEnabled?: boolean;
  llmMinConfidence?: number;
  llmAmountCap?: number;
}
```

Add validation in `updateAutoPostSettings` (after the existing two guards):
```typescript
  if (patch.llmMinConfidence != null && (patch.llmMinConfidence <= 0 || patch.llmMinConfidence > 1)) {
    throw new Error('llm_min_confidence must be within (0, 1]');
  }
  if (patch.llmAmountCap != null && patch.llmAmountCap < 0) {
    throw new Error('llm_amount_cap must be >= 0');
  }
```

Extend the upsert to COALESCE the three new fields (mirroring the existing pattern). Add the locals:
```typescript
  const llmEnabled = patch.llmEnabled ?? null;
  const llmMinConfidence = patch.llmMinConfidence ?? null;
  const llmAmountCap = patch.llmAmountCap ?? null;
```
and extend both the INSERT column/VALUES lists and the `ON CONFLICT DO UPDATE SET` with:
```sql
      llm_enabled        = COALESCE(${llmEnabled}, bank_auto_post_settings.llm_enabled),
      llm_min_confidence = COALESCE(${llmMinConfidence}::NUMERIC, bank_auto_post_settings.llm_min_confidence),
      llm_amount_cap     = COALESCE(${llmAmountCap}::NUMERIC, bank_auto_post_settings.llm_amount_cap),
```
(INSERT VALUES use `COALESCE(${llmEnabled}, FALSE)`, `COALESCE(${llmMinConfidence}::NUMERIC, 0.95)`, `COALESCE(${llmAmountCap}::NUMERIC, 2000)`.) Extend the `RETURNING` list to include the three columns.

- [ ] **Step 4: Run it, verify PASS**

Run: `bunx vitest run tests/unit/services/bank/autoPostGateService.test.ts -t "LLM field validation"`
Expected: PASS.

- [ ] **Step 5: Type-check + commit**

```bash
bun run type-check
git add src/modules/accounting/services/bank/autoPostGateService.ts tests/unit/services/bank/autoPostGateService.test.ts
git commit -m "feat(auto-post): LLM tier settings (type/getter/updater/validation)"
```

---

### Task 5: evaluate() — LLM-tier quarantine (the safety core)

**Files:**
- Modify: `src/modules/accounting/services/bank/autoPostGateService.ts` (`evaluate`)
- Test: `tests/unit/services/bank/autoPostGateService.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { evaluate, type AutoPostSettings } from '@/modules/accounting/services/bank/autoPostGateService';

const S = (o: Partial<AutoPostSettings> = {}): AutoPostSettings => ({
  enabled: true, minConfidence: 0.9, amountCap: 10000,
  llmEnabled: false, llmMinConfidence: 0.95, llmAmountCap: 2000, ...o,
});
const TX = { status: 'imported', amount: -500, suggestedGlAccountId: 'gl' };

describe('evaluate — LLM tier quarantine', () => {
  it('standard strategy with high confidence still posts (unchanged)', () => {
    expect(evaluate(TX, 0.96, S(), 'rule')).toEqual({ outcome: 'post' });
  });
  it('LLM suggestion is NOT posted by the standard gate even when standard thresholds pass', () => {
    // standard enabled, conf 0.96 >= 0.90, within standard cap — but strategy is llm and llm is disabled
    expect(evaluate(TX, 0.96, S({ llmEnabled: false }), 'llm')).toEqual({ outcome: 'skip', reason: 'llm disabled' });
  });
  it('LLM suggestion posts only under the LLM gate when enabled + above llm threshold + within llm cap', () => {
    expect(evaluate(TX, 0.96, S({ llmEnabled: true }), 'llm')).toEqual({ outcome: 'post' });
  });
  it('LLM suggestion below llm_min_confidence is skipped', () => {
    expect(evaluate(TX, 0.93, S({ llmEnabled: true }), 'llm')).toEqual({ outcome: 'skip', reason: 'llm confidence too low' });
  });
  it('LLM suggestion over llm_amount_cap is skipped', () => {
    expect(evaluate({ ...TX, amount: -2500 }, 0.99, S({ llmEnabled: true }), 'llm')).toEqual({ outcome: 'skip', reason: 'llm over amount cap' });
  });
  it('LLM tier ignores the standard enabled flag (standard off, llm on → posts)', () => {
    expect(evaluate(TX, 0.96, S({ enabled: false, llmEnabled: true }), 'llm')).toEqual({ outcome: 'post' });
  });
  it('provisional import path (confidence null, no strategy) unchanged', () => {
    expect(evaluate(TX, null, S(), null)).toEqual({ outcome: 'post' });
  });
});
```

- [ ] **Step 2: Run it, verify FAIL**

Run: `bunx vitest run tests/unit/services/bank/autoPostGateService.test.ts -t "LLM tier quarantine"`
Expected: FAIL — `evaluate` has 3 params, no strategy arg.

- [ ] **Step 3: Rewrite evaluate with the strategy param + LLM branch**

```typescript
export function evaluate(
  tx: GateTx,
  confidence: number | null,
  settings: AutoPostSettings,
  strategy: string | null,
): GateDecision {
  const isProvisionalPath = confidence === null;
  const isLlm = strategy === 'llm';

  // Rung 2 always applies: tx must be in the 'imported' state.
  if (tx.status !== 'imported') return { outcome: 'skip', reason: 'not eligible' };

  if (isLlm) {
    // LLM tier — fully separate from the standard gate.
    if (!settings.llmEnabled) return { outcome: 'skip', reason: 'llm disabled' };
    if (confidence == null || confidence < settings.llmMinConfidence) {
      return { outcome: 'skip', reason: 'llm confidence too low' };
    }
    if (settings.llmAmountCap > 0 && Math.abs(tx.amount) > settings.llmAmountCap) {
      return { outcome: 'skip', reason: 'llm over amount cap' };
    }
    if (tx.suggestedGlAccountId == null) return { outcome: 'skip', reason: 'no target' };
    return { outcome: 'post' };
  }

  // Standard tier (rules/patterns/history, or provisional import path).
  if (!settings.enabled) return { outcome: 'skip', reason: 'disabled' };
  if (!isProvisionalPath && confidence < settings.minConfidence) {
    return { outcome: 'skip', reason: 'confidence too low' };
  }
  if (settings.amountCap > 0 && Math.abs(tx.amount) > settings.amountCap) {
    return { outcome: 'skip', reason: 'over amount cap' };
  }
  if (!isProvisionalPath && tx.suggestedGlAccountId == null) {
    return { outcome: 'skip', reason: 'no target' };
  }
  return { outcome: 'post' };
}
```

Update the docstring above `evaluate` to describe the LLM branch and that the status check now precedes the feature-flag check (intentional: an LLM tx that isn't `imported` should report `not eligible`, same as before).

- [ ] **Step 4: Run the full gate test file, verify PASS (no regressions)**

Run: `bunx vitest run tests/unit/services/bank/autoPostGateService.test.ts`
Expected: PASS — both the new LLM-tier cases and all pre-existing `evaluate` cases. NOTE: pre-existing `evaluate` calls in the test file now need the 4th arg. Update each existing `evaluate(tx, conf, settings)` call in this file to `evaluate(tx, conf, settings, null)` (standard/provisional path). Run again until green.

- [ ] **Step 5: Commit**

```bash
git add src/modules/accounting/services/bank/autoPostGateService.ts tests/unit/services/bank/autoPostGateService.test.ts
git commit -m "feat(auto-post): quarantined LLM tier in evaluate()"
```

---

### Task 6: sweep() — read strategy, pass to evaluate, honor LLM-only enablement

**Files:**
- Modify: `src/modules/accounting/services/bank/autoPostGateService.ts` (`sweep`, `SweepRow`)

- [ ] **Step 1: Add suggested_strategy to SweepRow + SELECT**

In `SweepRow` add:
```typescript
  suggested_strategy: string | null;
```
In the `sweep` SELECT add `suggested_strategy` to the column list.

- [ ] **Step 2: Loosen the early-return so the LLM tier can run when standard is off**

Change:
```typescript
  if (!settings.enabled || txIds.length === 0) {
    return { runId: null, posted: 0, skipped: [] };
  }
```
to:
```typescript
  if ((!settings.enabled && !settings.llmEnabled) || txIds.length === 0) {
    return { runId: null, posted: 0, skipped: [] };
  }
```

- [ ] **Step 3: Pass strategy into evaluate**

In the loop, the `confidence` derivation stays (import → null). Pass the row strategy:
```typescript
    const decision = evaluate(
      { status: row.status, amount: Number(row.amount), suggestedGlAccountId: row.suggested_gl_account_id },
      confidence,
      settings,
      isImport ? null : (row.suggested_strategy ?? null),
    );
```

- [ ] **Step 4: Type-check + run the gate tests**

Run: `bun run type-check && bunx vitest run tests/unit/services/bank/autoPostGateService.test.ts`
Expected: exit 0 / PASS. (`sweep` is integration-tested via the existing suite + later live verify; the pure `evaluate` carries the logic.)

- [ ] **Step 5: Commit**

```bash
git add src/modules/accounting/services/bank/autoPostGateService.ts
git commit -m "feat(auto-post): sweep routes suggested_strategy through the gate"
```

---

### Task 7: Pure residual selector

**Files:**
- Create: `src/modules/accounting/services/bank/llmCategorizationPass.ts`
- Test: `tests/unit/services/bank/llmCategorizationPass.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { selectResidualTxIds, type ResidualCandidate } from '@/modules/accounting/services/bank/llmCategorizationPass';

const c = (id: string, o: Partial<ResidualCandidate> = {}): ResidualCandidate => ({
  id, suggestedGlAccountId: null, suggestedConfidence: null, status: 'imported', ...o,
});

describe('selectResidualTxIds', () => {
  it('includes imported txs with no suggestion', () => {
    expect(selectResidualTxIds([c('a')], 200)).toEqual(['a']);
  });
  it('includes imported txs whose confidence is below MEDIUM (0.60)', () => {
    expect(selectResidualTxIds([c('a', { suggestedGlAccountId: 'gl', suggestedConfidence: 0.45 })], 200)).toEqual(['a']);
  });
  it('excludes confident suggestions (>= 0.60)', () => {
    expect(selectResidualTxIds([c('a', { suggestedGlAccountId: 'gl', suggestedConfidence: 0.7 })], 200)).toEqual([]);
  });
  it('excludes non-imported txs', () => {
    expect(selectResidualTxIds([c('a', { status: 'matched' })], 200)).toEqual([]);
  });
  it('caps the residual list at maxCalls', () => {
    expect(selectResidualTxIds([c('a'), c('b'), c('d')], 2)).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: Run it, verify FAIL**

Run: `bunx vitest run tests/unit/services/bank/llmCategorizationPass.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the selector (pass orchestration added in Task 8)**

```typescript
/**
 * In-process LLM categorization pass over the uncertain residual of a smart
 * categorize. Fire-and-forget: the caller does NOT await it; results land in
 * bank_transactions as each Haiku call settles. Re-runnable + idempotent.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { runWithConcurrency } from '@/lib/bulkUpload/concurrencyQueue';

/** A transaction is "residual" if imported AND (no suggestion OR confidence < MEDIUM). */
export const RESIDUAL_CONFIDENCE_CEILING = 0.6;

export interface ResidualCandidate {
  id: string;
  status: string;
  suggestedGlAccountId: string | null;
  suggestedConfidence: number | null;
}

export function selectResidualTxIds(rows: ResidualCandidate[], maxCalls: number): string[] {
  const ids: string[] = [];
  for (const r of rows) {
    if (r.status !== 'imported') continue;
    const uncertain = r.suggestedGlAccountId == null
      || r.suggestedConfidence == null
      || r.suggestedConfidence < RESIDUAL_CONFIDENCE_CEILING;
    if (uncertain) ids.push(r.id);
    if (ids.length >= maxCalls) break;
  }
  return ids;
}
```

- [ ] **Step 4: Run it, verify PASS**

Run: `bunx vitest run tests/unit/services/bank/llmCategorizationPass.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/accounting/services/bank/llmCategorizationPass.ts tests/unit/services/bank/llmCategorizationPass.test.ts
git commit -m "feat(auto-post): pure residual selector for the LLM pass"
```

---

### Task 8: Fire-and-forget LLM pass (mocked HTTP) — daily ceiling, persist, bounded concurrency

**Files:**
- Modify: `src/modules/accounting/services/bank/llmCategorizationPass.ts`
- Test: `tests/unit/services/bank/llmCategorizationPass.test.ts`

The pass calls a single seam `categorizeOneWithLlm(tx, accounts)` so tests can mock it. Inside, it uses the existing `buildCategorizationPrompt` + `parseCategorizationResponse` from `aiCategorizationService` and the Anthropic fetch (model `claude-haiku-4-5-20251001`). The DB-touching `runLlmResidualPass` is exercised with the LLM seam and `sql` mocked; keep the DB I/O thin.

- [ ] **Step 1: Write the failing test (mock the LLM seam + a tiny fake sql)**

```typescript
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/neon', () => {
  const calls: any[] = [];
  const sql = (strings: TemplateStringsArray, ...vals: any[]) => {
    calls.push({ text: strings.join('?'), vals });
    // SELECT chart of accounts / candidate rows return [] by default; UPDATEs return []
    return Promise.resolve([]);
  };
  (sql as any).__calls = calls;
  return { sql };
});

import * as pass from '@/modules/accounting/services/bank/llmCategorizationPass';

describe('runLlmResidualPass', () => {
  it('calls the LLM seam once per residual id and persists strategy=llm', async () => {
    const seam = vi.spyOn(pass, 'categorizeOneWithLlm').mockResolvedValue({
      glAccountId: 'gl-1', vatCode: 'standard', confidence: 0.97, accountCode: '5200', accountName: 'Office',
    });
    const persisted: string[] = [];
    await pass.runLlmResidualPass('company-1', ['t1', 't2'], 'user-1', {
      maxCalls: 200, dailyRemaining: 100,
      loadAccounts: async () => [{ code: '5200', name: 'Office', type: 'expense' }],
      loadCandidates: async () => [
        { id: 't1', status: 'imported', suggestedGlAccountId: null, suggestedConfidence: null, description: 'X', amount: -100, transactionDate: '2026-01-01' },
        { id: 't2', status: 'imported', suggestedGlAccountId: null, suggestedConfidence: null, description: 'Y', amount: -200, transactionDate: '2026-01-01' },
      ],
      persist: async (txId) => { persisted.push(txId); },
      sweep: async () => ({ runId: null, posted: 0, skipped: [] }),
    });
    expect(seam).toHaveBeenCalledTimes(2);
    expect(persisted.sort()).toEqual(['t1', 't2']);
  });

  it('no-ops when dailyRemaining is 0 and logs', async () => {
    const seam = vi.spyOn(pass, 'categorizeOneWithLlm');
    await pass.runLlmResidualPass('company-1', ['t1'], 'user-1', {
      maxCalls: 200, dailyRemaining: 0,
      loadAccounts: async () => [], loadCandidates: async () => [],
      persist: async () => {}, sweep: async () => ({ runId: null, posted: 0, skipped: [] }),
    });
    expect(seam).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it, verify FAIL**

Run: `bunx vitest run tests/unit/services/bank/llmCategorizationPass.test.ts -t runLlmResidualPass`
Expected: FAIL — `runLlmResidualPass` / `categorizeOneWithLlm` not exported.

- [ ] **Step 3: Implement the seam + orchestrator with injectable deps**

Add to `llmCategorizationPass.ts`:
```typescript
import {
  buildCategorizationPrompt,
  parseCategorizationResponse,
  type ChartOfAccountEntry,
} from '@/modules/accounting/services/core/aiCategorizationService';

export interface LlmTxContext {
  id: string; status: string; suggestedGlAccountId: string | null;
  suggestedConfidence: number | null; description: string; amount: number; transactionDate: string;
}
export interface LlmCatResult {
  glAccountId: string; vatCode?: string; confidence: number; accountCode: string; accountName: string;
}

/** Single LLM seam — mocked in tests. Resolves null when no key / no usable answer. */
export async function categorizeOneWithLlm(
  tx: LlmTxContext, accounts: ChartOfAccountEntry[],
): Promise<LlmCatResult | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const prompt = buildCategorizationPrompt(
    { description: tx.description, amount: tx.amount, date: tx.transactionDate, isDebit: tx.amount < 0 },
    accounts,
  );
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 256, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!resp.ok) { log.warn('LLM categorize call failed', { status: resp.status, txId: tx.id }, 'llm-pass'); return null; }
  const body = await resp.json() as { content?: Array<{ text?: string }> };
  const text = body.content?.[0]?.text ?? '';
  const parsed = parseCategorizationResponse(text, accounts);
  if (!parsed?.accountCode) return null;
  const acct = accounts.find(a => a.code === parsed.accountCode);
  if (!acct) return null;
  // glAccountId resolution: callers pass accounts with an `id`; see loadAccounts in the runner.
  return {
    glAccountId: (acct as ChartOfAccountEntry & { id?: string }).id ?? parsed.accountCode,
    vatCode: parsed.vatCode, confidence: parsed.confidence, accountCode: parsed.accountCode, accountName: acct.name,
  };
}

export interface RunDeps {
  maxCalls: number;
  dailyRemaining: number;
  loadAccounts: () => Promise<Array<ChartOfAccountEntry & { id?: string }>>;
  loadCandidates: () => Promise<LlmTxContext[]>;
  persist: (txId: string, r: LlmCatResult) => Promise<void>;
  sweep: (txIds: string[]) => Promise<{ runId: string | null; posted: number; skipped: unknown[] }>;
}

export async function runLlmResidualPass(
  companyId: string, txIds: string[], userId: string, deps: RunDeps,
): Promise<void> {
  try {
    if (deps.dailyRemaining <= 0) { log.warn('LLM pass skipped — daily ceiling reached', { companyId }, 'llm-pass'); return; }
    const candidates = await deps.loadCandidates();
    const residualIds = selectResidualTxIds(candidates, Math.min(deps.maxCalls, deps.dailyRemaining));
    if (residualIds.length === 0) return;
    if (candidates.length > residualIds.length && residualIds.length === Math.min(deps.maxCalls, deps.dailyRemaining)) {
      log.warn('LLM pass truncated to cap', { companyId, cap: residualIds.length }, 'llm-pass');
    }
    const byId = new Map(candidates.map(c => [c.id, c]));
    const accounts = await deps.loadAccounts();
    const tagged: string[] = [];
    await runWithConcurrency(residualIds, 4, async (id) => {
      const tx = byId.get(id); if (!tx) return;
      const r = await categorizeOneWithLlm(tx, accounts);
      if (r) { await deps.persist(id, r); tagged.push(id); }
    });
    if (tagged.length > 0) await deps.sweep(tagged);
  } catch (err) {
    log.warn('LLM residual pass aborted', { companyId, error: err instanceof Error ? err.message : String(err) }, 'llm-pass');
  }
}
```

> Note for the implementer: the test spies on `pass.categorizeOneWithLlm`, so call it via the module export (it already is, since the orchestrator references the top-level function in the same module — if vitest spy interception fails under ESM, refactor to call through an internal `deps.categorizeOne` seam and inject the real one from the endpoint).

- [ ] **Step 4: Run it, verify PASS**

Run: `bunx vitest run tests/unit/services/bank/llmCategorizationPass.test.ts`
Expected: PASS (7 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/modules/accounting/services/bank/llmCategorizationPass.ts tests/unit/services/bank/llmCategorizationPass.test.ts
git commit -m "feat(auto-post): fire-and-forget LLM residual pass (mocked seam)"
```

---

### Task 9: Production wiring helpers — real loaders, persister, daily ceiling

**Files:**
- Modify: `src/modules/accounting/services/bank/llmCategorizationPass.ts`

These are the real `RunDeps` builders used by the endpoint. They are thin DB wrappers; verified by type-check + the later live test (no pure unit test).

- [ ] **Step 1: Add the real dep builder (single signature, takes the residual txIds)**

```typescript
import { sweep as gateSweep } from './autoPostGateService';

/** Builds the production RunDeps for a residual id set. Single source of truth. */
export async function buildRunDeps(companyId: string, userId: string, txIds: string[]): Promise<RunDeps> {
  return {
    maxCalls: 200,
    dailyRemaining: await llmCallsRemainingToday(companyId),
    loadAccounts: async () => {
      const rows = (await sql`
        SELECT id, account_code AS code, account_name AS name, account_type AS type
        FROM gl_accounts WHERE company_id = ${companyId}::UUID AND is_active = true
      `) as Array<{ id: string; code: string; name: string; type: string }>;
      return rows.map(r => ({ id: r.id, code: r.code, name: r.name, type: r.type }));
    },
    loadCandidates: async () => {
      const rows = (await sql`
        SELECT id, status, suggested_gl_account_id AS "suggestedGlAccountId",
               suggested_confidence AS "suggestedConfidence",
               description, amount, transaction_date AS "transactionDate"
        FROM bank_transactions
        WHERE id = ANY(${txIds}::UUID[]) AND company_id = ${companyId}::UUID
      `) as unknown as LlmTxContext[];
      return rows.map(r => ({
        ...r,
        amount: Number(r.amount),
        suggestedConfidence: r.suggestedConfidence == null ? null : Number(r.suggestedConfidence),
      }));
    },
    persist: async (txId, r) => {
      await sql`
        UPDATE bank_transactions SET
          suggested_gl_account_id = ${r.glAccountId}::UUID,
          suggested_vat_code      = COALESCE(${r.vatCode ?? null}, suggested_vat_code),
          suggested_confidence    = ${r.confidence},
          suggested_strategy      = 'llm'
        WHERE id = ${txId}::UUID AND company_id = ${companyId}::UUID`;
    },
    sweep: (txIds2) => gateSweep(companyId, txIds2, 'categorization', userId),
  };
}

/** Counts LLM-tagged auto-post activity today; returns remaining headroom under the daily ceiling. */
export const DAILY_LLM_CEILING = 1000;
export async function llmCallsRemainingToday(companyId: string): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::int AS n FROM bank_transactions
    WHERE company_id = ${companyId}::UUID AND suggested_strategy = 'llm'
      AND updated_at >= date_trunc('day', NOW())
  `) as Array<{ n: number }>;
  return Math.max(0, DAILY_LLM_CEILING - (rows[0]?.n ?? 0));
}
```
- [ ] **Step 2: Verify `bank_transactions.updated_at` exists (used by the ceiling query)**

Run:
```bash
DBURL=$(grep -E '^DATABASE_URL=' /home/hein/Workspace/IsaFlow/.env.local | cut -d= -f2-)
psql "$DBURL" -c "\d bank_transactions" | grep -E 'updated_at'
```
Expected: an `updated_at` column. If absent, change the ceiling query to count `bank_auto_post_runs` rows created today instead.

- [ ] **Step 3: Type-check + commit**

```bash
bun run type-check
git add src/modules/accounting/services/bank/llmCategorizationPass.ts
git commit -m "feat(auto-post): real RunDeps builders + daily LLM ceiling"
```

---

### Task 10: smart-categorize endpoint — residualCount + fire the pass

**Files:**
- Modify: `pages/api/accounting/smart-categorize.ts`

- [ ] **Step 1: Read the current handler to find the post-categorize return point**

Run: `sed -n '1,140p' pages/api/accounting/smart-categorize.ts` — locate where it returns the categorize summary (the `transactionIds` branch and/or the `bankAccountId` branch). Per the spec, wire the pass into the path the UI button uses.

- [ ] **Step 2: After computing the categorize result, compute residual + fire the pass**

Just before the success response, add:
```typescript
import { selectResidualTxIds, runLlmResidualPass, buildRunDeps } from '@/modules/accounting/services/bank/llmCategorizationPass';

// ... after the bulk categorize result is known and you have the affected txIds:
const candidateRows = (await sql`
  SELECT id, status, suggested_gl_account_id AS "suggestedGlAccountId",
         suggested_confidence AS "suggestedConfidence"
  FROM bank_transactions
  WHERE id = ANY(${affectedTxIds}::UUID[]) AND company_id = ${companyId}::UUID
`) as Array<{ id: string; status: string; suggestedGlAccountId: string | null; suggestedConfidence: number | null }>;
const residualIds = selectResidualTxIds(
  candidateRows.map(r => ({ ...r, suggestedConfidence: r.suggestedConfidence == null ? null : Number(r.suggestedConfidence) })),
  200,
);
if (residualIds.length > 0) {
  const deps = await buildRunDeps(companyId, req.user.id, residualIds);
  void runLlmResidualPass(companyId, residualIds, req.user.id, deps); // fire-and-forget — NOT awaited
}
return apiResponse.success(res, { /* existing fields */, residualCount: residualIds.length });
```

> `affectedTxIds` = the ids the categorize step touched (the request's `transactionIds`, or the account's imported set for the `bankAccountId` branch). Use whichever the branch already has. Use `req.user.id` (NOT `req.userId`) per the #154 convention.

- [ ] **Step 3: Type-check + build**

Run: `bun run type-check`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add pages/api/accounting/smart-categorize.ts
git commit -m "feat(auto-post): smart-categorize fires LLM residual pass + returns residualCount"
```

---

### Task 11: Settings PUT accepts LLM fields

**Files:**
- Modify: `pages/api/accounting/bank-auto-post.ts`

- [ ] **Step 1: Read the PUT branch to see how it maps the body to the patch**

Run: `sed -n '1,120p' pages/api/accounting/bank-auto-post.ts` — find where it builds the `AutoPostSettingsPatch` from `req.body`.

- [ ] **Step 2: Extend the patch mapping**

Where it reads `enabled/minConfidence/amountCap`, add the LLM fields with the same coercion pattern:
```typescript
const patch = {
  enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
  minConfidence: body.minConfidence != null ? Number(body.minConfidence) : undefined,
  amountCap: body.amountCap != null ? Number(body.amountCap) : undefined,
  llmEnabled: typeof body.llmEnabled === 'boolean' ? body.llmEnabled : undefined,
  llmMinConfidence: body.llmMinConfidence != null ? Number(body.llmMinConfidence) : undefined,
  llmAmountCap: body.llmAmountCap != null ? Number(body.llmAmountCap) : undefined,
};
```
(`updateAutoPostSettings` already validates ranges and throws → `withErrorHandler` maps to 400.)

- [ ] **Step 3: Type-check + commit**

```bash
bun run type-check
git add pages/api/accounting/bank-auto-post.ts
git commit -m "feat(auto-post): settings PUT accepts LLM tier fields"
```

---

### Task 12: Settings card — 3 LLM controls

**Files:**
- Modify: the auto-post settings card component (find with `grep -rl "minConfidence\|amountCap\|Auto-post" src/components pages/accounting/accounting-settings.tsx`)

- [ ] **Step 1: Locate the card + its draft-string input pattern**

Run: `grep -rln "amountCap\|min_confidence\|Auto-post high-confidence" src/components pages/accounting`
Read the matched file; replicate its controlled draft-string input pattern (the #154 card uses draft strings to avoid stale hydration — DO NOT use `defaultValue`).

- [ ] **Step 2: Add the LLM section mirroring the standard controls**

Add, below the standard auto-post controls, a divider + three controls bound to `llmEnabled` (toggle), `llmMinConfidence` (draft-string number), `llmAmountCap` (draft-string number), each posting to the same PUT endpoint. Label: "AI (LLM) auto-post — high-risk, off by default". Helper text: "Lets the AI tier post journal entries for transactions rules and history can't categorize, under its own stricter limits. Requires ANTHROPIC_API_KEY to be configured."

- [ ] **Step 3: Type-check + build**

Run: `bun run type-check && NODE_ENV=production bunx next build` (or rely on the CI gate at push)
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add <settings-card-file>
git commit -m "feat(auto-post): LLM tier controls in the settings card"
```

---

### Task 13: Bounded client poll for background LLM results

**Files:**
- Modify: `pages/accounting/bank-transactions/index.tsx`

- [ ] **Step 1: Add poll state + helper**

After `loadTransactions`, add:
```typescript
const [aiPolling, setAiPolling] = useState(0); // residual count being awaited; 0 = idle

const pollForLlmResults = useCallback((residualCount: number) => {
  if (residualCount <= 0) return;
  setAiPolling(residualCount);
  let ticks = 0;
  let lastLlm = -1;
  const timer = setInterval(async () => {
    ticks += 1;
    await loadTransactions();
    // Stop when stable for 2 ticks or after 8 ticks (~32s).
    const llmCount = transactionsRef.current.filter(t => (t as { suggestedStrategy?: string }).suggestedStrategy === 'llm').length;
    if ((llmCount === lastLlm && ticks > 1) || ticks >= 8) { clearInterval(timer); setAiPolling(0); }
    lastLlm = llmCount;
  }, 4000);
}, [loadTransactions]);
```
Add a `transactionsRef` (`useRef`) kept in sync with `transactions` via an effect, since the interval closure needs the latest list. Ensure the interval is cleared on unmount (`useEffect(() => () => clearInterval(...), [])` pattern — store the timer id in a ref).

> `suggestedStrategy` must be surfaced on the `BankTx` type + the `/api/accounting/bank-transactions` GET row mapping. Add `suggestedStrategy?: string` to the `BankTx` interface in `BankTxTable.tsx` and select `suggested_strategy` in the list endpoint (`pages/api/accounting/bank-transactions.ts`), mapping to `suggestedStrategy`.

- [ ] **Step 2: Call the poll after a smart categorize returns residualCount**

In `useBankTxActions` (the smart-categorize handler), capture `residualCount` from the response and invoke `pollForLlmResults(residualCount)` (thread a callback prop through, mirroring how `loadTransactions` is passed in).

- [ ] **Step 3: Render the indicator**

Where the toolbar renders, when `aiPolling > 0` show: `AI is categorizing {aiPolling} transaction(s)…` with the existing spinner style.

- [ ] **Step 4: Type-check + build**

Run: `bun run type-check`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add pages/accounting/bank-transactions/index.tsx src/components/accounting/BankTxTable.tsx pages/api/accounting/bank-transactions.ts src/components/accounting/bank-transactions/useBankTxActions.ts
git commit -m "feat(auto-post): bounded client poll surfaces background LLM suggestions"
```

---

### Task 14: Full gate + green-bar verification

- [ ] **Step 1: Run the full unit suite**

Run: `bun run test:unit`
Expected: all pass (existing 3987 + the new gate/selector/pass/mapper tests).

- [ ] **Step 2: type-check + lint**

Run: `bun run type-check && bun run lint`
Expected: exit 0 / 0.

- [ ] **Step 3: Confirm dormancy invariant in code**

Grep that no path calls the LLM pass without the residual gate, and that `evaluate` never posts `strategy='llm'` while `llmEnabled=false`:
Run: `bunx vitest run tests/unit/services/bank/autoPostGateService.test.ts -t "quarantine"`
Expected: PASS.

- [ ] **Step 4: Commit any cleanup**

```bash
git add -A && git commit -m "chore(auto-post): LLM tier green bar" || echo "nothing to commit"
```

---

## Post-plan: review, deploy, verify (orchestrator, after the build)

1. **Blind `/review`** (>500 lines likely → `review-team`, else `/review`).
2. **Live verify deferred** until `ANTHROPIC_API_KEY` is set — on the Demo only (posts real JEs): set key in dev, Smart Categorize a residual-heavy account, confirm LLM suggestions appear (`strategy='llm'`), the quarantine holds (standard auto-post doesn't fire on LLM rows; the LLM opt-in does within cap), runs panel + undo work, then revert.
3. **Deploy** via the worktree recipe (main checkout is on a parallel branch); migration 493 auto-applies. Ships **doubly dormant** (per-company LLM opt-in OFF + no prod key).

## Open follow-ups (non-blocking)
- If `categorizeOneWithLlm` spy interception is flaky under ESM, switch to an injected `deps.categorizeOne` seam (noted in Task 8).
- `llmCategorizationPass.ts` must stay < 300 lines; if it grows, split the seam (`llmCategorizeCall.ts`) from the orchestrator.
- Optional spend hardening: gate the residual pass behind `checkRateLimit('llm-pass:company:<id>')` in the endpoint (Task 10) in addition to the daily ceiling.
