# Group-aware Bank-Account Pickers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the import selector, start-reconciliation selector, reconciliation list, and bank-transactions report all nest paycards under their umbrella account, matching the grouping already shipped on the Bank Transactions cards.

**Architecture:** A single pure helper (`groupBankAccountOptions`) buckets a flat bank-account list into `{ primaries, groups }` using each row's `parentAccountId`. The two `<select>`-based selectors render groups as native `<optgroup>`. The reconciliation list groups its rows via a company-scoped parent join added to the existing query. The report's hardcoded stub picker becomes a real, grouped, dynamic list.

**Tech Stack:** Next.js 14 + TypeScript, `sql` tagged template (`@/lib/neon`, Supabase-backed), Vitest, native HTML `<optgroup>`. Package manager: bun.

---

### Task 1: Pure grouping helper + tests

**Files:**
- Create: `src/components/accounting/bank/groupBankOptions.ts`
- Test: `tests/unit/components/groupBankOptions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/components/groupBankOptions.test.ts
import { describe, it, expect } from 'vitest';
import { groupBankAccountOptions } from '@/components/accounting/bank/groupBankOptions';

interface Opt { id: string; parentAccountId: string | null; label: string }
const o = (id: string, parentAccountId: string | null = null): Opt => ({
  id, parentAccountId, label: `acct-${id}`,
});

describe('groupBankAccountOptions', () => {
  it('returns all accounts as primaries when none have a parent in the list', () => {
    const res = groupBankAccountOptions([o('1'), o('2'), o('3')]);
    expect(res.primaries.map(a => a.id)).toEqual(['1', '2', '3']);
    expect(res.groups).toEqual([]);
  });

  it('buckets children under their umbrella and drops the umbrella from options', () => {
    const res = groupBankAccountOptions([o('U'), o('c1', 'U'), o('c2', 'U'), o('P')]);
    expect(res.primaries.map(a => a.id)).toEqual(['P']);
    expect(res.groups).toHaveLength(1);
    expect(res.groups[0]!.umbrella.id).toBe('U');
    expect(res.groups[0]!.children.map(a => a.id)).toEqual(['c1', 'c2']);
  });

  it('supports multiple groups, preserving input order', () => {
    const res = groupBankAccountOptions([o('A'), o('a1', 'A'), o('B'), o('b1', 'B')]);
    expect(res.groups.map(g => g.umbrella.id)).toEqual(['A', 'B']);
  });

  it('treats a child whose parent is absent from the list as a primary', () => {
    const res = groupBankAccountOptions([o('x', 'GONE'), o('y')]);
    expect(res.primaries.map(a => a.id)).toEqual(['x', 'y']);
    expect(res.groups).toEqual([]);
  });

  it('groups only one level: a child-of-a-child nests under its direct parent', () => {
    // G is a parent (umbrella). m is G's child AND n's parent.
    // m is an umbrella for n; m is also G's child. One level each.
    const res = groupBankAccountOptions([o('G'), o('m', 'G'), o('n', 'm')]);
    const ids = res.groups.map(g => g.umbrella.id).sort();
    expect(ids).toEqual(['G', 'm']);
    const gGroup = res.groups.find(g => g.umbrella.id === 'G')!;
    const mGroup = res.groups.find(g => g.umbrella.id === 'm')!;
    expect(gGroup.children.map(a => a.id)).toEqual(['m']);
    expect(mGroup.children.map(a => a.id)).toEqual(['n']);
    expect(res.primaries).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:unit -- groupBankOptions`
Expected: FAIL — `Cannot find module '@/components/accounting/bank/groupBankOptions'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/components/accounting/bank/groupBankOptions.ts
/**
 * groupBankAccountOptions — buckets a flat bank-account list into primary
 * accounts and umbrella groups for use in <optgroup>-based pickers. An account
 * is an umbrella iff another row in the same list names it as parentAccountId;
 * the umbrella itself is NOT returned as a selectable option (you cannot import
 * or reconcile into it — each sub-account has its own statement). Children whose
 * parent is absent from the list fall back to primaries.
 */

export interface BankAccountGrouping<T> {
  primaries: T[];
  groups: { umbrella: T; children: T[] }[];
}

export function groupBankAccountOptions<
  T extends { id: string; parentAccountId: string | null },
>(accounts: T[]): BankAccountGrouping<T> {
  const byId = new Map(accounts.map(a => [a.id, a]));
  const umbrellaIds = new Set<string>();
  for (const a of accounts) {
    if (a.parentAccountId && byId.has(a.parentAccountId)) {
      umbrellaIds.add(a.parentAccountId);
    }
  }

  const primaries: T[] = [];
  const groups: { umbrella: T; children: T[] }[] = [];
  const groupIndex = new Map<string, number>();

  for (const a of accounts) {
    if (umbrellaIds.has(a.id)) {
      // This row IS an umbrella → it becomes a group label, not an option.
      if (!groupIndex.has(a.id)) {
        groupIndex.set(a.id, groups.length);
        groups.push({ umbrella: a, children: [] });
      } else {
        groups[groupIndex.get(a.id)!]!.umbrella = a;
      }
      continue;
    }
    if (a.parentAccountId && umbrellaIds.has(a.parentAccountId)) {
      let idx = groupIndex.get(a.parentAccountId);
      if (idx === undefined) {
        idx = groups.length;
        groupIndex.set(a.parentAccountId, idx);
        groups.push({ umbrella: byId.get(a.parentAccountId)!, children: [] });
      }
      groups[idx]!.children.push(a);
      continue;
    }
    primaries.push(a);
  }

  return { primaries, groups };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test:unit -- groupBankOptions`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/accounting/bank/groupBankOptions.ts tests/unit/components/groupBankOptions.test.ts
git commit -m "feat(banking): pure groupBankAccountOptions helper for <optgroup> pickers"
```

---

### Task 2: Group the import selector (`BankAccountSelector`)

**Files:**
- Modify: `src/components/accounting/bank/BankAccountSelector.tsx`

- [ ] **Step 1: Add `parentAccountId` to the option type and the mapper**

In `BankAccountSelector.tsx`, extend the interface (after `accountNumberLast4`):

```ts
export interface BankAccountOption {
  id: string;
  label: string;
  accountName: string;
  accountCode: string;
  accountNumberLast4: string;
  parentAccountId: string | null;
}
```

In the `.map` inside the effect, add `parentAccountId` to the returned object:

```ts
          return {
            id: String(a.id),
            accountName: name,
            accountCode: code,
            accountNumberLast4: last4,
            parentAccountId: a.parentAccountId || a.parent_account_id || null,
            label: `${code} — ${name}${last4 ? ` (****${last4})` : ''}`,
          };
```

- [ ] **Step 2: Import the helper and render groups**

Add the import at the top:

```ts
import { groupBankAccountOptions } from './groupBankOptions';
```

Replace the options render block (the `{options.map(o => ( <option … )} ` section) with grouped output. Compute grouping just before the `return`:

```ts
  const grouped = groupBankAccountOptions(options);
```

Then render inside the `<select>` after the placeholder `<option>`:

```tsx
          {grouped.primaries.map(o => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
          {grouped.groups.map(g => (
            <optgroup key={g.umbrella.id} label={g.umbrella.label}>
              {g.children.map(o => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          ))}
```

(The deep-link preselect effect already searches the flat `options` array — leave it untouched.)

- [ ] **Step 3: Verify types and lint**

Run: `bun run type-check && bun run lint`
Expected: no new errors in `BankAccountSelector.tsx`.

- [ ] **Step 4: Commit**

```bash
git add src/components/accounting/bank/BankAccountSelector.tsx
git commit -m "feat(banking): group sub-accounts under <optgroup> in BankAccountSelector"
```

---

### Task 3: Reuse the selector on Start Reconciliation (`new.tsx`)

**Files:**
- Modify: `pages/accounting/bank-reconciliation/new.tsx`

- [ ] **Step 1: Swap the inline select for `BankAccountSelector`**

Remove the local `BankAccount` interface, the `bankAccounts` state, and the `useEffect` that fetches `/api/accounting/chart-of-accounts?subtype=bank`. Add the import:

```ts
import { BankAccountSelector } from '@/components/accounting/bank/BankAccountSelector';
```

Replace the `<div>` containing `<label>Bank Account *</label>` and its `<select>` (lines ~95–112) with:

```tsx
            <BankAccountSelector
              value={form.bankAccountId || null}
              onChange={(id) => setForm(f => ({ ...f, bankAccountId: id }))}
            />
```

Keep `form.bankAccountId` (still drives the disabled submit button and the POST body). Remove now-unused `useEffect` import if nothing else uses it (it isn't — delete `useEffect` from the `react` import, keep `useState`).

- [ ] **Step 2: Verify types and lint**

Run: `bun run type-check && bun run lint`
Expected: no unused-variable or missing-import errors in `new.tsx`.

- [ ] **Step 3: Commit**

```bash
git add pages/accounting/bank-reconciliation/new.tsx
git commit -m "refactor(banking): reuse grouped BankAccountSelector on Start Reconciliation"
```

---

### Task 4: Surface group fields on reconciliation rows (service + type)

**Files:**
- Modify: `src/modules/accounting/types/bank.types.ts:93-114`
- Modify: `src/modules/accounting/services/bank/bankReconciliationService.ts` (`getReconciliations` ~18-43, `mapReconRow` ~246-267)

- [ ] **Step 1: Add optional group fields to the `BankReconciliation` type**

In `bank.types.ts`, inside `interface BankReconciliation`, under the `// Joined` comment, add:

```ts
  groupId?: string;
  groupName?: string;
```

- [ ] **Step 2: Add the company-scoped parent join to both `getReconciliations` branches**

In `bankReconciliationService.ts`, in BOTH the `bankAccountId`-filtered and unfiltered `SELECT`s inside `getReconciliations`, change the select list and add the join. The bankAccountId branch becomes:

```ts
      ? (await sql`
          SELECT br.*, ga.account_name AS bank_account_name,
            ga.parent_account_id AS group_id,
            pa.account_name AS group_name,
            pa.account_subtype AS parent_subtype,
            (SELECT COUNT(*) FROM bank_transactions WHERE reconciliation_id = br.id AND status = 'matched') AS matched_count,
            (SELECT COUNT(*) FROM bank_transactions WHERE reconciliation_id = br.id AND status = 'imported') AS unmatched_count
          FROM bank_reconciliations br
          LEFT JOIN gl_accounts ga ON ga.id = br.bank_account_id
          LEFT JOIN gl_accounts pa ON pa.id = ga.parent_account_id AND pa.company_id = ga.company_id
          WHERE br.company_id = ${companyId} AND br.bank_account_id = ${bankAccountId}::UUID
          ORDER BY br.statement_date DESC`) as DbRow[]
```

The unfiltered branch becomes:

```ts
      : (await sql`
          SELECT br.*, ga.account_name AS bank_account_name,
            ga.parent_account_id AS group_id,
            pa.account_name AS group_name,
            pa.account_subtype AS parent_subtype,
            (SELECT COUNT(*) FROM bank_transactions WHERE reconciliation_id = br.id AND status = 'matched') AS matched_count,
            (SELECT COUNT(*) FROM bank_transactions WHERE reconciliation_id = br.id AND status = 'imported') AS unmatched_count
          FROM bank_reconciliations br
          LEFT JOIN gl_accounts ga ON ga.id = br.bank_account_id
          LEFT JOIN gl_accounts pa ON pa.id = ga.parent_account_id AND pa.company_id = ga.company_id
          WHERE br.company_id = ${companyId}
          ORDER BY br.statement_date DESC`) as DbRow[];
```

- [ ] **Step 3: Map the group fields only when the parent is a bank-subtype account**

In `mapReconRow`, after the `bankAccountName` line, add:

```ts
    groupId: row.parent_subtype === 'bank' && row.group_id ? String(row.group_id) : undefined,
    groupName: row.parent_subtype === 'bank' && row.group_name ? String(row.group_name) : undefined,
```

- [ ] **Step 4: Verify types and lint**

Run: `bun run type-check && bun run lint`
Expected: no errors in the two files.

- [ ] **Step 5: Commit**

```bash
git add src/modules/accounting/types/bank.types.ts src/modules/accounting/services/bank/bankReconciliationService.ts
git commit -m "feat(banking): return groupId/groupName on reconciliation rows (bank-subtype parent only)"
```

---

### Task 5: Group the reconciliation list page (`index.tsx`)

**Files:**
- Modify: `pages/accounting/bank-reconciliation/index.tsx`

- [ ] **Step 1: Group rows by umbrella before render**

After `setReconciliations(...)` data is in state, compute a grouped view. Add a `useMemo` (import `useMemo` from `react`) just before the `return`:

```ts
  const grouped = useMemo(() => {
    const primaries: BankReconciliation[] = [];
    const order: string[] = [];
    const byGroup = new Map<string, { name: string; rows: BankReconciliation[] }>();
    for (const r of reconciliations) {
      if (r.groupId && r.groupName) {
        let g = byGroup.get(r.groupId);
        if (!g) { g = { name: r.groupName, rows: [] }; byGroup.set(r.groupId, g); order.push(r.groupId); }
        g.rows.push(r);
      } else {
        primaries.push(r);
      }
    }
    return { primaries, groups: order.map(id => ({ id, ...byGroup.get(id)! })) };
  }, [reconciliations]);
```

- [ ] **Step 2: Extract the row markup and render grouped sections**

Extract the existing `<tr>` body into a local render function so it can be reused for primaries and group children. Above the `return`, add:

```tsx
  const renderRow = (r: BankReconciliation, indent = false) => (
    <tr key={r.id} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)] transition-colors">
      <td className={`px-4 py-3 text-[var(--ff-text-primary)] ${indent ? 'pl-8' : ''}`}>{r.bankAccountName || '—'}</td>
      <td className="px-4 py-3 text-[var(--ff-text-secondary)]">
        {new Date(r.statementDate).toLocaleDateString('en-ZA')}
      </td>
      <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-primary)]">
        {formatCurrency(r.statementBalance)}
      </td>
      <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-primary)]">
        {formatCurrency(r.reconciledBalance)}
      </td>
      <td className={`px-4 py-3 text-right font-mono font-bold ${Math.abs(r.difference) < 0.01 ? 'text-teal-400' : 'text-red-400'}`}>
        {formatCurrency(r.difference)}
      </td>
      <td className="px-4 py-3 text-center">
        <span className="text-[var(--ff-text-secondary)]">
          {r.matchedCount ?? 0}
          {r.unmatchedCount !== undefined && <span className="text-[var(--ff-text-tertiary)]"> / {(r.matchedCount ?? 0) + (r.unmatchedCount ?? 0)}</span>}
        </span>
      </td>
      <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
      <td className="px-4 py-3 text-right">
        <Link href={`/accounting/bank-reconciliation/${r.id}`} className="text-teal-500 hover:text-teal-400">
          {r.status === 'completed' ? <CheckCircle2 className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </Link>
      </td>
    </tr>
  );
```

Replace the existing `<tbody>` `{reconciliations.map(r => ( … ))}` with:

```tsx
                <tbody>
                  {grouped.primaries.map(r => renderRow(r))}
                  {grouped.groups.map(g => (
                    <Fragment key={g.id}>
                      <tr className="bg-[var(--ff-bg-primary)]/60">
                        <td colSpan={8} className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-[var(--ff-text-secondary)]">
                          {g.name} <span className="text-[var(--ff-text-tertiary)]">({g.rows.length})</span>
                        </td>
                      </tr>
                      {g.rows.map(r => renderRow(r, true))}
                    </Fragment>
                  ))}
                </tbody>
```

Add `Fragment` to the `react` import and `useMemo`:

```ts
import { useState, useEffect, useCallback, useMemo, Fragment } from 'react';
```

Add the type import (used by the helpers):

```ts
import type { BankReconciliation } from '@/modules/accounting/types/bank.types';
```

(It is already imported — confirm, do not duplicate.)

- [ ] **Step 3: Verify types and lint**

Run: `bun run type-check && bun run lint`
Expected: no errors in `index.tsx`.

- [ ] **Step 4: Commit**

```bash
git add pages/accounting/bank-reconciliation/index.tsx
git commit -m "feat(banking): group paycard reconciliations under umbrella header rows"
```

---

### Task 6: Make the report picker real and grouped (`reports/bank-transactions.tsx`)

**Files:**
- Modify: `pages/accounting/reports/bank-transactions.tsx:36-110`

- [ ] **Step 1: Load real bank accounts and default to the first primary**

Add imports near the top:

```ts
import { apiFetch } from '@/lib/apiFetch';
import { groupBankAccountOptions } from '@/components/accounting/bank/groupBankOptions';
```

(`apiFetch` is already imported — confirm, do not duplicate.)

Add an option type and state inside the component, replacing `const [accountCode, setAccountCode] = useState('1110');`:

```ts
  interface AcctOpt { id: string; accountCode: string; label: string; parentAccountId: string | null }
  const [accounts, setAccounts] = useState<AcctOpt[]>([]);
  const [accountCode, setAccountCode] = useState('');
```

Add an effect to load bank accounts (place after the `getDefaultDates` usage, before `load`):

```ts
  useEffect(() => {
    apiFetch('/api/accounting/chart-of-accounts?subtype=bank')
      .then(r => r.json())
      .then(res => {
        const data = res.data || res;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const list: any[] = Array.isArray(data) ? data : data.accounts || [];
        const opts: AcctOpt[] = list.map(a => {
          const code = a.accountCode || a.account_code || '';
          const name = a.accountName || a.account_name || '';
          return {
            id: String(a.id),
            accountCode: code,
            parentAccountId: a.parentAccountId || a.parent_account_id || null,
            label: `${code} — ${name}`,
          };
        });
        setAccounts(opts);
        const grouped = groupBankAccountOptions(opts);
        const first = grouped.primaries[0] || grouped.groups[0]?.children[0];
        if (first) setAccountCode(first.accountCode);
      })
      .catch(() => { /* picker stays empty; report load guards on accountCode */ });
  }, []);
```

- [ ] **Step 2: Guard the report load until an account is chosen**

In `load`, change the early-return guard so it does not fire a request with an empty `account_code`:

```ts
    if (!periodStart || !periodEnd || !accountCode) return;
```

- [ ] **Step 3: Render the grouped picker**

Replace the hardcoded `<select>` (the block with `<option value="1110">` / `<option value="1130">`) with:

```tsx
              <select value={accountCode} onChange={e => setAccountCode(e.target.value)} className="ff-select text-sm">
                {accounts.length === 0 && <option value="">No bank accounts</option>}
                {(() => {
                  const grouped = groupBankAccountOptions(accounts);
                  return (
                    <>
                      {grouped.primaries.map(o => (
                        <option key={o.id} value={o.accountCode}>{o.label}</option>
                      ))}
                      {grouped.groups.map(g => (
                        <optgroup key={g.umbrella.id} label={g.umbrella.label}>
                          {g.children.map(o => (
                            <option key={o.id} value={o.accountCode}>{o.label}</option>
                          ))}
                        </optgroup>
                      ))}
                    </>
                  );
                })()}
              </select>
```

- [ ] **Step 4: Verify types and lint**

Run: `bun run type-check && bun run lint`
Expected: no errors in `reports/bank-transactions.tsx`.

- [ ] **Step 5: Commit**

```bash
git add pages/accounting/reports/bank-transactions.tsx
git commit -m "feat(banking): real grouped account picker on bank-transactions report"
```

---

### Task 7: Full gate + browser verify

**Files:** none (verification only)

- [ ] **Step 1: Run the unit suite and static gates**

Run: `bun run test:unit -- groupBankOptions && bun run type-check && bun run lint`
Expected: groupBankOptions PASS (5), type-check clean, lint within ratchet.

- [ ] **Step 2: Browser-verify on demo data**

Per the handoff recipe (headless `playwright-core` from repo root, login `admin@isaflow.co.za` / `admin123`, `localStorage.setItem('isaflow_tour_completed','true')`, switch company to ISAFlow Demo which has umbrella `1119` + paycards `1121`–`1123`), confirm:
- Import Statement selector shows paycards under a `1119 — …` optgroup.
- Start Reconciliation selector shows the same grouping.
- Reconciliation list shows an umbrella header row above paycard sessions (if any exist; otherwise no group header — acceptable).
- Bank Transactions report picker is populated (no longer `1110`/`1130` literals) and grouped.

- [ ] **Step 3: Commit any verification fixes, then open PR**

```bash
timeout 420 git push -u origin feat/bank-group-pickers
gh pr create --title "feat(banking): group-aware bank-account pickers (Phase 3.2)" \
  --body "Nests paycards under their umbrella via native <optgroup> on the import selector, start-reconciliation selector, reconciliation list, and bank-transactions report. Pure groupBankAccountOptions helper + tests. No schema change. Spec: docs/superpowers/specs/2026-06-09-bank-group-pickers-design.md"
```

(Note: pre-push hook runs `next build` ~2-3 min; verify with `git ls-remote` if the push appears to time out.)

---

## Self-Review

**Spec coverage:**
- Import selector → Task 2. ✅
- New-recon selector → Task 3. ✅
- Recon list grouping → Tasks 4 (data) + 5 (UI). ✅
- Banking overview report → Task 6. ✅
- Pure helper + tests → Task 1. ✅
- Browser verify on demo → Task 7. ✅

**Placeholder scan:** No TBD/TODO; every code step shows full code. ✅

**Type consistency:** `groupBankAccountOptions<T extends { id; parentAccountId }>` returns `{ primaries, groups: [{ umbrella, children }] }` — consumed identically in Tasks 2, 6. `BankAccountOption` gains `parentAccountId: string | null` (Task 2), satisfying the helper's `T` constraint. Recon rows gain `groupId?`/`groupName?` (Task 4 type) consumed in Task 5. ✅

**Note on Task 5 dedup import:** `BankReconciliation` is already imported in `index.tsx`; Step 2 says confirm-don't-duplicate. Same for `apiFetch` in Task 6.
