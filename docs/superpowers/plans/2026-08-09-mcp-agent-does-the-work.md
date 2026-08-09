# MCP Slice 2 — "The Agent Does The Work" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent reconcile a real bank feed end-to-end — find candidates, allocate, split, create rules, and undo its own work — with every posting attributed to the agent and bulk-reversible.

**Architecture:** Every tool wraps an existing service; no new business logic. The safety model is **attribution + review, not confirmation**: each MCP-originated journal is stamped `posting_agent = 'mcp:<tool>:v1'` (the column already exists and is already populated with `human:<userId>` / `legacy:*`), so agent work is filterable, reviewable and reversible as a set. Reconciliation is the target because a bank line resolves to a supplier invoice, a customer receipt or a journal — exercising AP, AR and GL through one surface.

**Tech Stack:** TypeScript strict · Next.js Pages API · Vitest · Postgres/Supabase with RLS GUC per request · existing MCP registry (`src/lib/mcp/registry.ts`)

## Global Constraints

- **Tenant from context only.** Every handler uses `ctx.companyId`. A `company_id` in tool args is a defect. `bearerPipeline` sets `app.current_company_id` per request; RLS enforces below the app.
- **`idempotency_key` is required on every `write: true` tool.** The registry rejects writes without one, holds an advisory lock, and replays the stored result for a repeat key.
- **Writes that post a journal set `requiresPost: true`** *alongside* their domain scope — the mechanism `post_journal` uses (`scope: 'write:journals', write: true, requiresPost: true`). It is NOT `scope: 'write:post'`. `allocateTransaction` creates *and posts* a journal, so it is `scope: 'write:bank-tx', write: true, requiresPost: true`. Suggestion-only tools omit `requiresPost`.
- **`write` is a required field on `McpTool`** — read tools must declare `write: false` explicitly; omitting it is a type error.
- **Class 3 is out of scope.** Nothing in this slice sends email, generates an EFT file, or transmits to SARS. No imports from `statementEmailService`, `dunningService`, `eftService`, `netcashService`, `sarsEfiling*`.
- **Max 300 lines per file.** `src/lib/mcp/tools/` files split by domain.
- **No `console.log`** — use `log` from `@/lib/logger`. **No empty catch blocks.**
- **Posting-agent format:** `mcp:<tool_name>:v1` — e.g. `mcp:allocate_bank_transaction:v1`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/mcp/postingAgent.ts` (create) | Single source of the `mcp:<tool>:v1` string. Pure, no imports. |
| `src/lib/mcp/tools/bankMatch.ts` (create) | Read tools: `get_match_candidates`. |
| `src/lib/mcp/tools/writeBankAllocate.ts` (create) | Write tools: `allocate_bank_transaction` (Task 3), `reverse_bank_allocation` (Task 4). |
| `src/lib/mcp/tools/agentActivity.ts` (create) | Read tool: `list_agent_postings` — the review surface. |
| `src/lib/mcp/registry.ts` (modify) | Register the new tools. |
| `src/modules/accounting/services/bank/agentActivityService.ts` (create) | Query journals by `posting_agent LIKE 'mcp:%'` for a date range. |
| `scripts/mcp-recon-benchmark.ts` (create) | Measures the acceptance benchmark: correction rate over a month. |

**Not building in this slice — and why:**
- **Customer receipts / supplier payment tools** — they arrive through `allocateTransaction`'s `invoiceId` + `allocType` on the bank line, so the benchmark exercises AP and AR without separate tools.
- **`split_allocate_bank_transaction`** — one bank line covering several invoices. Deferred deliberately: it doubles the write surface for a case whose frequency we can measure first. **Trigger to pull it forward:** if the Gate E run shows the agent blocked on multi-invoice lines, this becomes Task 1 of the follow-on plan, wrapping the existing `splitAllocateTransaction(companyId, bankTxId, lines, userId)`.
- **`create_bank_rule`** — a force multiplier (rules auto-categorise future lines) but not required to reconcile a month. Wraps `bankRulesService.createRule`. Follow-on.
- **Purchase orders, dunning, statements, VAT201** — class 3 or later slices.

---

### Task 1: Posting-agent stamp

**Files:**
- Create: `src/lib/mcp/postingAgent.ts`
- Test: `tests/unit/mcp/postingAgent.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `mcpPostingAgent(toolName: string): string`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { mcpPostingAgent } from '@/lib/mcp/postingAgent';

describe('mcpPostingAgent', () => {
  it('namespaces the tool so agent work is filterable against human:/legacy: entries', () => {
    expect(mcpPostingAgent('allocate_bank_transaction')).toBe('mcp:allocate_bank_transaction:v1');
  });

  it('is prefixed mcp: so a LIKE mcp:% review query finds every agent posting', () => {
    for (const t of ['allocate_bank_transaction', 'split_allocate_bank_transaction']) {
      expect(mcpPostingAgent(t).startsWith('mcp:')).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/unit/mcp/postingAgent.test.ts`
Expected: FAIL — cannot resolve `@/lib/mcp/postingAgent`.

- [ ] **Step 3: Write minimal implementation**

```typescript
/**
 * Posting-agent stamp for MCP-originated ledger writes — ZERO imports.
 *
 * gl_journal_entries.posting_agent already carries `human:<userId>` and
 * `legacy:*` values. Stamping `mcp:<tool>:v1` is what makes agent work
 * reviewable and reversible as a set — the safety model for this slice is
 * attribution, not per-action confirmation.
 */
export function mcpPostingAgent(toolName: string): string {
  return `mcp:${toolName}:v1`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run tests/unit/mcp/postingAgent.test.ts` → PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/mcp/postingAgent.ts tests/unit/mcp/postingAgent.test.ts
git commit -m "feat(mcp): posting-agent stamp for agent-originated ledger writes"
```

---

### Task 2: `get_match_candidates` read tool

**Files:**
- Create: `src/lib/mcp/tools/bankMatch.ts`
- Modify: `src/lib/mcp/registry.ts`
- Test: `tests/unit/mcp/bankMatchTool.test.ts`

**Interfaces:**
- Consumes: `getMatchCandidates(bankTransactionId: string, companyId: string): Promise<{ candidates: MatchCandidate[] }>` from `@/modules/accounting/services/bank/bankMatchCandidatesService`.
- Produces: `getMatchCandidatesTool: McpTool` (name `get_match_candidates`).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/bank/bankMatchCandidatesService', () => ({
  getMatchCandidates: vi.fn(),
}));

import { getMatchCandidates } from '@/modules/accounting/services/bank/bankMatchCandidatesService';
import { getMatchCandidatesTool } from '@/lib/mcp/tools/bankMatch';

const ctx = { companyId: 'company-1', userId: 'user-1' } as never;

beforeEach(() => vi.clearAllMocks());

describe('get_match_candidates', () => {
  it('is a read tool — no scope escalation, no idempotency key needed', () => {
    expect(getMatchCandidatesTool.write).toBe(false);
    expect(getMatchCandidatesTool.requiresPost).toBeUndefined();
    expect(getMatchCandidatesTool.scope).toBe('read:bank-tx');
  });

  it('passes the tenant from ctx, never from args', async () => {
    vi.mocked(getMatchCandidates).mockResolvedValue({ candidates: [] });

    await getMatchCandidatesTool.handler({ transaction_id: 'tx-1', company_id: 'attacker' }, ctx);

    expect(getMatchCandidates).toHaveBeenCalledWith('tx-1', 'company-1');
  });

  it('rejects a missing transaction_id without calling the service', async () => {
    const res = await getMatchCandidatesTool.handler({}, ctx);

    expect(res.isError).toBe(true);
    expect(getMatchCandidates).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/unit/mcp/bankMatchTool.test.ts`
Expected: FAIL — cannot resolve `@/lib/mcp/tools/bankMatch`.

- [ ] **Step 3: Write minimal implementation**

```typescript
/**
 * MCP read tool: get_match_candidates. Scored match shortlist for one bank
 * transaction — supplier invoices, customer invoices, POs, journal lines —
 * via the same service the recon UI uses. Read-only: suggests nothing,
 * changes nothing.
 */
import type { McpTool } from '../types';
import { getMatchCandidates } from '@/modules/accounting/services/bank/bankMatchCandidatesService';
import { ok, safeErrorText, toolError } from './toolHelpers';

export const getMatchCandidatesTool: McpTool = {
  name: 'get_match_candidates',
  description:
    'Scored match candidates for a single bank transaction (supplier invoices, customer invoices, purchase orders, journal lines). Read-only. Use before allocate_bank_transaction to decide what a line belongs to.',
  scope: 'read:bank-tx',
  write: false,
  inputSchema: {
    type: 'object',
    properties: { transaction_id: { type: 'string' } },
    required: ['transaction_id'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const txId = typeof args.transaction_id === 'string' ? args.transaction_id.trim() : '';
    if (!txId) return toolError('transaction_id is required');
    try {
      const result = await getMatchCandidates(txId, ctx.companyId); // companyId from ctx ONLY
      return ok(result);
    } catch (err) {
      return toolError(safeErrorText(err, 'Failed to load match candidates.'));
    }
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run tests/unit/mcp/bankMatchTool.test.ts` → PASS (3 tests)

- [ ] **Step 5: Register the tool**

In `src/lib/mcp/registry.ts`, import `getMatchCandidatesTool` from `./tools/bankMatch` and add it to the tool array alongside the existing bank tools.

- [ ] **Step 6: Verify the registry exposes it**

Run: `bunx vitest run tests/unit/mcp/` — all green. (No test pins the tool count, so nothing needs renumbering; the transport test's `length: 21` is an unrelated batch of 21 ping requests.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/mcp/tools/bankMatch.ts src/lib/mcp/registry.ts tests/unit/mcp/
git commit -m "feat(mcp): get_match_candidates read tool"
```

---

### Task 3: `allocate_bank_transaction` write tool

**Files:**
- Create: `src/lib/mcp/tools/writeBankAllocate.ts`
- Modify: `src/lib/mcp/registry.ts`
- Test: `tests/unit/mcp/writeBankAllocate.test.ts`

**Interfaces:**
- Consumes: `allocateTransaction(companyId, bankTxId, contraAccountId, userId, description?, allocType?, entityId?, vatCode?, cc1Id?, cc2Id?, buId?, invoiceId?, opts?: { postingAgent?: string })`; `mcpPostingAgent` from Task 1.
- Produces: `allocateBankTransactionTool: McpTool`.

**Scope decision:** `scope: 'write:bank-tx'` **plus `requiresPost: true`** — the same shape `post_journal` uses. `allocateTransaction` creates *and posts* a journal, so a token holding only `write:bank-tx` must not reach it; `requiresPost` is the registry's second gate that demands the separately-opted-in `write:post` permission.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({
  allocateTransaction: vi.fn(),
}));

import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { allocateBankTransactionTool } from '@/lib/mcp/tools/writeBankAllocate';

const ctx = { companyId: 'company-1', userId: 'user-1' } as never;

beforeEach(() => vi.clearAllMocks());

describe('allocate_bank_transaction', () => {
  it('demands the write:post permission — it posts a journal, not a suggestion', () => {
    expect(allocateBankTransactionTool.scope).toBe('write:bank-tx');
    expect(allocateBankTransactionTool.requiresPost).toBe(true);
    expect(allocateBankTransactionTool.write).toBe(true);
    expect(allocateBankTransactionTool.inputSchema.required).toContain('idempotency_key');
  });

  it('stamps the posting agent so the write is attributable and reversible as a set', async () => {
    vi.mocked(allocateTransaction).mockResolvedValue({
      journalEntryId: 'je-1', bankTransaction: { id: 'tx-1' },
    } as never);

    await allocateBankTransactionTool.handler(
      { transaction_id: 'tx-1', contra_account_id: 'acc-1', idempotency_key: 'k1' },
      ctx,
    );

    const call = vi.mocked(allocateTransaction).mock.calls[0]!;
    expect(call[0]).toBe('company-1');           // tenant from ctx
    expect(call[3]).toBe('user-1');
    expect(call[12]).toEqual({ postingAgent: 'mcp:allocate_bank_transaction:v1' });
  });

  it('rejects a missing transaction_id without touching the ledger', async () => {
    const res = await allocateBankTransactionTool.handler(
      { contra_account_id: 'acc-1', idempotency_key: 'k1' }, ctx,
    );

    expect(res.isError).toBe(true);
    expect(allocateTransaction).not.toHaveBeenCalled();
  });

  it('surfaces the service refusal for an already-allocated transaction', async () => {
    vi.mocked(allocateTransaction).mockRejectedValue(
      new Error('Transaction already allocated — cannot allocate'),
    );

    const res = await allocateBankTransactionTool.handler(
      { transaction_id: 'tx-1', contra_account_id: 'acc-1', idempotency_key: 'k1' }, ctx,
    );

    expect(res.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/unit/mcp/writeBankAllocate.test.ts`
Expected: FAIL — cannot resolve `@/lib/mcp/tools/writeBankAllocate`.

- [ ] **Step 3: Write minimal implementation**

```typescript
/**
 * MCP write tools: allocate / split-allocate / reverse a bank transaction.
 *
 * allocateTransaction creates AND posts a journal entry, so these sit behind
 * write:post — the same explicit opt-in as post_journal. Every posting is
 * stamped mcp:<tool>:v1 so agent work is reviewable via list_agent_postings
 * and reversible via reverse_bank_allocation.
 */
import type { McpTool } from '../types';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { mcpPostingAgent } from '../postingAgent';
import { ok, safeErrorText, toolError } from './toolHelpers';

export const allocateBankTransactionTool: McpTool = {
  name: 'allocate_bank_transaction',
  description:
    'Allocate one bank transaction to a GL account (optionally matching a supplier or customer invoice). POSTS a journal entry. Every allocation is attributed to the agent and can be undone with reverse_bank_allocation.',
  scope: 'write:bank-tx',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      transaction_id: { type: 'string' },
      contra_account_id: { type: 'string' },
      description: { type: 'string' },
      alloc_type: { type: 'string', enum: ['account', 'supplier', 'customer'] },
      entity_id: { type: 'string' },
      invoice_id: { type: 'string' },
      vat_code: { type: 'string', enum: ['standard', 'zero_rated', 'exempt', 'none'] },
      idempotency_key: { type: 'string' },
    },
    required: ['transaction_id', 'contra_account_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const txId = typeof args.transaction_id === 'string' ? args.transaction_id.trim() : '';
    const contra = typeof args.contra_account_id === 'string' ? args.contra_account_id.trim() : '';
    if (!txId) return toolError('transaction_id is required');
    if (!contra) return toolError('contra_account_id is required');

    const allocType = (typeof args.alloc_type === 'string' ? args.alloc_type : 'account') as
      'account' | 'supplier' | 'customer';

    try {
      const result = await allocateTransaction(
        ctx.companyId,                                            // tenant from ctx ONLY
        txId,
        contra,
        ctx.userId,
        typeof args.description === 'string' ? args.description : undefined,
        allocType,
        typeof args.entity_id === 'string' ? args.entity_id : undefined,
        typeof args.vat_code === 'string' ? args.vat_code : undefined,
        undefined,
        undefined,
        undefined,
        typeof args.invoice_id === 'string' ? args.invoice_id : undefined,
        { postingAgent: mcpPostingAgent('allocate_bank_transaction') },
      );
      return ok({
        journal_entry_id: result.journalEntryId,
        transaction_id: result.bankTransaction.id,
      });
    } catch (err) {
      return toolError(safeErrorText(err, 'Failed to allocate the transaction.'));
    }
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run tests/unit/mcp/writeBankAllocate.test.ts` → PASS (4 tests)

- [ ] **Step 5: Register and re-run**

Add `allocateBankTransactionTool` to `src/lib/mcp/registry.ts`, then `bunx vitest run tests/unit/mcp/` — all green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/mcp/tools/writeBankAllocate.ts src/lib/mcp/registry.ts tests/unit/mcp/
git commit -m "feat(mcp): allocate_bank_transaction behind write:post, agent-attributed"
```

---

### Task 4: `reverse_bank_allocation` — the undo half

**Files:**
- Modify: `src/lib/mcp/tools/writeBankAllocate.ts`
- Modify: `src/lib/mcp/registry.ts`
- Test: `tests/unit/mcp/writeBankAllocate.test.ts` (extend)

**Interfaces:**
- Consumes: `reverseReconciledTransaction(companyId: string, bankTxId: string, userId: string): Promise<void>`.
- Produces: `reverseBankAllocationTool: McpTool`.

**Why this ships in the same slice as Task 3:** an agent that can allocate but not undo is a one-way door. The undo tool is what makes "let it work" defensible.

- [ ] **Step 1: Write the failing test**

```typescript
// append to tests/unit/mcp/writeBankAllocate.test.ts, extending the existing vi.mock
// factory for bankAllocationService with: reverseReconciledTransaction: vi.fn()

import { reverseReconciledTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { reverseBankAllocationTool } from '@/lib/mcp/tools/writeBankAllocate';

describe('reverse_bank_allocation', () => {
  it('is a write behind the write:post permission and demands an idempotency key', () => {
    expect(reverseBankAllocationTool.scope).toBe('write:bank-tx');
    expect(reverseBankAllocationTool.requiresPost).toBe(true);
    expect(reverseBankAllocationTool.write).toBe(true);
    expect(reverseBankAllocationTool.inputSchema.required).toContain('idempotency_key');
  });

  it('reverses using the tenant from ctx', async () => {
    vi.mocked(reverseReconciledTransaction).mockResolvedValue(undefined);

    const res = await reverseBankAllocationTool.handler(
      { transaction_id: 'tx-1', idempotency_key: 'k9' }, ctx,
    );

    expect(reverseReconciledTransaction).toHaveBeenCalledWith('company-1', 'tx-1', 'user-1');
    expect(res.isError).toBeFalsy();
  });

  it('surfaces the refusal when the transaction is not in a reversible state', async () => {
    vi.mocked(reverseReconciledTransaction).mockRejectedValue(
      new Error('Can only reverse allocated, matched, or reconciled transactions'),
    );

    const res = await reverseBankAllocationTool.handler(
      { transaction_id: 'tx-1', idempotency_key: 'k9' }, ctx,
    );

    expect(res.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/unit/mcp/writeBankAllocate.test.ts`
Expected: FAIL — `reverseBankAllocationTool` is not exported.

- [ ] **Step 3: Write minimal implementation**

```typescript
// add to src/lib/mcp/tools/writeBankAllocate.ts
import { reverseReconciledTransaction } from '@/modules/accounting/services/bank/bankAllocationService';

export const reverseBankAllocationTool: McpTool = {
  name: 'reverse_bank_allocation',
  description:
    'Undo an allocation: reverses the posted journal and returns the bank transaction to unallocated. Use to correct a wrong allocation — the original and its reversal both remain in the audit trail.',
  scope: 'write:bank-tx',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      transaction_id: { type: 'string' },
      idempotency_key: { type: 'string' },
    },
    required: ['transaction_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const txId = typeof args.transaction_id === 'string' ? args.transaction_id.trim() : '';
    if (!txId) return toolError('transaction_id is required');
    try {
      await reverseReconciledTransaction(ctx.companyId, txId, ctx.userId);
      return ok({ transaction_id: txId, reversed: true });
    } catch (err) {
      return toolError(safeErrorText(err, 'Failed to reverse the allocation.'));
    }
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run tests/unit/mcp/writeBankAllocate.test.ts` → PASS (7 tests total)

- [ ] **Step 5: Register, re-run `bunx vitest run tests/unit/mcp/`, commit**

```bash
git add src/lib/mcp/tools/writeBankAllocate.ts src/lib/mcp/registry.ts tests/unit/mcp/
git commit -m "feat(mcp): reverse_bank_allocation so agent work is a two-way door"
```

---

### Task 5: Agent activity service — the review surface

**Files:**
- Create: `src/modules/accounting/services/bank/agentActivityService.ts`
- Test: `tests/unit/services/agentActivityService.test.ts`

**Interfaces:**
- Consumes: `sql` from `@/lib/neon`.
- Produces: `listAgentPostings(companyId: string, fromDate: string, toDate: string): Promise<AgentPosting[]>` where `AgentPosting = { journalEntryId: string; entryNumber: string; entryDate: string; description: string; postingAgent: string; status: string; amount: number }`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Spread the real module so fmtDate stays REAL — the service imports it, and
// the date behaviour (fmtDate does not roll pg DATEs back a day on this UTC+2
// server, toISODate does) is exactly what must not be mocked away.
// Same pattern as tests/unit/services/quoteConvertService.test.ts.
vi.mock('@/lib/neon', async () => {
  const original = await vi.importActual<typeof import('@/lib/neon')>('@/lib/neon');
  const sqlFn = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { ...original, sql: sqlFn };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { sql } from '@/lib/neon';
import { listAgentPostings } from '@/modules/accounting/services/bank/agentActivityService';

beforeEach(() => vi.clearAllMocks());

describe('listAgentPostings', () => {
  it('scopes by company and the requested date range', async () => {
    vi.mocked(sql).mockResolvedValue([] as never);

    await listAgentPostings('company-1', '2026-08-01', '2026-08-31');

    const params = vi.mocked(sql).mock.calls[0]!.slice(1);
    expect(params).toContain('company-1');
    expect(params).toContain('2026-08-01');
    expect(params).toContain('2026-08-31');
  });

  it('maps a row to the review shape', async () => {
    vi.mocked(sql).mockResolvedValue([{
      id: 'je-1', entry_number: 'JE-2026-01', entry_date: '2026-08-04',
      description: 'Absa line', posting_agent: 'mcp:allocate_bank_transaction:v1',
      status: 'posted', amount: '1250.00',
    }] as never);

    const rows = await listAgentPostings('company-1', '2026-08-01', '2026-08-31');

    expect(rows).toEqual([{
      journalEntryId: 'je-1', entryNumber: 'JE-2026-01', entryDate: '2026-08-04',
      description: 'Absa line', postingAgent: 'mcp:allocate_bank_transaction:v1',
      status: 'posted', amount: 1250,
    }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/unit/services/agentActivityService.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
/**
 * Agent activity — what the MCP agent posted, for review and bulk correction.
 *
 * The safety model for agent writes is attribution + review rather than
 * per-action confirmation: every MCP posting carries posting_agent
 * 'mcp:<tool>:v1', so this query answers "what did the agent do" and feeds
 * the decision to reverse.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/neon';

export interface AgentPosting {
  journalEntryId: string;
  entryNumber: string;
  entryDate: string;
  description: string;
  postingAgent: string;
  status: string;
  amount: number;
}

export async function listAgentPostings(
  companyId: string,
  fromDate: string,
  toDate: string,
): Promise<AgentPosting[]> {
  const rows = (await sql`
    SELECT je.id, je.entry_number, je.entry_date, je.description,
           je.posting_agent, je.status,
           COALESCE(SUM(jl.debit), 0) AS amount
    FROM gl_journal_entries je
    LEFT JOIN gl_journal_lines jl
      ON jl.journal_entry_id = je.id AND jl.company_id = ${companyId}::UUID
    WHERE je.company_id = ${companyId}::UUID
      AND je.posting_agent LIKE 'mcp:%'
      AND je.entry_date >= ${fromDate}::DATE
      AND je.entry_date <= ${toDate}::DATE
    GROUP BY je.id, je.entry_number, je.entry_date, je.description,
             je.posting_agent, je.status
    ORDER BY je.entry_date DESC, je.entry_number DESC
  `) as DbRow[];

  return rows.map((r) => ({
    journalEntryId: String(r.id),
    entryNumber: String(r.entry_number),
    entryDate: fmtDate(r.entry_date),
    description: String(r.description ?? ''),
    postingAgent: String(r.posting_agent ?? ''),
    status: String(r.status ?? ''),
    amount: Number(r.amount ?? 0),
  }));
}
```

> **Date note:** use `fmtDate` from `@/lib/neon`, never `toISODate` — the latter rolls pg DATE values back a day on this UTC+2 server.

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run tests/unit/services/agentActivityService.test.ts` → PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/modules/accounting/services/bank/agentActivityService.ts tests/unit/services/agentActivityService.test.ts
git commit -m "feat(accounting): list agent-originated postings for review"
```

---

### Task 6: `list_agent_postings` read tool

**Files:**
- Create: `src/lib/mcp/tools/agentActivity.ts`
- Modify: `src/lib/mcp/registry.ts`
- Test: `tests/unit/mcp/agentActivityTool.test.ts`

**Interfaces:**
- Consumes: `listAgentPostings` (Task 5).
- Produces: `listAgentPostingsTool: McpTool`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/bank/agentActivityService', () => ({
  listAgentPostings: vi.fn(),
}));

import { listAgentPostings } from '@/modules/accounting/services/bank/agentActivityService';
import { listAgentPostingsTool } from '@/lib/mcp/tools/agentActivity';

const ctx = { companyId: 'company-1', userId: 'user-1' } as never;

beforeEach(() => vi.clearAllMocks());

describe('list_agent_postings', () => {
  it('is read-only — reviewing agent work must never need write scope', () => {
    expect(listAgentPostingsTool.write).toBe(false);
    expect(listAgentPostingsTool.requiresPost).toBeUndefined();
    expect(listAgentPostingsTool.scope).toBe('read:reports');
  });

  it('passes the tenant from ctx and the requested range', async () => {
    vi.mocked(listAgentPostings).mockResolvedValue([]);

    await listAgentPostingsTool.handler({ from: '2026-08-01', to: '2026-08-31' }, ctx);

    expect(listAgentPostings).toHaveBeenCalledWith('company-1', '2026-08-01', '2026-08-31');
  });

  it('rejects a missing range rather than scanning the whole ledger', async () => {
    const res = await listAgentPostingsTool.handler({ from: '2026-08-01' }, ctx);

    expect(res.isError).toBe(true);
    expect(listAgentPostings).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/unit/mcp/agentActivityTool.test.ts` → FAIL, module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
/**
 * MCP read tool: list_agent_postings. "What did the agent do?" — every journal
 * stamped mcp:<tool>:v1 in a date range. This is the review half of the
 * attribution safety model; pair it with reverse_bank_allocation to correct.
 */
import type { McpTool } from '../types';
import { listAgentPostings } from '@/modules/accounting/services/bank/agentActivityService';
import { ok, safeErrorText, toolError } from './toolHelpers';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const listAgentPostingsTool: McpTool = {
  name: 'list_agent_postings',
  description:
    'Every journal entry this connector posted in a date range, with the tool that posted it. Use to review what the agent did before accepting or reversing it.',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'YYYY-MM-DD' },
      to: { type: 'string', description: 'YYYY-MM-DD' },
    },
    required: ['from', 'to'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const from = typeof args.from === 'string' ? args.from : '';
    const to = typeof args.to === 'string' ? args.to : '';
    if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
      return toolError('from and to are required, formatted YYYY-MM-DD');
    }
    try {
      const rows = await listAgentPostings(ctx.companyId, from, to); // tenant from ctx ONLY
      return ok({ postings: rows, count: rows.length });
    } catch (err) {
      return toolError(safeErrorText(err, 'Failed to list agent postings.'));
    }
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run tests/unit/mcp/agentActivityTool.test.ts` → PASS (3 tests)

- [ ] **Step 5: Register, re-run `bunx vitest run tests/unit/mcp/`, commit**

```bash
git add src/lib/mcp/tools/agentActivity.ts src/lib/mcp/registry.ts tests/unit/mcp/
git commit -m "feat(mcp): list_agent_postings review surface"
```

---

### Task 7: Benchmark harness

**Files:**
- Create: `scripts/mcp-recon-benchmark.ts`

**Interfaces:**
- Consumes: `listAgentPostings` (Task 5), `sql` from `@/lib/neon`.
- Produces: a CLI printing the acceptance metric.

**Acceptance criterion:** a full month of Velocity Fibre's Absa feed reconciled by the agent with **fewer than 5% of allocations corrected**. "Corrected" = an agent posting that was later reversed, measured as reversals of `posting_agent LIKE 'mcp:%'` entries within the window.

- [ ] **Step 1: Write the script**

```typescript
/**
 * MCP reconciliation benchmark.
 *
 * Usage: bun scripts/mcp-recon-benchmark.ts <companyId> <from> <to>
 *
 * Measures the acceptance criterion for the "agent does the work" slice:
 * of the bank allocations the agent posted in the window, what fraction were
 * subsequently reversed? Under 5% passes.
 */
import { sql } from '@/lib/neon';
import { listAgentPostings } from '@/modules/accounting/services/bank/agentActivityService';

async function main(): Promise<number> {
  const [companyId, from, to] = process.argv.slice(2);
  if (!companyId || !from || !to) {
    process.stderr.write('Usage: bun scripts/mcp-recon-benchmark.ts <companyId> <from> <to>\n');
    return 2;
  }

  const postings = await listAgentPostings(companyId, from, to);
  const reversedRows = (await sql`
    SELECT COUNT(*)::int AS n
    FROM gl_journal_entries je
    WHERE je.company_id = ${companyId}::UUID
      AND je.posting_agent LIKE 'mcp:%'
      AND je.entry_date >= ${from}::DATE
      AND je.entry_date <= ${to}::DATE
      AND je.status = 'reversed'
  `) as { n: number }[];

  const total = postings.length;
  const reversed = reversedRows[0]?.n ?? 0;
  const rate = total === 0 ? 0 : (reversed / total) * 100;

  process.stdout.write(
    `agent postings: ${total}\nreversed (corrections): ${reversed}\ncorrection rate: ${rate.toFixed(2)}%\n`,
  );
  process.stdout.write(rate < 5 ? 'BENCHMARK PASS (<5%)\n' : 'BENCHMARK FAIL (>=5%)\n');
  return rate < 5 ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }).catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Run it against an empty window to prove it reports honestly**

Run: `bun scripts/mcp-recon-benchmark.ts 4a159669-2f50-46b5-a7b8-2e94dab3d495 2026-01-01 2026-01-31`
Expected: `agent postings: 0`, `correction rate: 0.00%`, `BENCHMARK PASS`. A zero-posting window passing is expected — the benchmark is only meaningful after a real run, which is why the run itself is a gate below.

- [ ] **Step 3: Commit**

```bash
git add scripts/mcp-recon-benchmark.ts
git commit -m "test(mcp): reconciliation benchmark harness"
```

---

## Validation Gates

| Gate | What it proves | How |
|---|---|---|
| **A — CI** | Nothing regressed | `bun run ci` green on every task: type-check, lint, agent-docs, security-guards, unit, migration-naming, build |
| **B — Blind review** | A fresh reviewer accepts each tool | `/review` per PR; a reviewer that never saw the plan |
| **C — Pentest pass** | The new write surface holds | Adversarial pass targeting: can a `write:bank-tx`-only token reach `allocate_bank_transaction`? can `company_id` in args override ctx? does replaying an idempotency key double-post? |
| **D — Dev dry run** | The agent can actually reconcile | Isolated worktree + dev server against `isaflow_dev`, a PAT with `write:post`, agent reconciles 20 transactions |
| **E — Benchmark** | It's good enough to trust | `bun scripts/mcp-recon-benchmark.ts <velo> <month-start> <month-end>` → correction rate < 5% |

**Gate E is the real gate.** A, B, C and D can all pass on an agent that reconciles badly.

## Review Strategy

Per PR: a fresh blind reviewer with the raw diff plus `CLAUDE.md` only — no plan, no session context. Every write tool additionally gets the scope question asked explicitly: *"can this be reached by a token that did not opt into `write:post`?"* Gate C is a separate adversarial pass over the union diff, not per-PR.

## Rollback

Per company: remove the `mcp_connector` override row — the tools vanish for that tenant with no deploy. Per posting: `reverse_bank_allocation`. Per batch: `list_agent_postings` for the window, then reverse each. The connector was built dark behind a flag and can be re-darkened the same way.

## Known Constraints Carried In

- `bankReconciliationService.createAdjustmentEntry` was flagged in an earlier FK sweep as unsafe; it now passes `sourceDocumentId: reconciliationId`. **Verify before exposing any adjustment tool** — not in this slice.
- Tool count reaches ~26 after this slice. Before the next one, consolidate the report tools behind a single parameterised `run_report(name, period)` — MCP clients degrade as the list grows.
