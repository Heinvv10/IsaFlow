# Phase 3 Increment 2 — Group-aware bank-account pickers

**Date:** 2026-06-09
**Branch:** `feat/bank-group-pickers`
**Follows:** PR #149 (bank sub-account grouping — Bank Transactions cards), `c56b4ee7`

## Problem

Increment 1 grouped paycards behind umbrella cards on the **Bank Transactions**
page, but every other bank-account picker in the app is still a flat list. For a
client like Velocity Fibre with 25 paycards under two umbrellas (`STD Paycards`,
`ABSA Paycards`), these pickers are a wall of 28 indistinguishable options:

- **Import Statement** page selector (`BankAccountSelector`, via `BulkImportPanel`)
- **Start Reconciliation** page selector (`new.tsx`, a duplicate inline `<select>`)
- **Bank Reconciliation list** (`index.tsx`) — flat table of sessions
- **Bank Transactions report** (`reports/bank-transactions.tsx`) — a *hardcoded*
  2-option picker (`1110`/`1130`) that is broken for any company lacking those codes

## Goal

Make all four surfaces group-aware: paycards nest under their umbrella, primary
accounts stay flat. No schema change, no new endpoint — grouping data is already
available client-side.

## Design

### Core idea

Native HTML `<optgroup>` for the selectors (accessible, zero-dependency, matches
the existing card grouping). The COA `subtype=bank` response already includes both
the umbrella row and each child's `parentAccountId`, so grouping happens entirely
client-side.

### Semantic rule

The umbrella account is a **non-selectable `<optgroup>` label**, never a pickable
target. You cannot import a statement or reconcile *into* an umbrella — each paycard
has its own statement (the confirmed increment-1 requirement). Primary accounts
remain flat selectable options.

An account is an **umbrella** iff another row in the same list names it as
`parentAccountId`. Because the COA call already filters `subtype = 'bank'`, any
`parentAccountId` that resolves to a row in this list is by definition a bank-subtype
parent — no extra subtype check needed client-side.

### Components

#### 1. `src/components/accounting/bank/groupBankOptions.ts` (new, pure)

Generic helper over `{ id, parentAccountId }`:

```ts
interface GroupedOptions<T> {
  primaries: T[];
  groups: { umbrella: T; children: T[] }[];
}
function groupBankAccountOptions<T extends { id: string; parentAccountId: string | null }>(
  accounts: T[],
): GroupedOptions<T>;
```

Logic:
1. Build `umbrellaIds` = set of ids that appear as some row's `parentAccountId`
   **and** are themselves present in the list.
2. For each account: if its id ∈ `umbrellaIds` → skip (it becomes a group label,
   not an option); else if its `parentAccountId` ∈ `umbrellaIds` → child of that
   group; else → primary.
3. Return primaries in input order; groups keyed by umbrella, children in input order.

Separate `.ts` file (not co-located in a `.tsx`) because vitest cannot transform
`.tsx` — same constraint that produced `parentCandidates.ts` in increment 1.

Unit tests: primaries-only, single group, multi-group, child whose parent is absent
(orphan → treated as primary), and an account that is both a child and a parent
(deep nesting → the grandparent is still only one level of grouping; the umbrella is
the direct parent).

#### 2. `BankAccountSelector.tsx` (import page)

- Add `parentAccountId: string | null` to `BankAccountOption`; populate from
  `a.parentAccountId || a.parent_account_id || null` in the existing map.
- Run `groupBankAccountOptions(options)`; render primaries as flat `<option>`s,
  then one `<optgroup label={umbrella.label}>` per group containing its children.
- Deep-link preselect (`initialValue`) still searches the full flat `options`
  array — unchanged. (If an `initialValue` points at an umbrella id, no option
  matches and nothing is preselected — acceptable: umbrellas aren't import targets.)

#### 3. `new.tsx` (Start Reconciliation)

Replace the inline `<select>` + its own COA fetch/mapping with the shared
`<BankAccountSelector value={form.bankAccountId} onChange={(id) => setForm(f => ({ ...f, bankAccountId: id }))} />`.
Removes ~25 lines of duplicated fetch/mapping; gains grouping for free. The
submit button stays disabled until `form.bankAccountId` is set (unchanged).

#### 4. Recon list (`index.tsx` + API + service)

- `bankReconciliationService.getReconciliations`: add a **company-scoped** LEFT JOIN
  to the parent of the bank account, selecting the parent name and subtype:

  ```sql
  LEFT JOIN gl_accounts pa
    ON pa.id = ga.parent_account_id AND pa.company_id = ga.company_id
  ...
  pa.account_name AS group_name,
  pa.account_subtype AS parent_subtype,
  ga.parent_account_id AS group_id
  ```

  `mapRow`: surface `groupId`/`groupName` **only when** `parent_subtype = 'bank'`
  (mirror the bank-accounts grouping rule); otherwise leave them undefined.
- `index.tsx`: group reconciliation rows client-side by `groupId`. Render an umbrella
  sub-header `<tr>` (group name + rolled-up count), then its member rows indented;
  ungrouped reconciliations render exactly as today. Reuse the grouping shape from
  `groupBankAccountOptions` conceptually but on recon rows (a small inline group-by
  is fine here — the row type differs from the option type).

#### 5. Banking overview report (`reports/bank-transactions.tsx`)

The picker is currently hardcoded to two `account_code` values. Make it dynamic:
- Fetch bank accounts from `/api/accounting/chart-of-accounts?subtype=bank`.
- Map to options carrying `account_code` (the report fetch param) and
  `parentAccountId`; run `groupBankAccountOptions`.
- Render grouped `<optgroup>`s with `value = account_code` to preserve the existing
  `account_code`-keyed report fetch and CSV export.
- Default `accountCode` to the first primary account's code instead of the literal
  `'1110'` (falls back to empty string when no accounts exist).

### Testing

- Unit: `groupBankAccountOptions` (5 cases above).
- Browser-verify all four wirings on **demo** data (ISAFlow Demo: umbrella `1119`
  + paycards `1121`–`1123`), using the headless `playwright-core` recipe from the
  handoff (login `admin@isaflow.co.za` / `admin123`, `localStorage` tour-dismiss).
- `bun run type-check` + `bun run lint` + `bun run test:unit` green before PR.

### Out of scope

- No schema change, no new endpoint.
- The bank-transfers picker and `[reconId].tsx` matching screen are untouched.
- How umbrellas are stored/created (that's the bank-accounts Add/Edit modals, done
  in increment 1).
- The Sage-importer NULL-subtype root cause (separate tracked next step).

### Risk

Low. All UI-layer except the recon-list query change, which adds a company-scoped
join and two derived fields — no behavior change for ungrouped companies (every
recon row simply has undefined `groupId` and renders flat, exactly as today).
