# Confidence Auto-Post Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One gated, auditable, silent auto-poster for bank transactions — high-confidence categorizations post journal entries automatically, but only through a per-company safety gate (opt-in, confidence threshold, amount cap), with run-level audit and one-click bulk-undo.

**Architecture:** A pure `evaluate` decision-ladder gate (mirroring `autoPublishGateService`) is the single eligibility authority. A `sweep` orchestrator routes the two existing posting paths — the suggestion path (`allocateTransaction`, identical to a human accept) and the PRD-05 provisional path (`postProvisional`) — through that gate, records a run row, and tags each posted tx. `undoRun` reverses a whole run via the existing `reverseJournalEntry`/tx-reset plumbing, skipping reconciled txs. The retrofit deliberately turns provisional auto-posting OFF for every company until they opt in.

**Tech Stack:** Next.js 14 + TypeScript, Postgres (Supabase) via `sql` tagged template from `@/lib/neon`, Vitest unit tests, `withAuth`/`withCsrf`/`withWriteAccess` API stack, Tailwind + `--ff-*` design tokens.

---

## Spec

`docs/superpowers/specs/2026-06-10-confidence-auto-post-design.md` (commit `c1f4132d`). Read it before starting.

## Grounding facts (verified against the worktree)

- Latest migration is `490_…`; **491 is free.**
- `allocateTransaction` signature (`bankAllocationService.ts:78`): `(companyId, bankTxId, contraAccountId, userId, description?, allocType='account', entityId?, vatCode?, cc1Id?, cc2Id?, buId?, invoiceId?)`. Posting agent is set at line 247–250 (`allocationMeta.postingAgent = 'system:bank-allocation:v1'`). We add an optional **13th** param.
- `postProvisional(companyId, bankTxId, userId, { minConfidence })` (`provisionalPostingService.ts:151`) returns `{ journalEntryId, prediction, skipped? }`; enforces `minConfidence` internally; sets tx → `status='provisional'`, `provisional_je_id`. `autoProvisionalBatch` (`:277`) is the batch wrapper we are removing.
- `autoProvisionalBatch` is referenced in exactly 3 files: `provisionalPostingService.ts` (def), `bankImportService.ts` (two call sites — lines **99** and **253**, both inside best-effort try/catch with `systemUser = '00000000-0000-0000-0000-000000000000'`), and `tests/unit/services/bank/bankImportService.bulk.test.ts` (mock).
- `bulkCategorize(companyId, transactionIds)` (`smartCategorizationService.ts:80`) returns `{ categorized, skipped, results: Array<{ transactionId, result }> }`; matched rows have non-null `result`. POST handler is `pages/api/accounting/smart-categorize.ts:76`.
- `reverseReconciledTransaction(companyId, bankTxId, userId)` (`bankAllocationService.ts:471`) reverses the JE behind `matched_journal_line_id` and resets the tx to `imported`; it requires status `allocated|matched|reconciled`. It does NOT handle `provisional` status and does NOT clear `auto_post_run_id`.
- `reverseJournalEntry(companyId, jeId, userId)` is re-exported from `gl/journalEntryService`.
- `JournalEntryMeta` (`gl/journalEntryMeta.ts`): `{ postingAgent: string; sourceDocumentId?; sourceDocumentHash?; extractionConfidence? }`. Documented agent format is `'ai:<pipeline>:v1'` — **our agent string is `'ai:auto-post:v1'`** (the spec's shorthand "auto-post:v1" normalised to the documented format).
- `CompanyAuthedRequest` exposes `companyId` and `userId` (`src/lib/auth/types.ts`).
- API stack precedent (`chase-settings.ts`): `export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))))`.
- `apiResponse` helpers available: `success`, `badRequest`, `badRequestFromError`, `notFound`, `forbidden`, `methodNotAllowed`.
- Bank-transactions "New" tab maps to status `imported` (`bank-transactions/index.tsx:25`), so auto-posted txs leave the New queue naturally.
- Test mocking style (`bankImportService.bulk.test.ts`): `vi.hoisted` to build `sqlMock = Object.assign(vi.fn(), { unsafe: vi.fn() })`, then `vi.mock('@/lib/neon', …)`. Tests route on `strings.join('?')`.

## File structure

| File | Responsibility |
|---|---|
| `scripts/migrations/sql/491_bank_auto_post.sql` | settings + runs tables, `auto_post_run_id` column |
| `src/modules/accounting/services/bank/autoPostGateService.ts` | `evaluate` (pure), settings accessors, `sweep` |
| `src/modules/accounting/services/bank/autoPostUndoService.ts` | `undoRun` (kept separate to respect 300-line cap) |
| `tests/unit/services/bank/autoPostGateService.test.ts` | gate + sweep tests |
| `tests/unit/services/bank/autoPostUndoService.test.ts` | undo tests |
| `src/modules/accounting/services/bank/bankAllocationService.ts` | +optional `postingAgent` param (1 line of signature, 1 line of meta) |
| `src/modules/accounting/services/capture/provisionalPostingService.ts` | remove `autoProvisionalBatch` |
| `src/modules/accounting/services/bank/bankImportService.ts` | swap both call sites → `sweep(..., 'import', ...)` |
| `pages/api/accounting/smart-categorize.ts` | sweep after `bulkCategorize` |
| `tests/unit/services/bank/bankImportService.bulk.test.ts` | re-point mock from `autoProvisionalBatch` → `sweep` |
| `pages/api/accounting/bank-auto-post.ts` | GET settings+runs / PUT settings / POST undo |
| `pages/accounting/accounting-settings.tsx` | auto-post settings card |
| `src/components/accounting/bank-transactions/AutoPostRunsPanel.tsx` | runs panel + Undo |
| `pages/accounting/bank-transactions/index.tsx` | mount the runs panel |

---

## Task 1: Migration — `491_bank_auto_post.sql`

**Files:**
- Create: `scripts/migrations/sql/491_bank_auto_post.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 491_bank_auto_post.sql
-- Confidence Auto-Post (UI-modernization Phase 3, increment 2).
-- Per-company opt-in gate + run-level audit for silent JE auto-posting.
-- Retrofits PRD-05 provisional posting under the same gate: with no settings
-- row a company is DISABLED, so provisional auto-posting switches OFF for every
-- company at deploy until someone opts in. This is the intended behavior change.

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

- [ ] **Step 2: Verify it applies cleanly**

Run: `bun run db:migrate`
Expected: applies `491_bank_auto_post.sql`, no error. (If the DB is unreachable in this environment, instead run `psql … -f scripts/migrations/sql/491_bank_auto_post.sql` against a scratch DB, or at minimum eyeball that every `CREATE`/`ALTER` carries `IF NOT EXISTS`.)

- [ ] **Step 3: Commit**

```bash
git add scripts/migrations/sql/491_bank_auto_post.sql
git commit -m "feat(banking): migration 491 — bank auto-post settings + runs"
```

---

## Task 2: Gate types + pure `evaluate`

**Files:**
- Create: `src/modules/accounting/services/bank/autoPostGateService.ts`
- Test: `tests/unit/services/bank/autoPostGateService.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { evaluate, type AutoPostSettings, type GateTx } from '@/modules/accounting/services/bank/autoPostGateService';

const ON: AutoPostSettings = { enabled: true, minConfidence: 0.9, amountCap: 10000 };
const tx = (over: Partial<GateTx> = {}): GateTx => ({
  status: 'imported', amount: -500, suggestedGlAccountId: 'gl-1', ...over,
});

describe('evaluate — decision ladder', () => {
  it('skips when disabled', () => {
    expect(evaluate(tx(), 0.99, { ...ON, enabled: false })).toEqual({ outcome: 'skip', reason: 'disabled' });
  });

  it('skips when tx not imported', () => {
    expect(evaluate(tx({ status: 'allocated' }), 0.99, ON)).toEqual({ outcome: 'skip', reason: 'not eligible' });
  });

  it('skips when confidence below threshold', () => {
    expect(evaluate(tx(), 0.89, ON)).toEqual({ outcome: 'skip', reason: 'confidence too low' });
  });

  it('posts when confidence is exactly at threshold', () => {
    expect(evaluate(tx(), 0.9, ON)).toEqual({ outcome: 'post' });
  });

  it('skips when amount over cap', () => {
    expect(evaluate(tx({ amount: -10000.01 }), 0.99, ON)).toEqual({ outcome: 'skip', reason: 'over amount cap' });
  });

  it('posts when amount is exactly at the cap', () => {
    expect(evaluate(tx({ amount: -10000 }), 0.99, ON)).toEqual({ outcome: 'post' });
  });

  it('treats cap of 0 as uncapped', () => {
    expect(evaluate(tx({ amount: -999999 }), 0.99, { ...ON, amountCap: 0 })).toEqual({ outcome: 'post' });
  });

  it('skips suggestion-path tx with no target', () => {
    expect(evaluate(tx({ suggestedGlAccountId: null }), 0.99, ON)).toEqual({ outcome: 'skip', reason: 'no target' });
  });

  it('defers confidence + no-target rungs when confidence is null (provisional path)', () => {
    // confidence null → rungs 1/2/4 only; target is resolved inside postProvisional
    expect(evaluate(tx({ suggestedGlAccountId: null }), null, ON)).toEqual({ outcome: 'post' });
  });

  it('still enforces enabled/status/cap on the provisional path', () => {
    expect(evaluate(tx({ amount: -20000, suggestedGlAccountId: null }), null, ON))
      .toEqual({ outcome: 'skip', reason: 'over amount cap' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:unit -- autoPostGateService`
Expected: FAIL — `Cannot find module '@/modules/accounting/services/bank/autoPostGateService'`.

- [ ] **Step 3: Write the gate module (types + pure `evaluate` only for now)**

```typescript
/**
 * Auto-Post Gate Service
 * Single eligibility authority for silent bank-transaction JE auto-posting.
 * Mirrors the capture-side autoPublishGateService decision-ladder shape.
 *
 * evaluate() is PURE — the primary TDD target. sweep()/settings accessors
 * (below) orchestrate the existing posting plumbing through it.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { allocateTransaction } from './bankAllocationService';
import { postProvisional } from '../capture/provisionalPostingService';

type Row = DbRow;

// ── Types ────────────────────────────────────────────────────────────────────

export interface AutoPostSettings {
  enabled: boolean;
  minConfidence: number;
  amountCap: number; // 0 = uncapped
}

export interface GateTx {
  status: string;
  amount: number;
  suggestedGlAccountId: string | null;
}

export type GateDecision = { outcome: 'post' } | { outcome: 'skip'; reason: string };

export type AutoPostSource = 'import' | 'categorization' | 'manual';

export interface SweepResult {
  runId: string | null;
  posted: number;
  skipped: Array<{ txId: string; reason: string }>;
}

export const AUTO_POST_AGENT = 'ai:auto-post:v1';

// ── Pure gate ────────────────────────────────────────────────────────────────

/**
 * Decision ladder, first failure wins. `confidence === null` is the provisional
 * path: the predictor's score is only known inside postProvisional, so rungs 3
 * (confidence) and 5 (target) defer to it; rungs 1/2/4 still apply up front.
 */
export function evaluate(tx: GateTx, confidence: number | null, settings: AutoPostSettings): GateDecision {
  if (!settings.enabled) return { outcome: 'skip', reason: 'disabled' };
  if (tx.status !== 'imported') return { outcome: 'skip', reason: 'not eligible' };
  if (confidence !== null && confidence < settings.minConfidence) {
    return { outcome: 'skip', reason: 'confidence too low' };
  }
  if (settings.amountCap > 0 && Math.abs(tx.amount) > settings.amountCap) {
    return { outcome: 'skip', reason: 'over amount cap' };
  }
  if (confidence !== null && tx.suggestedGlAccountId == null) {
    return { outcome: 'skip', reason: 'no target' };
  }
  return { outcome: 'post' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test:unit -- autoPostGateService`
Expected: PASS (all `evaluate` cases).

- [ ] **Step 5: Commit**

```bash
git add src/modules/accounting/services/bank/autoPostGateService.ts tests/unit/services/bank/autoPostGateService.test.ts
git commit -m "feat(banking): pure auto-post eligibility gate (evaluate)"
```

---

## Task 3: Settings accessors

**Files:**
- Modify: `src/modules/accounting/services/bank/autoPostGateService.ts`
- Test: `tests/unit/services/bank/autoPostGateService.test.ts`

- [ ] **Step 1: Add the failing tests** (append to the existing test file; add the mocks at the TOP of the file, above the current imports)

At the very top of the test file, before any `import`, add the hoisted sql mock:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({
  sqlMock: Object.assign(vi.fn(), { unsafe: vi.fn() }),
}));
vi.mock('@/lib/neon', () => ({ sql: sqlMock, withTransaction: vi.fn(), transaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({
  allocateTransaction: vi.fn(),
}));
vi.mock('@/modules/accounting/services/capture/provisionalPostingService', () => ({
  postProvisional: vi.fn(),
}));
```

> Note: the pure-`evaluate` tests from Task 2 keep working unchanged — they don't touch the mocks.

Then append:

```typescript
import { getAutoPostSettings, updateAutoPostSettings } from '@/modules/accounting/services/bank/autoPostGateService';

describe('getAutoPostSettings', () => {
  beforeEach(() => sqlMock.mockReset());

  it('returns disabled defaults when no row exists', async () => {
    sqlMock.mockResolvedValueOnce([]);
    const s = await getAutoPostSettings('co-1');
    expect(s).toEqual({ enabled: false, minConfidence: 0.9, amountCap: 10000 });
  });

  it('maps an existing row', async () => {
    sqlMock.mockResolvedValueOnce([{ enabled: true, min_confidence: '0.85', amount_cap: '5000' }]);
    const s = await getAutoPostSettings('co-1');
    expect(s).toEqual({ enabled: true, minConfidence: 0.85, amountCap: 5000 });
  });
});

describe('updateAutoPostSettings', () => {
  beforeEach(() => sqlMock.mockReset());

  it('rejects a min_confidence outside (0,1]', async () => {
    await expect(updateAutoPostSettings('co-1', { minConfidence: 1.5 }, 'u-1'))
      .rejects.toThrow(/min_confidence/);
  });

  it('rejects a negative amount cap', async () => {
    await expect(updateAutoPostSettings('co-1', { amountCap: -1 }, 'u-1'))
      .rejects.toThrow(/amount_cap/);
  });

  it('upserts and returns the merged settings', async () => {
    sqlMock.mockResolvedValueOnce([{ enabled: true, min_confidence: '0.9', amount_cap: '10000' }]);
    const s = await updateAutoPostSettings('co-1', { enabled: true }, 'u-1');
    expect(s.enabled).toBe(true);
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:unit -- autoPostGateService`
Expected: FAIL — `getAutoPostSettings` / `updateAutoPostSettings` not exported.

- [ ] **Step 3: Implement the accessors** (append to `autoPostGateService.ts`)

```typescript
// ── Settings accessors ───────────────────────────────────────────────────────

const DEFAULTS: AutoPostSettings = { enabled: false, minConfidence: 0.9, amountCap: 10000 };

function mapSettings(row: Row): AutoPostSettings {
  return {
    enabled: Boolean(row.enabled),
    minConfidence: Number(row.min_confidence),
    amountCap: Number(row.amount_cap),
  };
}

export async function getAutoPostSettings(companyId: string): Promise<AutoPostSettings> {
  const rows = (await sql`
    SELECT enabled, min_confidence, amount_cap
    FROM bank_auto_post_settings
    WHERE company_id = ${companyId}::UUID
    LIMIT 1
  `) as Row[];
  return rows.length === 0 ? { ...DEFAULTS } : mapSettings(rows[0]!);
}

export interface AutoPostSettingsPatch {
  enabled?: boolean;
  minConfidence?: number;
  amountCap?: number;
}

export async function updateAutoPostSettings(
  companyId: string,
  patch: AutoPostSettingsPatch,
  userId: string,
): Promise<AutoPostSettings> {
  if (patch.minConfidence != null && (patch.minConfidence <= 0 || patch.minConfidence > 1)) {
    throw new Error('min_confidence must be within (0, 1]');
  }
  if (patch.amountCap != null && patch.amountCap < 0) {
    throw new Error('amount_cap must be >= 0');
  }

  const enabled = patch.enabled ?? null;
  const minConfidence = patch.minConfidence ?? null;
  const amountCap = patch.amountCap ?? null;

  const rows = (await sql`
    INSERT INTO bank_auto_post_settings (company_id, enabled, min_confidence, amount_cap, updated_by, updated_at)
    VALUES (
      ${companyId}::UUID,
      COALESCE(${enabled}, FALSE),
      COALESCE(${minConfidence}::NUMERIC, 0.90),
      COALESCE(${amountCap}::NUMERIC, 10000),
      ${userId}::UUID,
      NOW()
    )
    ON CONFLICT (company_id) DO UPDATE SET
      enabled        = COALESCE(${enabled}, bank_auto_post_settings.enabled),
      min_confidence = COALESCE(${minConfidence}::NUMERIC, bank_auto_post_settings.min_confidence),
      amount_cap     = COALESCE(${amountCap}::NUMERIC, bank_auto_post_settings.amount_cap),
      updated_by     = ${userId}::UUID,
      updated_at     = NOW()
    RETURNING enabled, min_confidence, amount_cap
  `) as Row[];

  log.info('Updated auto-post settings', { companyId, patch }, 'auto-post-gate');
  return mapSettings(rows[0]!);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test:unit -- autoPostGateService`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/accounting/services/bank/autoPostGateService.ts tests/unit/services/bank/autoPostGateService.test.ts
git commit -m "feat(banking): auto-post settings accessors (get/upsert)"
```

---

## Task 4: `allocateTransaction` — optional `postingAgent`

**Files:**
- Modify: `src/modules/accounting/services/bank/bankAllocationService.ts:78-83` (signature) and `:247-250` (meta)

- [ ] **Step 1: Add the trailing param to the signature**

Replace lines 78–83:

```typescript
export async function allocateTransaction(
  companyId: string, bankTxId: string, contraAccountId: string | null, userId: string,
  description?: string, allocType: AllocationType = 'account', entityId?: string,
  vatCode?: string, cc1Id?: string, cc2Id?: string, buId?: string,
  invoiceId?: string,
  opts?: { postingAgent?: string },
): Promise<{ journalEntryId: string; bankTransaction: BankTransaction }> {
```

- [ ] **Step 2: Thread it into the allocation meta**

Replace lines 247–250:

```typescript
  const allocationMeta: JournalEntryMeta = {
    postingAgent: opts?.postingAgent ?? 'system:bank-allocation:v1',
    sourceDocumentId: invoiceSourceDocId,
  };
```

- [ ] **Step 3: Verify nothing else broke**

Run: `bun run type-check`
Expected: no new errors (all existing callers omit `opts`, so they are unaffected).

- [ ] **Step 4: Commit**

```bash
git add src/modules/accounting/services/bank/bankAllocationService.ts
git commit -m "feat(banking): allocateTransaction accepts optional postingAgent"
```

---

## Task 5: `sweep` orchestrator

**Files:**
- Modify: `src/modules/accounting/services/bank/autoPostGateService.ts`
- Test: `tests/unit/services/bank/autoPostGateService.test.ts`

- [ ] **Step 1: Add failing sweep tests**

Append to the test file. (Mocks from Task 3 already cover `allocateTransaction` and `postProvisional`.)

```typescript
import { sweep } from '@/modules/accounting/services/bank/autoPostGateService';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { postProvisional } from '@/modules/accounting/services/capture/provisionalPostingService';

// Route sqlMock responses by query text so order-independence holds.
function routeSql(handlers: Array<{ match: RegExp; rows: unknown[] }>) {
  sqlMock.mockImplementation((strings: TemplateStringsArray) => {
    const text = strings.join('?');
    const h = handlers.find((x) => x.match.test(text));
    return Promise.resolve(h ? h.rows : []);
  });
}

describe('sweep', () => {
  beforeEach(() => {
    sqlMock.mockReset();
    (allocateTransaction as ReturnType<typeof vi.fn>).mockReset();
    (postProvisional as ReturnType<typeof vi.fn>).mockReset();
  });

  it('early-outs with no run row when disabled', async () => {
    routeSql([{ match: /FROM bank_auto_post_settings/, rows: [] }]); // no row → disabled
    const r = await sweep('co-1', ['t1', 't2'], 'categorization', 'u-1');
    expect(r).toEqual({ runId: null, posted: 0, skipped: [] });
    // only the settings SELECT ran — no run INSERT, no per-tx query
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it('lazily creates the run row on the first post and tags the tx (suggestion path)', async () => {
    routeSql([
      { match: /FROM bank_auto_post_settings/, rows: [{ enabled: true, min_confidence: '0.9', amount_cap: '10000' }] },
      { match: /FROM bank_transactions\s+WHERE id = ANY/, rows: [
        { id: 't1', status: 'imported', amount: -500, suggested_gl_account_id: 'gl-1', suggested_confidence: '0.95', suggested_vat_code: null, description: 'Coffee' },
      ] },
      { match: /INSERT INTO bank_auto_post_runs/, rows: [{ id: 'run-1' }] },
    ]);
    (allocateTransaction as ReturnType<typeof vi.fn>).mockResolvedValue({ journalEntryId: 'je-1' });

    const r = await sweep('co-1', ['t1'], 'categorization', 'u-1');

    expect(r.posted).toBe(1);
    expect(r.runId).toBe('run-1');
    expect(allocateTransaction).toHaveBeenCalledWith(
      'co-1', 't1', 'gl-1', 'u-1', 'Coffee', 'account', undefined, undefined,
      undefined, undefined, undefined, undefined, { postingAgent: 'ai:auto-post:v1' },
    );
  });

  it('records a skip and never creates a run when nothing qualifies', async () => {
    routeSql([
      { match: /FROM bank_auto_post_settings/, rows: [{ enabled: true, min_confidence: '0.9', amount_cap: '10000' }] },
      { match: /FROM bank_transactions\s+WHERE id = ANY/, rows: [
        { id: 't1', status: 'imported', amount: -500, suggested_gl_account_id: 'gl-1', suggested_confidence: '0.5', suggested_vat_code: null, description: 'x' },
      ] },
    ]);
    const r = await sweep('co-1', ['t1'], 'categorization', 'u-1');
    expect(r.posted).toBe(0);
    expect(r.runId).toBeNull();
    expect(r.skipped).toEqual([{ txId: 't1', reason: 'confidence too low' }]);
  });

  it('isolates a per-tx failure and keeps sweeping', async () => {
    routeSql([
      { match: /FROM bank_auto_post_settings/, rows: [{ enabled: true, min_confidence: '0.9', amount_cap: '10000' }] },
      { match: /FROM bank_transactions\s+WHERE id = ANY/, rows: [
        { id: 't1', status: 'imported', amount: -100, suggested_gl_account_id: 'gl-1', suggested_confidence: '0.95', suggested_vat_code: null, description: 'a' },
        { id: 't2', status: 'imported', amount: -200, suggested_gl_account_id: 'gl-2', suggested_confidence: '0.95', suggested_vat_code: null, description: 'b' },
      ] },
      { match: /INSERT INTO bank_auto_post_runs/, rows: [{ id: 'run-1' }] },
    ]);
    (allocateTransaction as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ journalEntryId: 'je-2' });

    const r = await sweep('co-1', ['t1', 't2'], 'categorization', 'u-1');
    expect(r.posted).toBe(1);
    expect(r.skipped).toContainEqual({ txId: 't1', reason: 'boom' });
  });

  it('uses the provisional path for the import source', async () => {
    routeSql([
      { match: /FROM bank_auto_post_settings/, rows: [{ enabled: true, min_confidence: '0.9', amount_cap: '10000' }] },
      { match: /FROM bank_transactions\s+WHERE id = ANY/, rows: [
        { id: 't1', status: 'imported', amount: -300, suggested_gl_account_id: null, suggested_confidence: null, suggested_vat_code: null, description: 'EFT' },
      ] },
      { match: /INSERT INTO bank_auto_post_runs/, rows: [{ id: 'run-9' }] },
    ]);
    (postProvisional as ReturnType<typeof vi.fn>).mockResolvedValue({ journalEntryId: 'je-9', prediction: {} });

    const r = await sweep('co-1', ['t1'], 'import', 'u-1');
    expect(postProvisional).toHaveBeenCalledWith('co-1', 't1', 'u-1', { minConfidence: 0.9 });
    expect(r.posted).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:unit -- autoPostGateService`
Expected: FAIL — `sweep` not exported.

- [ ] **Step 3: Implement `sweep`** (append to `autoPostGateService.ts`)

```typescript
// ── Sweep ────────────────────────────────────────────────────────────────────

interface SweepRow {
  id: string;
  status: string;
  amount: number;
  suggested_gl_account_id: string | null;
  suggested_confidence: string | number | null;
  suggested_vat_code: string | null;
  description: string | null;
}

/**
 * Evaluate the given txs and post the eligible ones through the existing
 * plumbing. source 'import' uses the provisional predictor path; everything
 * else uses the suggestion (allocate) path. The run row is created lazily on
 * the first successful post — a sweep that posts nothing leaves no run row.
 */
export async function sweep(
  companyId: string,
  txIds: string[],
  source: AutoPostSource,
  userId: string,
): Promise<SweepResult> {
  const settings = await getAutoPostSettings(companyId);
  if (!settings.enabled || txIds.length === 0) {
    return { runId: null, posted: 0, skipped: [] };
  }

  const rows = (await sql`
    SELECT id, status, amount, suggested_gl_account_id, suggested_confidence,
           suggested_vat_code, description
    FROM bank_transactions
    WHERE id = ANY(${txIds}::UUID[]) AND company_id = ${companyId}::UUID
  `) as unknown as SweepRow[];

  const skipped: Array<{ txId: string; reason: string }> = [];
  let runId: string | null = null;
  let posted = 0;
  let totalAmount = 0;

  async function ensureRun(): Promise<string> {
    if (runId) return runId;
    const r = (await sql`
      INSERT INTO bank_auto_post_runs (company_id, source, min_confidence, amount_cap, created_by)
      VALUES (${companyId}::UUID, ${source}, ${settings.minConfidence}::NUMERIC,
              ${settings.amountCap}::NUMERIC, ${userId}::UUID)
      RETURNING id
    `) as Row[];
    runId = String(r[0]!.id);
    return runId;
  }

  for (const row of rows) {
    const isImport = source === 'import';
    const confidence = isImport
      ? null
      : (row.suggested_confidence != null ? Number(row.suggested_confidence) : null);

    const decision = evaluate(
      { status: row.status, amount: Number(row.amount), suggestedGlAccountId: row.suggested_gl_account_id },
      confidence,
      settings,
    );
    if (decision.outcome === 'skip') {
      skipped.push({ txId: row.id, reason: decision.reason });
      continue;
    }

    try {
      if (isImport) {
        const res = await postProvisional(companyId, row.id, userId, { minConfidence: settings.minConfidence });
        if (!res.journalEntryId) {
          skipped.push({ txId: row.id, reason: res.skipped ?? 'no target' });
          continue;
        }
      } else {
        await allocateTransaction(
          companyId, row.id, row.suggested_gl_account_id, userId,
          row.description ?? undefined, 'account', undefined,
          row.suggested_vat_code ?? undefined,
          undefined, undefined, undefined, undefined,
          { postingAgent: AUTO_POST_AGENT },
        );
      }
      const id = await ensureRun();
      await sql`
        UPDATE bank_transactions SET auto_post_run_id = ${id}::UUID
        WHERE id = ${row.id}::UUID AND company_id = ${companyId}::UUID
      `;
      posted += 1;
      totalAmount += Math.abs(Number(row.amount));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn('Auto-post failed for bank transaction — skipping', { companyId, txId: row.id, reason }, 'auto-post-gate');
      skipped.push({ txId: row.id, reason });
    }
  }

  if (runId) {
    await sql`
      UPDATE bank_auto_post_runs
      SET posted_count = ${posted}, total_amount = ${totalAmount}::NUMERIC
      WHERE id = ${runId}::UUID AND company_id = ${companyId}::UUID
    `;
  }

  log.info('Auto-post sweep complete', { companyId, source, posted, skipped: skipped.length, runId }, 'auto-post-gate');
  return { runId, posted, skipped };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test:unit -- autoPostGateService`
Expected: PASS (all gate + settings + sweep cases).

- [ ] **Step 5: Confirm file size under cap**

Run: `wc -l src/modules/accounting/services/bank/autoPostGateService.ts`
Expected: < 300. (If it exceeds, the next task's `undoRun` already lives in its own file — no action needed here.)

- [ ] **Step 6: Commit**

```bash
git add src/modules/accounting/services/bank/autoPostGateService.ts tests/unit/services/bank/autoPostGateService.test.ts
git commit -m "feat(banking): auto-post sweep — gate-routed posting + run audit"
```

---

## Task 6: `undoRun`

**Files:**
- Create: `src/modules/accounting/services/bank/autoPostUndoService.ts`
- Test: `tests/unit/services/bank/autoPostUndoService.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({
  sqlMock: Object.assign(vi.fn(), { unsafe: vi.fn() }),
}));
vi.mock('@/lib/neon', () => ({ sql: sqlMock, withTransaction: vi.fn(), transaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const reverseReconciledTransaction = vi.fn();
vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({
  reverseReconciledTransaction: (...a: unknown[]) => reverseReconciledTransaction(...a),
}));
const reverseJournalEntry = vi.fn();
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  reverseJournalEntry: (...a: unknown[]) => reverseJournalEntry(...a),
}));

import { undoRun } from '@/modules/accounting/services/bank/autoPostUndoService';

function routeSql(handlers: Array<{ match: RegExp; rows: unknown[] }>) {
  sqlMock.mockImplementation((strings: TemplateStringsArray) => {
    const text = strings.join('?');
    const h = handlers.find((x) => x.match.test(text));
    return Promise.resolve(h ? h.rows : []);
  });
}

describe('undoRun', () => {
  beforeEach(() => {
    sqlMock.mockReset();
    reverseReconciledTransaction.mockReset();
    reverseJournalEntry.mockReset();
  });

  it('rejects a run that is already undone', async () => {
    routeSql([{ match: /FROM bank_auto_post_runs/, rows: [{ id: 'run-1', undone_at: '2026-06-10T00:00:00Z' }] }]);
    await expect(undoRun('co-1', 'run-1', 'u-1')).rejects.toThrow(/already undone/i);
  });

  it('throws when the run does not belong to the company', async () => {
    routeSql([{ match: /FROM bank_auto_post_runs/, rows: [] }]);
    await expect(undoRun('co-1', 'run-x', 'u-1')).rejects.toThrow(/not found/i);
  });

  it('skips reconciled txs and reverses the rest', async () => {
    routeSql([
      { match: /FROM bank_auto_post_runs/, rows: [{ id: 'run-1', undone_at: null }] },
      { match: /FROM bank_transactions\s+WHERE auto_post_run_id/, rows: [
        { id: 't1', status: 'reconciled', matched_journal_line_id: 'jl-1', provisional_je_id: null },
        { id: 't2', status: 'allocated', matched_journal_line_id: 'jl-2', provisional_je_id: null },
        { id: 't3', status: 'provisional', matched_journal_line_id: null, provisional_je_id: 'je-3' },
      ] },
    ]);

    const r = await undoRun('co-1', 'run-1', 'u-1');

    expect(r).toEqual({ reversed: 2, skipped: 1 });
    expect(reverseReconciledTransaction).toHaveBeenCalledWith('co-1', 't2', 'u-1');
    expect(reverseJournalEntry).toHaveBeenCalledWith('co-1', 'je-3', 'u-1');
    expect(reverseReconciledTransaction).not.toHaveBeenCalledWith('co-1', 't1', 'u-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:unit -- autoPostUndoService`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `undoRun`**

```typescript
/**
 * Auto-Post Undo Service
 * Reverses a whole auto-post run via the existing JE-reversal + tx-reset
 * plumbing. Reconciled transactions are skipped (books hygiene) — the run is
 * still marked undone, with the skip count returned.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { reverseReconciledTransaction } from './bankAllocationService';
import { reverseJournalEntry } from '../gl/journalEntryService';

type Row = DbRow;

export interface UndoResult {
  reversed: number;
  skipped: number;
}

export async function undoRun(companyId: string, runId: string, userId: string): Promise<UndoResult> {
  const runRows = (await sql`
    SELECT id, undone_at FROM bank_auto_post_runs
    WHERE id = ${runId}::UUID AND company_id = ${companyId}::UUID
    LIMIT 1
  `) as Row[];
  if (runRows.length === 0) throw new Error(`Auto-post run ${runId} not found`);
  if (runRows[0]!.undone_at) throw new Error('Run already undone');

  const txRows = (await sql`
    SELECT id, status, matched_journal_line_id, provisional_je_id
    FROM bank_transactions
    WHERE auto_post_run_id = ${runId}::UUID AND company_id = ${companyId}::UUID
  `) as Row[];

  let reversed = 0;
  let skipped = 0;

  for (const tx of txRows) {
    const txId = String(tx.id);
    if (String(tx.status) === 'reconciled') {
      skipped += 1;
      continue;
    }
    try {
      if (tx.matched_journal_line_id) {
        // suggestion path: reverses the JE behind the matched line and resets the tx
        await reverseReconciledTransaction(companyId, txId, userId);
      } else if (tx.provisional_je_id) {
        // provisional path: reverse the provisional JE and reset the tx directly
        await reverseJournalEntry(companyId, String(tx.provisional_je_id), userId);
        await sql`
          UPDATE bank_transactions
          SET status = 'imported', provisional_je_id = NULL, updated_at = NOW()
          WHERE id = ${txId}::UUID AND company_id = ${companyId}::UUID
        `;
      }
      await sql`
        UPDATE bank_transactions SET auto_post_run_id = NULL
        WHERE id = ${txId}::UUID AND company_id = ${companyId}::UUID
      `;
      reversed += 1;
    } catch (err) {
      log.error('Auto-post undo failed for transaction — leaving tagged for retry',
        { companyId, runId, txId, error: err instanceof Error ? err.message : String(err) }, 'auto-post-undo');
      skipped += 1;
    }
  }

  await sql`
    UPDATE bank_auto_post_runs
    SET undone_at = NOW(), undone_by = ${userId}::UUID
    WHERE id = ${runId}::UUID AND company_id = ${companyId}::UUID
  `;

  log.info('Auto-post run undone', { companyId, runId, reversed, skipped }, 'auto-post-undo');
  return { reversed, skipped };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test:unit -- autoPostUndoService`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/accounting/services/bank/autoPostUndoService.ts tests/unit/services/bank/autoPostUndoService.test.ts
git commit -m "feat(banking): auto-post run undo (reconciled-safe)"
```

---

## Task 7: Wire `bankImportService` to the gate

**Files:**
- Modify: `src/modules/accounting/services/bank/bankImportService.ts` (import line 8; call sites 99 and 253)
- Modify: `src/modules/accounting/services/capture/provisionalPostingService.ts` (remove `autoProvisionalBatch`)
- Modify: `tests/unit/services/bank/bankImportService.bulk.test.ts` (re-point the mock)

- [ ] **Step 1: Update the existing test's mock first (so it drives the change)**

In `tests/unit/services/bank/bankImportService.bulk.test.ts`, replace the provisional mock:

```typescript
vi.mock('@/modules/accounting/services/bank/autoPostGateService', () => ({
  sweep: vi.fn().mockResolvedValue({ runId: null, posted: 0, skipped: [] }),
}));
```

(Delete the old `vi.mock('@/modules/accounting/services/capture/provisionalPostingService', …)` block.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:unit -- bankImportService.bulk`
Expected: FAIL — `bankImportService` still imports `autoProvisionalBatch`, which is no longer the mocked symbol; the import call site still calls it.

- [ ] **Step 3: Swap the import and both call sites in `bankImportService.ts`**

Line 8 — replace:

```typescript
import { sweep } from './autoPostGateService';
```

Line 99 (inside the first try block) — replace `await autoProvisionalBatch(...)`:

```typescript
        await sweep(companyId, outflowIds.map((r) => String(r.id)), 'import', systemUser);
```

Line 253 (the second, parsed-import site) — replace identically:

```typescript
        await sweep(companyId, outflowIds.map((r) => String(r.id)), 'import', systemUser);
```

Leave the surrounding best-effort try/catch and the `log.warn` lines as-is (update the warn message text to `'auto-post sweep failed after import — non-fatal'` for accuracy).

- [ ] **Step 4: Remove the dead `autoProvisionalBatch`**

In `provisionalPostingService.ts`, delete the entire `autoProvisionalBatch` function (lines ~275–293) and its `// ── Batch helper for bank import` banner. Keep `postProvisional` and `predictFromHistory`.

- [ ] **Step 5: Run tests + typecheck**

Run: `bun run test:unit -- bankImportService.bulk && bun run type-check`
Expected: PASS; type-check clean (no remaining references to `autoProvisionalBatch` — verify with `grep -rn autoProvisionalBatch src tests`, expect zero hits).

- [ ] **Step 6: Commit**

```bash
git add src/modules/accounting/services/bank/bankImportService.ts \
        src/modules/accounting/services/capture/provisionalPostingService.ts \
        tests/unit/services/bank/bankImportService.bulk.test.ts
git commit -m "refactor(banking): route import provisional posting through the auto-post gate"
```

---

## Task 8: Wire `smart-categorize` to the gate

**Files:**
- Modify: `pages/api/accounting/smart-categorize.ts` (the `categorize` case, lines 66–78)

- [ ] **Step 1: Add the sweep after `bulkCategorize`**

Add to the imports:

```typescript
import { sweep } from '@/modules/accounting/services/bank/autoPostGateService';
```

Change the handler signature to read `userId` (line 24):

```typescript
  const { companyId, userId } = req as CompanyAuthedRequest;
```

In the `categorize` case, replace the `transactionIds` branch (lines 73–77):

```typescript
          if (!Array.isArray(transactionIds) || transactionIds.length === 0) {
            return apiResponse.badRequest(res, 'transactionIds array or bankAccountId required');
          }
          const result = await bulkCategorize(companyId, transactionIds);
          const categorizedIds = result.results.filter((r) => r.result).map((r) => r.transactionId);
          const autoPost = await sweep(companyId, categorizedIds, 'categorization', userId);
          return apiResponse.success(res, { ...result, autoPost });
```

- [ ] **Step 2: Typecheck**

Run: `bun run type-check`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add pages/api/accounting/smart-categorize.ts
git commit -m "feat(banking): sweep auto-post after bulk categorization"
```

---

## Task 9: API route — `bank-auto-post.ts`

**Files:**
- Create: `pages/api/accounting/bank-auto-post.ts`

- [ ] **Step 1: Write the route**

```typescript
/**
 * GET   /api/accounting/bank-auto-post → { settings, runs (last ~20) }
 * PUT   body { enabled?, minConfidence?, amountCap? } → upsert settings
 * POST  body { action: 'undo', runId } → undo a whole run
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { getAutoPostSettings, updateAutoPostSettings } from '@/modules/accounting/services/bank/autoPostGateService';
import { undoRun } from '@/modules/accounting/services/bank/autoPostUndoService';

type Row = Record<string, unknown>;

interface PutBody { enabled?: boolean; minConfidence?: number; amountCap?: number }
interface PostBody { action?: string; runId?: string }

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId, userId } = req;

  if (req.method === 'GET') {
    const settings = await getAutoPostSettings(companyId);
    const runs = (await sql`
      SELECT id, source, posted_count, total_amount, created_at, undone_at
      FROM bank_auto_post_runs
      WHERE company_id = ${companyId}::UUID
      ORDER BY created_at DESC
      LIMIT 20
    `) as Row[];
    return apiResponse.success(res, {
      settings,
      runs: runs.map((r) => ({
        id: String(r.id),
        source: String(r.source),
        postedCount: Number(r.posted_count),
        totalAmount: Number(r.total_amount),
        createdAt: r.created_at,
        undoneAt: r.undone_at,
      })),
    });
  }

  if (req.method === 'PUT') {
    const body = (req.body ?? {}) as PutBody;
    if (body.enabled === undefined && body.minConfidence === undefined && body.amountCap === undefined) {
      return apiResponse.badRequest(res, 'At least one of enabled | minConfidence | amountCap is required');
    }
    try {
      const settings = await updateAutoPostSettings(companyId, body, userId);
      return apiResponse.success(res, { settings });
    } catch (err) {
      return apiResponse.badRequestFromError(res, err, 'Invalid auto-post settings');
    }
  }

  if (req.method === 'POST') {
    const body = (req.body ?? {}) as PostBody;
    if (body.action !== 'undo' || !body.runId) {
      return apiResponse.badRequest(res, "POST requires { action: 'undo', runId }");
    }
    try {
      const result = await undoRun(companyId, body.runId, userId);
      log.info('Auto-post run undo requested', { companyId, runId: body.runId, ...result }, 'bank-auto-post');
      return apiResponse.success(res, result);
    } catch (err) {
      return apiResponse.badRequestFromError(res, err, 'Undo failed');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET', 'PUT', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))));
```

- [ ] **Step 2: Typecheck**

Run: `bun run type-check`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add pages/api/accounting/bank-auto-post.ts
git commit -m "feat(banking): bank-auto-post API (settings + runs + undo)"
```

---

## Task 10: Settings card UI

**Files:**
- Modify: `pages/accounting/accounting-settings.tsx`

- [ ] **Step 1: Add an auto-post card below the generic settings list**

The page renders a generic `SettingItem` list. Add a dedicated card as its own state + fetch, inside the `max-w-2xl` container, after the existing `<div className="space-y-6">…</div>` block. Add near the top of the component:

```typescript
  const [ap, setAp] = useState<{ enabled: boolean; minConfidence: number; amountCap: number }>({ enabled: false, minConfidence: 0.9, amountCap: 10000 });
  const [apSaving, setApSaving] = useState(false);

  useEffect(() => {
    apiFetch('/api/accounting/bank-auto-post', { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => { if (j?.data?.settings) setAp(j.data.settings); })
      .catch(() => { /* leave defaults; card still renders */ });
  }, []);

  async function saveAutoPost(patch: Partial<typeof ap>) {
    setApSaving(true);
    try {
      const res = await apiFetch('/api/accounting/bank-auto-post', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const j = await res.json();
      if (j?.data?.settings) setAp(j.data.settings);
      else setError(j?.error ?? 'Failed to save auto-post settings');
    } catch {
      setError('Failed to save auto-post settings');
    } finally {
      setApSaving(false);
    }
  }
```

And the card markup (place after the settings list, before the closing container `</div>`):

```tsx
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5 mt-6">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <label className="block text-sm font-medium text-[var(--ff-text-primary)] mb-1">
                  Auto-post high-confidence transactions
                </label>
                <p className="text-xs text-[var(--ff-text-tertiary)] mb-3">
                  Posts journal entries automatically. Transactions above the cap or below the
                  confidence threshold always go to review.
                </p>
              </div>
              <button
                type="button"
                disabled={apSaving}
                onClick={() => saveAutoPost({ enabled: !ap.enabled })}
                className={`px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 ${ap.enabled ? 'bg-green-600 text-white' : 'bg-slate-500/20 text-[var(--ff-text-secondary)]'}`}
              >
                {ap.enabled ? 'On' : 'Off'}
              </button>
            </div>
            <div className="grid grid-cols-2 gap-4 mt-2">
              <div>
                <label className="block text-xs text-[var(--ff-text-secondary)] mb-1">Min confidence (0–1)</label>
                <input
                  type="number" step="0.01" min="0.01" max="1"
                  className="ff-input text-sm w-full"
                  defaultValue={ap.minConfidence}
                  onBlur={(e) => saveAutoPost({ minConfidence: Number(e.target.value) })}
                />
              </div>
              <div>
                <label className="block text-xs text-[var(--ff-text-secondary)] mb-1">Amount cap (R, 0 = none)</label>
                <input
                  type="number" step="1" min="0"
                  className="ff-input text-sm w-full"
                  defaultValue={ap.amountCap}
                  onBlur={(e) => saveAutoPost({ amountCap: Number(e.target.value) })}
                />
              </div>
            </div>
          </div>
```

- [ ] **Step 2: Typecheck + lint**

Run: `bun run type-check && bun run lint`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add pages/accounting/accounting-settings.tsx
git commit -m "feat(banking): auto-post settings card"
```

---

## Task 11: Runs panel UI

**Files:**
- Create: `src/components/accounting/bank-transactions/AutoPostRunsPanel.tsx`
- Modify: `pages/accounting/bank-transactions/index.tsx` (mount the panel + an `onChange` refresh hook)

- [ ] **Step 1: Build the panel component**

```tsx
import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '@/lib/apiFetch';

interface AutoPostRun {
  id: string;
  source: string;
  postedCount: number;
  totalAmount: number;
  createdAt: string;
  undoneAt: string | null;
}

export function AutoPostRunsPanel({ onUndone }: { onUndone?: () => void }) {
  const [runs, setRuns] = useState<AutoPostRun[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    apiFetch('/api/accounting/bank-auto-post', { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => setRuns(j?.data?.runs ?? []))
      .catch(() => setRuns([]));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function undo(runId: string) {
    setBusy(runId);
    try {
      await apiFetch('/api/accounting/bank-auto-post', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'undo', runId }),
      });
      load();
      onUndone?.();
    } finally {
      setBusy(null);
    }
  }

  const active = runs.filter((r) => !r.undoneAt && r.postedCount > 0);
  if (active.length === 0) return null;

  return (
    <div className="mb-4 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] p-3">
      <h3 className="text-xs font-semibold text-[var(--ff-text-secondary)] mb-2">Recent auto-post runs</h3>
      <ul className="space-y-1">
        {active.map((r) => (
          <li key={r.id} className="flex items-center justify-between text-sm text-[var(--ff-text-primary)]">
            <span>
              Auto-posted {r.postedCount} (R{r.totalAmount.toLocaleString()}) · {r.source}
            </span>
            <button
              type="button"
              disabled={busy === r.id}
              onClick={() => undo(r.id)}
              className="text-xs text-blue-500 hover:underline disabled:opacity-50"
            >
              {busy === r.id ? 'Undoing…' : 'Undo'}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Mount it on the bank-transactions page**

In `pages/accounting/bank-transactions/index.tsx`, add the import near the other component imports:

```typescript
import { AutoPostRunsPanel } from '@/components/accounting/bank-transactions/AutoPostRunsPanel';
```

Render it just above the `<BankTxTable …>` (find where the table is rendered in the JSX). Pass the page's existing transaction-refresh callback so an undo refreshes the New queue — use whatever the page already calls to reload transactions (e.g. the loader behind the filters):

```tsx
            <AutoPostRunsPanel onUndone={() => { /* call the page's existing reload, e.g. loadTransactions() */ }} />
```

> Wire `onUndone` to the function this page already uses to fetch the transaction list (locate it by searching the file for `setTransactions(`). If no stable callback exists, omit the prop — the panel self-refreshes its own run list either way.

- [ ] **Step 3: Typecheck + lint**

Run: `bun run type-check && bun run lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/components/accounting/bank-transactions/AutoPostRunsPanel.tsx pages/accounting/bank-transactions/index.tsx
git commit -m "feat(banking): auto-post runs panel with bulk-undo"
```

---

## Task 12: Full gate + browser verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit suite for the touched services**

Run: `bun run test:unit -- bank`
Expected: PASS (autoPostGateService, autoPostUndoService, bankImportService.bulk all green).

- [ ] **Step 2: Run the CI gate**

Run: `bun run ci`
Expected: lint + type-check + tests pass at or under the ratchet baselines.

- [ ] **Step 3: Browser-verify on the ISAFlow Demo company ONLY**

> Auto-post writes **real journal entries**. Verify on the **ISAFlow Demo** company — never on Brightsphere's real books (same rule as the standing recon-accept demo-verify TODO).

1. Settings → enable auto-post, set min confidence 0.90, cap R10,000.
2. Import a demo statement (or run categorize) → confirm high-confidence outflows auto-post and leave the New queue.
3. Confirm the runs panel shows the run; click **Undo**; confirm the txs return to New and the JEs are reversed.
4. Reconcile one auto-posted tx, then Undo its run → confirm that tx is **skipped** (stays reconciled) while the rest reverse.

- [ ] **Step 4: Final commit (if any verification fixups were needed)**

```bash
git add -A && git commit -m "test(banking): verify auto-post gate end-to-end on demo"
```

---

## Self-review notes (author)

- **Spec coverage:** migration (T1), `evaluate` (T2), settings accessors (T3), `allocateTransaction` postingAgent (T4), `sweep` incl. lazy run / per-tx isolation / provisional unification (T5, T7), `undoRun` reconciled-skip + already-undone (T6), categorize wiring (T8), API GET/PUT/POST (T9), settings card (T10), runs panel + Auto badge surface (T11), demo-only verification (T12). The "Auto badge in Allocated/Matched views" from the spec is satisfied structurally (`auto_post_run_id IS NOT NULL` is queryable); a dedicated badge in `BankTxTable` is deferred as cosmetic — call it out in review if wanted.
- **Type consistency:** `AutoPostSettings`, `GateTx`, `GateDecision`, `SweepResult`, `AutoPostSource`, `AUTO_POST_AGENT='ai:auto-post:v1'` are defined once in T2 and reused verbatim in T5/T8/T9. `undoRun` returns `{ reversed, skipped }` consistently in T6 and T9.
- **Deliberate behavior change:** T7 removes `autoProvisionalBatch`; with no settings row every company is disabled, so provisional auto-posting goes OFF at deploy until opt-in. Do not grandfather.
- **Decision deferral:** provisional path passes `confidence: null` so `evaluate` runs only rungs 1/2/4; `postProvisional` enforces the confidence rung internally via `minConfidence`.
