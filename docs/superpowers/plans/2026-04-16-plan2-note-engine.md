# Plan 2 — Note Engine + 30 Notes

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task dispatches a fresh implementer subagent, a spec-review subagent, then a code-quality-review subagent before merge.

**Goal:** Build the full Note Engine — 4-stage pipeline, 30 IFRS note generators, auto-suppress zero-balance notes, AI narrative integration, note reordering API, three new API routes — wired into the AFS document model from Plan 1.

**Prerequisite:** Plan 1 (Document Engine Foundation) is complete. Types from `@/modules/accounting/services/afs/afsTypes.ts` are available. DB tables `afs_documents`, `afs_sections`, `note_templates`, `afs_generation_log` exist.

**Spec:** `docs/superpowers/specs/2026-04-16-financial-reporting-afs-design.md` (Section 2 — The Note Engine)

**Tech stack:** Next.js 14, TypeScript (strict), Neon Postgres (`sql` tagged template from `@/lib/neon`), Vitest, bun, `@anthropic-ai/sdk`.

**Autonomy envelope:** Waves A and B may run in parallel within each wave. Hard stop after Wave B for Hein review before Wave C (API routes + tests).

---

## Per-task workflow (applies to every task unless explicitly overridden)

```
1. Dispatch implementer subagent:
   - Create worktree: `git worktree add ../isaflow-<slug> master -b feat/<slug>`
   - Write failing tests first (RED) — run `bunx vitest run <test-path>` → confirm FAIL
   - Implement minimum code to pass
   - Run `bunx vitest run <test-path>` → confirm PASS
   - Run `bunx tsc --noEmit` → zero errors
   - Commit with prescribed message

2. Dispatch spec-compliance reviewer subagent:
   - Input: relevant spec section + git diff
   - Confirm fix addresses all acceptance criteria
   - If gaps: implementer fixes, re-review

3. Dispatch code-quality reviewer subagent:
   - Input: git diff + project CLAUDE.md rules
   - Confirm: no console.log, sql tagged template, company_id in every query,
     withCompany wraps all handlers, apiResponse helpers used, no empty catches,
     no `any` abuse, every file ≤300 lines
   - If issues: implementer fixes, re-review

4. Controller merges worktree branch into master via fast-forward:
   - cd /home/hein/Workspace/IsaFlow && git merge --ff-only feat/<slug>
   - git worktree remove ../isaflow-<slug>
```

**Commit message template:** `feat(afs-note-engine): <one-line summary>` (lowercase, imperative).
Trailer: `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`

---

## File Map — New Files This Plan Creates

| File | Purpose |
|------|---------|
| `src/modules/accounting/services/afs/noteEngineService.ts` | Orchestrator: 4-stage pipeline per section or all sections |
| `src/modules/accounting/services/afs/noteDataQueryService.ts` | Executes named queries from `NoteTemplate.dataQueries` |
| `src/modules/accounting/services/afs/noteRendererService.ts` | Converts `dataSnapshot` + `contentSchema` → `NoteContent` |
| `src/modules/accounting/services/afs/noteAiService.ts` | Calls Claude API with `aiPromptTemplate` |
| `src/modules/accounting/services/afs/noteGenerators/notes1to10.ts` | Note generators for Notes 1–10 |
| `src/modules/accounting/services/afs/noteGenerators/notes11to20.ts` | Note generators for Notes 11–20 |
| `src/modules/accounting/services/afs/noteGenerators/notes21to30.ts` | Note generators for Notes 21–30 |
| `src/modules/accounting/services/afs/noteGenerators/index.ts` | Barrel export: all 30 generators |
| `pages/api/accounting/afs/[documentId]/sections/[sectionId]/regenerate.ts` | POST — re-run engine for one section |
| `pages/api/accounting/afs/[documentId]/sections/[sectionId]/ai-narrative.ts` | POST generate / PUT accept AI narrative |
| `pages/api/accounting/afs/[documentId]/sections/[sectionId]/suppress.ts` | POST — suppress zero-balance note with reason |
| `pages/api/accounting/afs/[documentId]/sections/reorder.ts` | PUT — reorder note sections |
| `tests/unit/services/afs/noteEngineService.test.ts` | Unit tests: pipeline orchestration |
| `tests/unit/services/afs/noteRendererService.test.ts` | Unit tests: renderer output shapes |
| `tests/unit/services/afs/noteGenerators/notes1to10.test.ts` | Unit tests: notes 1–10 data + render |

**Migrated (do not delete the originals until Wave D sign-off):**
- `src/modules/accounting/services/reports/disclosureNoteGenerators.ts` — 7 generators extracted into the new engine; originals left in place until migration confirmed

---

## Shared Helpers (inline in noteGenerators files)

```typescript
// Used in all three noteGenerators files — copy verbatim, do not import across files
function fmt(n: number | null | undefined): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-ZA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function fiscalRange(year: number): { start: string; end: string } {
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}
```

---

## Wave A — Core Services (parallel, no inter-dependencies)

### Task A1 — noteDataQueryService.ts

**File:** `src/modules/accounting/services/afs/noteDataQueryService.ts`

**Purpose:** Executes named queries from `NoteTemplate.dataQueries` against the live database for a given `companyId` + `fiscalYear`. Returns a `Record<string, unknown[]>` keyed by query name — this becomes `AfsSection.dataSnapshot`.

**Interface:**

```typescript
export async function executeDataQueries(
  companyId: string,
  fiscalYear: number,
  dataQueries: Record<string, string>,
): Promise<Record<string, unknown[]>>
```

**Implementation rules:**
- `dataQueries` is a map of `{ queryName: sqlString }` — the SQL strings come from the `NoteTemplate` row
- Run all queries in `Promise.all` for parallelism
- Each SQL string uses named placeholders `{companyId}` and `{fiscalYear}` that the service replaces with safe parameterised bindings before executing via `sql` tagged template
- Returns `{}` (empty object, not throw) if `dataQueries` is empty — caller uses this to detect zero-balance suppression candidate
- Log each query name at `log.info` level with `{ companyId, queryName }` — never log query values

**Zero-balance detection helper:**

```typescript
export function isZeroBalance(snapshot: Record<string, unknown[]>): boolean {
  return Object.values(snapshot).every(rows => rows.length === 0);
}
```

**Acceptance criteria:**
- `executeDataQueries` runs all queries concurrently
- Returns correct keyed result set
- Does not throw on empty `dataQueries` map
- `isZeroBalance` returns `true` only when every query result is empty

---

### Task A2 — noteRendererService.ts

**File:** `src/modules/accounting/services/afs/noteRendererService.ts`

**Purpose:** Converts a `dataSnapshot` (raw GL rows) and a `contentSchema` (shape definition from `NoteTemplate`) into a typed `NoteContent` object. This is the bridge between raw data and the structured block model.

**Interface:**

```typescript
import type { NoteContent, NoteContentBlock } from '@/modules/accounting/services/afs/afsTypes';

export function renderNoteContent(
  title: string,
  dataSnapshot: Record<string, unknown[]>,
  contentSchema: Record<string, unknown>,
): NoteContent
```

**Block types to support:**

| Block type | When used | How rendered |
|------------|-----------|-------------|
| `heading` | Section sub-heading | `{ type: 'heading', text: string, level: 2\|3 }` |
| `paragraph` | Introductory text from schema `intro` field | `{ type: 'paragraph', text: string }` |
| `table` | Any non-empty array in `dataSnapshot` | `{ type: 'table', headers: string[], rows: string[][] }` |
| `list` | Arrays of string items from schema | `{ type: 'list', items: string[] }` |

**Content schema shape (expected fields in `contentSchema`):**

```typescript
interface ContentSchema {
  intro?: string;                          // paragraph block, rendered first
  sections?: Array<{
    heading?: string;                      // heading block level 3
    queryKey: string;                      // key into dataSnapshot
    headers: string[];                     // table column headers
    columns: string[];                     // field names in each row object
    numberColumns?: number[];              // column indices to fmt() as numbers
    totalRow?: boolean;                    // append a totals row
  }>;
}
```

**Number formatting:** use `fmt()` helper for any column index in `numberColumns`.

**Acceptance criteria:**
- Produces valid `NoteContent` with at least one block for non-empty snapshot
- Zero-row table → omits that table block (does not include empty tables)
- `intro` always present as first paragraph block if defined in schema
- `totalRow: true` appends a totals row summing all `numberColumns`
- Does not throw on empty `dataSnapshot`

---

### Task A3 — noteAiService.ts

**File:** `src/modules/accounting/services/afs/noteAiService.ts`

**Purpose:** Calls the Claude API with an `aiPromptTemplate` to produce a plain-English narrative paragraph for a note. Output is stored in `AfsSection.aiNarrative`. It is never auto-accepted — accountant reviews and accepts separately.

**Interface:**

```typescript
import Anthropic from '@anthropic-ai/sdk';
import type { NoteContent } from '@/modules/accounting/services/afs/afsTypes';
import type { SectionType, ReportingFramework } from '@/modules/accounting/services/afs/afsTypes';

export interface CompanyContext {
  name: string;
  framework: ReportingFramework;
  fiscalYear: number;
}

export async function generateNoteNarrative(
  sectionType: SectionType,
  content: NoteContent,
  promptTemplate: string,
  companyContext: CompanyContext,
): Promise<string>
```

**Implementation:**

```typescript
const client = new Anthropic();

export async function generateNoteNarrative(
  sectionType: SectionType,
  content: NoteContent,
  promptTemplate: string,
  companyContext: CompanyContext,
): Promise<string> {
  const prompt = promptTemplate
    .replace('{tables}', JSON.stringify(content.blocks.filter(b => b.type === 'table')))
    .replace('{companyName}', companyContext.name)
    .replace('{fiscalYear}', String(companyContext.fiscalYear))
    .replace('{framework}', companyContext.framework)
    .replace('{sectionType}', sectionType);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content[0]?.type === 'text' ? response.content[0].text : '';
}
```

**Error handling:**
- Catch Anthropic API errors; log at `log.error` with `{ sectionType, companyId: companyContext.name }`; rethrow as `new Error('AI narrative generation failed: ' + err.message)`
- Never swallow errors silently

**Acceptance criteria:**
- Returns string narrative on success
- Template placeholders `{tables}`, `{companyName}`, `{fiscalYear}`, `{framework}`, `{sectionType}` all replaced
- Throws with descriptive message on API failure
- Unit test mocks `@anthropic-ai/sdk` via `vi.mock`

---

## Wave B — Note Generators (parallel batches within each group)

### Task B1 — notes1to10.ts

**File:** `src/modules/accounting/services/afs/noteGenerators/notes1to10.ts`

**Each generator signature:**

```typescript
export async function generateNote<N>(
  companyId: string,
  fiscalYear: number,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }>
```

#### Note 1 — Accounting Policies (migrated from `noteAccountingPolicies`)

**Data query:**
```sql
SELECT depreciation_method, inventory_valuation_method,
       default_currency, vat_system_type
FROM companies
WHERE id = ${companyId}
```

**Content:** Single paragraph block describing basis of preparation, PPE policy, inventories, revenue recognition, taxation. Incorporate actual values from query row. No table block.

**Auto-suppress:** Never suppress (always mandatory).

**AI prompt template field:** `aiPromptTemplate` — accountant-facing language improvement pass.

---

#### Note 2 — Critical Estimates and Judgements

**Data query:**
```sql
SELECT ga.account_subtype, ga.account_name,
       SUM(gjl.debit_amount - gjl.credit_amount) AS net_balance
FROM gl_accounts ga
JOIN gl_journal_lines gjl ON gjl.account_id = ga.id
  AND gjl.company_id = ${companyId}
JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
  AND gje.entry_date BETWEEN ${start} AND ${end}
  AND gje.status = 'posted'
WHERE ga.company_id = ${companyId}
  AND ga.account_subtype IN ('provision', 'impairment', 'deferred_tax', 'depreciation')
GROUP BY ga.account_subtype, ga.account_name
ORDER BY ga.account_subtype
```

**Content:** Paragraph introducing areas of significant judgement, then a list block of the identified subtypes. Zero results → suppress with reason `'zero_balance'`.

**Auto-gen level:** `partial` — numbers generate, narrative requires accountant input or AI pass.

---

#### Note 3 — Property, Plant and Equipment (migrated from `notePPE`, reference implementation)

**Data query (reference implementation — show full SQL):**

```typescript
export async function generateNote3PPE(
  companyId: string,
  fiscalYear: number,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  const { start, end } = fiscalRange(fiscalYear);

  const rows = await sql`
    SELECT fa.category,
      SUM(fa.cost) AS total_cost,
      SUM(fa.accumulated_depreciation) AS total_accum_dep,
      SUM(CASE WHEN fa.acquisition_date BETWEEN ${start} AND ${end}
               THEN fa.cost ELSE 0 END) AS additions,
      SUM(CASE WHEN fa.disposal_date BETWEEN ${start} AND ${end}
               THEN fa.cost ELSE 0 END) AS disposals,
      SUM(fa.depreciation_charge) AS dep_charge
    FROM fixed_assets fa
    WHERE fa.company_id = ${companyId}
      AND (fa.disposal_date IS NULL OR fa.disposal_date >= ${start})
    GROUP BY fa.category
    ORDER BY fa.category
  ` as DbRow[];

  const dataSnapshot = { ppe: rows };

  const tableRows = rows.map((r: DbRow) => {
    const cv = (Number(r.total_cost) || 0) - (Number(r.total_accum_dep) || 0);
    return [
      String(r.category ?? 'Uncategorised'),
      fmt(r.total_cost as number | null),
      fmt(r.total_accum_dep as number | null),
      fmt(cv),
      fmt(r.additions as number | null),
      fmt(r.disposals as number | null),
      fmt(r.dep_charge as number | null),
    ];
  });

  if (rows.length > 0) {
    const totalCost = rows.reduce((s: number, r: DbRow) => s + (Number(r.total_cost) || 0), 0);
    const totalAccum = rows.reduce((s: number, r: DbRow) => s + (Number(r.total_accum_dep) || 0), 0);
    tableRows.push(['Total', fmt(totalCost), fmt(totalAccum), fmt(totalCost - totalAccum), '—', '—', '—']);
  }

  const content: NoteContent = {
    title: 'Property, Plant and Equipment',
    blocks: [
      {
        type: 'paragraph',
        text: `The table below summarises the movement in property, plant and equipment for the year ended 31 December ${fiscalYear}. Depreciation is charged to profit or loss on a systematic basis over the estimated useful lives of the assets.`,
      },
      ...(rows.length > 0
        ? [{
            type: 'table' as const,
            headers: ['Category', 'Cost', 'Accum Depr', 'Carrying Value', 'Additions', 'Disposals', 'Depr Charge'],
            rows: tableRows,
          }]
        : []),
    ],
  };

  return { dataSnapshot, content };
}
```

**Auto-suppress:** Yes — if `rows.length === 0`, set `suppressReason: 'zero_balance'` in dataSnapshot.

---

#### Note 4 — Right-of-Use Assets (Full IFRS only)

**Framework filter:** Only included when `framework === 'full_ifrs'`. Template `isMandatory: false` for IFRS for SMEs documents.

**Data query:**
```sql
SELECT ll.asset_description, ll.lease_start_date, ll.lease_end_date,
       ll.right_of_use_asset_value, ll.accumulated_amortisation,
       ll.lease_liability_current, ll.lease_liability_non_current
FROM lease_liabilities ll
WHERE ll.company_id = ${companyId}
  AND ll.lease_start_date <= ${end}
  AND (ll.lease_end_date IS NULL OR ll.lease_end_date >= ${start})
ORDER BY ll.asset_description
```

**Content:** Intro paragraph (IFRS 16 recognition policy), table showing asset, carrying value, depreciation, liability split. Zero rows → suppress.

---

#### Note 5 — Intangible Assets

**Data query:**
```sql
SELECT ia.asset_name, ia.category,
       SUM(ia.cost) AS total_cost,
       SUM(ia.accumulated_amortisation) AS total_accum_amort,
       SUM(CASE WHEN ia.acquisition_date BETWEEN ${start} AND ${end}
                THEN ia.cost ELSE 0 END) AS additions
FROM intangible_assets ia
WHERE ia.company_id = ${companyId}
  AND (ia.disposal_date IS NULL OR ia.disposal_date >= ${start})
GROUP BY ia.asset_name, ia.category
ORDER BY ia.category
```

**Content:** Paragraph + movement table (Cost / Accum Amort / Carrying Value / Additions). Zero rows → suppress.

---

#### Note 6 — Investment Property

**Data query:**
```sql
SELECT ip.property_address, ip.fair_value, ip.cost,
       ip.rental_income, ip.valuation_date
FROM investment_properties ip
WHERE ip.company_id = ${companyId}
  AND ip.disposal_date IS NULL
ORDER BY ip.property_address
```

**Content:** Paragraph (measurement basis — fair value or cost model from company settings), table. Zero rows → suppress.

---

#### Note 7 — Investments in Associates

**Data query:**
```sql
SELECT inv.investee_name, inv.ownership_percentage,
       inv.carrying_value, inv.share_of_profit_loss,
       inv.dividends_received
FROM investments_associates inv
WHERE inv.company_id = ${companyId}
ORDER BY inv.investee_name
```

**Content:** Paragraph (equity method description) + table. Zero rows → suppress.

---

#### Note 8 — Financial Assets

**Data query:**
```sql
SELECT ga.account_name, ga.account_subtype,
       SUM(gjl.debit_amount - gjl.credit_amount) AS balance
FROM gl_accounts ga
JOIN gl_journal_lines gjl ON gjl.account_id = ga.id
  AND gjl.company_id = ${companyId}
JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
  AND gje.entry_date <= ${end} AND gje.status = 'posted'
WHERE ga.company_id = ${companyId}
  AND ga.account_subtype IN ('investment', 'financial_asset', 'loan_receivable')
GROUP BY ga.account_name, ga.account_subtype
HAVING SUM(gjl.debit_amount - gjl.credit_amount) <> 0
ORDER BY ga.account_subtype, ga.account_name
```

**Content:** Classification table (measured at amortised cost vs FVTPL). Zero rows → suppress.

---

#### Note 9 — Inventories (migrated from `noteInventories` — implement if missing; partial migration)

**Data query:**
```sql
SELECT i.category,
       SUM(i.quantity * i.unit_cost) AS total_cost,
       SUM(i.quantity * i.net_realisable_value) AS total_nrv,
       COUNT(*) AS item_count
FROM inventory_items i
WHERE i.company_id = ${companyId}
  AND i.is_active = true
GROUP BY i.category
ORDER BY i.category
```

**Content:** Paragraph (lower of cost/NRV policy, valuation method from company settings) + category table with write-down column. Zero rows → suppress.

---

#### Note 10 — Trade and Other Receivables (migrated from `noteReceivables`)

**Data query:** Same SQL as existing `noteReceivables` in `disclosureNoteGenerators.ts` — exact same aging buckets. Wrap result as `{ receivables: rows }` in dataSnapshot.

**Content:** Two tables: (1) gross/provision/net summary; (2) aging analysis. Use `NoteContent` block model instead of legacy `NoteTable[]`.

---

### Task B2 — notes11to20.ts

**File:** `src/modules/accounting/services/afs/noteGenerators/notes11to20.ts`

---

#### Note 11 — Cash and Cash Equivalents (migrated from `noteCash`)

**Data query:** Same SQL as existing `noteCash`. Wrap as `{ cashAccounts: rows }`.

**Content:** Paragraph + table (account name, code, balance). No AI narrative per design spec.

---

#### Note 12 — Share Capital and Reserves

**Data query:**
```sql
SELECT ga.account_name, ga.account_code, ga.account_subtype,
       SUM(gjl.credit_amount - gjl.debit_amount) AS balance
FROM gl_accounts ga
JOIN gl_journal_lines gjl ON gjl.account_id = ga.id
  AND gjl.company_id = ${companyId}
JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
  AND gje.entry_date <= ${end} AND gje.status = 'posted'
WHERE ga.company_id = ${companyId}
  AND ga.account_type = 'equity'
GROUP BY ga.account_name, ga.account_code, ga.account_subtype
HAVING SUM(gjl.credit_amount - gjl.debit_amount) <> 0
ORDER BY ga.account_code
```

**Content:** Paragraph (authorised + issued share capital) + table by equity subtype. Never suppress — equity must always be disclosed.

---

#### Note 13 — Borrowings

**Data query:**
```sql
SELECT ga.account_name, ga.account_code, ga.account_subtype,
       SUM(gjl.credit_amount - gjl.debit_amount) AS balance,
       ga.maturity_date, ga.interest_rate
FROM gl_accounts ga
JOIN gl_journal_lines gjl ON gjl.account_id = ga.id
  AND gjl.company_id = ${companyId}
JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
  AND gje.entry_date <= ${end} AND gje.status = 'posted'
WHERE ga.company_id = ${companyId}
  AND ga.account_subtype IN ('bank_loan', 'mortgage', 'overdraft', 'finance_lease', 'shareholder_loan')
GROUP BY ga.account_name, ga.account_code, ga.account_subtype,
         ga.maturity_date, ga.interest_rate
HAVING SUM(gjl.credit_amount - gjl.debit_amount) <> 0
ORDER BY ga.account_subtype
```

**Content:** Paragraph (security, covenants) + table split into current vs non-current. Zero rows → suppress.

---

#### Note 14 — Lease Liabilities (Full IFRS only)

**Framework filter:** `full_ifrs` only (IFRS 16).

**Data query:**
```sql
SELECT ll.asset_description, ll.interest_rate,
       ll.lease_liability_current, ll.lease_liability_non_current,
       ll.interest_expense, ll.principal_payments
FROM lease_liabilities ll
WHERE ll.company_id = ${companyId}
  AND ll.lease_end_date >= ${start}
ORDER BY ll.asset_description
```

**Content:** Maturity analysis table + interest expense disclosure. Zero rows → suppress.

---

#### Note 15 — Provisions

**Data query:**
```sql
SELECT ga.account_name, ga.account_subtype,
       SUM(gjl.credit_amount - gjl.debit_amount) AS balance,
       MIN(gje.entry_date) AS recognised_date
FROM gl_accounts ga
JOIN gl_journal_lines gjl ON gjl.account_id = ga.id
  AND gjl.company_id = ${companyId}
JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
  AND gje.status = 'posted'
WHERE ga.company_id = ${companyId}
  AND ga.account_subtype IN ('provision', 'warranty_provision', 'leave_pay_provision')
GROUP BY ga.account_name, ga.account_subtype
HAVING SUM(gjl.credit_amount - gjl.debit_amount) > 0
ORDER BY ga.account_subtype
```

**Content:** Opening balance / additions / utilisations / closing balance movement table. Zero rows → suppress.

---

#### Note 16 — Trade and Other Payables (migrated from `notePayables`)

**Data query:** Same SQL as existing `notePayables`. Wrap as `{ payables: rows }`.

**Content:** Summary table + aging table. No AI narrative per design spec.

---

#### Note 17 — Income Tax and Deferred Tax (migrated from `noteTaxation`, extended)

**Data query (two queries):**

```sql
-- tax_provision: current year tax expense
SELECT
  SUM(gjl.debit_amount) FILTER (WHERE ga.account_subtype = 'income_tax_expense') AS current_tax,
  SUM(gjl.debit_amount) FILTER (WHERE ga.account_subtype = 'deferred_tax_expense') AS deferred_tax
FROM gl_journal_lines gjl
JOIN gl_accounts ga ON ga.id = gjl.account_id
JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
WHERE gjl.company_id = ${companyId}
  AND gje.entry_date BETWEEN ${start} AND ${end}
  AND gje.status = 'posted'

-- deferred_tax_balance: balance sheet position
SELECT
  SUM(gjl.debit_amount - gjl.credit_amount) FILTER (WHERE ga.account_subtype = 'deferred_tax_asset') AS dta,
  SUM(gjl.credit_amount - gjl.debit_amount) FILTER (WHERE ga.account_subtype = 'deferred_tax_liability') AS dtl
FROM gl_journal_lines gjl
JOIN gl_accounts ga ON ga.id = gjl.account_id
JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
WHERE gjl.company_id = ${companyId}
  AND gje.entry_date <= ${end}
  AND gje.status = 'posted'
```

**Content:** Current tax / deferred tax split table + effective tax rate reconciliation. VAT reconciliation from existing `noteTaxation` query added as second table.

---

#### Note 18 — Revenue Disaggregation (migrated from `noteRevenue`, extended)

**Data query:**
```sql
SELECT ga.account_name, ga.account_code, ga.account_subtype,
       SUM(ABS(gjl.credit_amount - gjl.debit_amount)) AS net_amount
FROM gl_journal_lines gjl
JOIN gl_accounts ga ON ga.id = gjl.account_id
JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
WHERE gjl.company_id = ${companyId}
  AND ga.account_type = 'revenue'
  AND gje.entry_date BETWEEN ${start} AND ${end}
  AND gje.status = 'posted'
GROUP BY ga.account_name, ga.account_code, ga.account_subtype
ORDER BY net_amount DESC
```

**Content:** Disaggregation table by revenue stream + timing (point-in-time vs over time — derived from `account_subtype`). Zero rows → suppress.

---

#### Note 19 — Other Income and Finance Income

**Data query:**
```sql
SELECT ga.account_name, ga.account_subtype,
       SUM(ABS(gjl.credit_amount - gjl.debit_amount)) AS net_amount
FROM gl_journal_lines gjl
JOIN gl_accounts ga ON ga.id = gjl.account_id
JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
WHERE gjl.company_id = ${companyId}
  AND ga.account_subtype IN ('other_income', 'interest_income', 'dividend_income',
                             'rental_income', 'gain_on_disposal')
  AND gje.entry_date BETWEEN ${start} AND ${end}
  AND gje.status = 'posted'
GROUP BY ga.account_name, ga.account_subtype
HAVING SUM(ABS(gjl.credit_amount - gjl.debit_amount)) > 0
ORDER BY ga.account_subtype
```

**Content:** Itemised table. No AI narrative per design spec. Zero rows → suppress.

---

#### Note 20 — Operating Expenses by Nature

**Data query:**
```sql
SELECT ga.account_name, ga.account_subtype,
       SUM(gjl.debit_amount - gjl.credit_amount) AS net_amount
FROM gl_journal_lines gjl
JOIN gl_accounts ga ON ga.id = gjl.account_id
JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
WHERE gjl.company_id = ${companyId}
  AND ga.account_type = 'expense'
  AND ga.account_subtype NOT IN ('income_tax_expense', 'deferred_tax_expense',
                                  'interest_expense', 'finance_cost')
  AND gje.entry_date BETWEEN ${start} AND ${end}
  AND gje.status = 'posted'
GROUP BY ga.account_name, ga.account_subtype
HAVING SUM(gjl.debit_amount - gjl.credit_amount) > 0
ORDER BY net_amount DESC
```

**Content:** Expenses grouped by nature (employee costs, depreciation, admin, other). Total row. No AI narrative. Zero rows → suppress.

---

### Task B3 — notes21to30.ts

**File:** `src/modules/accounting/services/afs/noteGenerators/notes21to30.ts`

---

#### Note 21 — Finance Costs

**Data query:**
```sql
SELECT ga.account_name, ga.account_subtype,
       SUM(gjl.debit_amount - gjl.credit_amount) AS amount
FROM gl_journal_lines gjl
JOIN gl_accounts ga ON ga.id = gjl.account_id
JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
WHERE gjl.company_id = ${companyId}
  AND ga.account_subtype IN ('interest_expense', 'finance_cost', 'bank_charges')
  AND gje.entry_date BETWEEN ${start} AND ${end}
  AND gje.status = 'posted'
GROUP BY ga.account_name, ga.account_subtype
HAVING SUM(gjl.debit_amount - gjl.credit_amount) > 0
ORDER BY ga.account_subtype
```

**Content:** Itemised table. No AI narrative. Zero rows → suppress.

---

#### Note 22 — Employee Benefits

**Data query:**
```sql
SELECT ga.account_subtype,
       SUM(gjl.debit_amount - gjl.credit_amount) AS amount
FROM gl_journal_lines gjl
JOIN gl_accounts ga ON ga.id = gjl.account_id
JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
WHERE gjl.company_id = ${companyId}
  AND ga.account_subtype IN ('salaries', 'wages', 'uif', 'medical_aid',
                             'provident_fund', 'leave_pay', 'bonuses')
  AND gje.entry_date BETWEEN ${start} AND ${end}
  AND gje.status = 'posted'
GROUP BY ga.account_subtype
ORDER BY ga.account_subtype
```

**Content:** Table by benefit type + headcount if available. AI narrative enabled. Zero rows → suppress.

---

#### Note 23 — Related Party Disclosures

**Auto-gen level:** `partial` — queries GL for known related party accounts; narrative requires accountant input.

**Data query:**
```sql
SELECT rp.party_name, rp.relationship_type, rp.director_id,
       SUM(gjl.debit_amount - gjl.credit_amount) AS net_balance
FROM related_parties rp
LEFT JOIN gl_accounts ga ON ga.related_party_id = rp.id
  AND ga.company_id = ${companyId}
LEFT JOIN gl_journal_lines gjl ON gjl.account_id = ga.id
  AND gjl.company_id = ${companyId}
LEFT JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
  AND gje.status = 'posted'
WHERE rp.company_id = ${companyId}
GROUP BY rp.party_name, rp.relationship_type, rp.director_id
ORDER BY rp.relationship_type
```

**Content:** Paragraph (key management, directors, entities under common control) + table of transactions + paragraph placeholder for outstanding balances. AI narrative prompt includes director names from Director's Report.

---

#### Note 24 — Auditor's Remuneration

**Auto-gen level:** `manual` — data cannot be auto-extracted from GL; accountant must enter figure.

**Data query:**
```sql
SELECT ga.account_name,
       SUM(gjl.debit_amount - gjl.credit_amount) AS amount
FROM gl_accounts ga
JOIN gl_journal_lines gjl ON gjl.account_id = ga.id
  AND gjl.company_id = ${companyId}
JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
  AND gje.entry_date BETWEEN ${start} AND ${end}
  AND gje.status = 'posted'
WHERE ga.company_id = ${companyId}
  AND ga.account_subtype = 'audit_fees'
GROUP BY ga.account_name
```

**Content:** If GL has audit fee accounts, show table. If not, show placeholder paragraph instructing accountant to enter manually. No AI narrative per spec.

**Suppress logic:** Never suppress — mandatory disclosure under Companies Act.

---

#### Note 25 — Contingencies and Commitments

**Auto-gen level:** `manual` — no reliable GL source; accountant must declare.

**Data query:** None (empty query map). Content is a placeholder paragraph: *"No contingent liabilities or capital commitments existed at [date]. [Accountant: update if applicable]"*

**Content:** Paragraph block only. AI narrative enabled to assist accountant in drafting. Accountant **must** confirm or replace before sign-off.

---

#### Note 26 — Events After Reporting Date

**Auto-gen level:** `manual`.

**Data query:**
```sql
SELECT gje.description, gje.entry_date, gje.total_amount
FROM gl_journal_entries gje
WHERE gje.company_id = ${companyId}
  AND gje.entry_date > ${end}
  AND gje.entry_date <= NOW()
  AND gje.status = 'posted'
ORDER BY gje.entry_date DESC
LIMIT 20
```

**Content:** If any post-period entries found, list them as candidates. Paragraph placeholder: *"[Accountant: review and describe any adjusting or non-adjusting events]"*. AI narrative enabled.

---

#### Note 27 — Going Concern

**Auto-gen level:** `partial` — financial ratios auto-calculated; conclusion requires accountant input.

**Data queries (three):**

```sql
-- current_ratio
SELECT
  SUM(CASE WHEN ga.account_subtype IN ('bank','cash','trade_receivable','inventory')
           THEN gjl.debit_amount - gjl.credit_amount ELSE 0 END) AS current_assets,
  SUM(CASE WHEN ga.account_subtype IN ('trade_payable','vat_payable','overdraft',
                                        'current_tax_liability')
           THEN gjl.credit_amount - gjl.debit_amount ELSE 0 END) AS current_liabilities
FROM gl_accounts ga
JOIN gl_journal_lines gjl ON gjl.account_id = ga.id AND gjl.company_id = ${companyId}
JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
  AND gje.entry_date <= ${end} AND gje.status = 'posted'
WHERE ga.company_id = ${companyId}

-- net_profit_loss
SELECT SUM(
  CASE WHEN ga.account_type = 'revenue'
       THEN ABS(gjl.credit_amount - gjl.debit_amount) ELSE 0 END
  -
  CASE WHEN ga.account_type = 'expense'
       THEN ABS(gjl.debit_amount - gjl.credit_amount) ELSE 0 END
) AS net_result
FROM gl_accounts ga
JOIN gl_journal_lines gjl ON gjl.account_id = ga.id AND gjl.company_id = ${companyId}
JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
  AND gje.entry_date BETWEEN ${start} AND ${end} AND gje.status = 'posted'
WHERE ga.company_id = ${companyId}
  AND ga.account_type IN ('revenue', 'expense')
```

**Content:** Key ratios paragraph, AI narrative flagging concern if `current_ratio < 1.0` or `net_result < 0`. Compliance checker (Plan 8) will separately flag these. Mandatory — never suppress.

---

#### Note 28 — Segment Information (Full IFRS only)

**Framework filter:** `full_ifrs` only (IFRS 8).

**Data query:**
```sql
SELECT ga.segment_code, ga.segment_name,
       SUM(CASE WHEN ga.account_type = 'revenue'
                THEN ABS(gjl.credit_amount - gjl.debit_amount) ELSE 0 END) AS revenue,
       SUM(CASE WHEN ga.account_type = 'expense'
                THEN ABS(gjl.debit_amount - gjl.credit_amount) ELSE 0 END) AS expenses
FROM gl_accounts ga
JOIN gl_journal_lines gjl ON gjl.account_id = ga.id AND gjl.company_id = ${companyId}
JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
  AND gje.entry_date BETWEEN ${start} AND ${end} AND gje.status = 'posted'
WHERE ga.company_id = ${companyId}
  AND ga.segment_code IS NOT NULL
GROUP BY ga.segment_code, ga.segment_name
ORDER BY revenue DESC
```

**Content:** Segment revenue/expense/profit table. If no segments configured (no `segment_code` on accounts), suppress with `suppressReason: 'not_applicable'`.

---

#### Note 29 — Financial Instruments Risk (Full IFRS only)

**Framework filter:** `full_ifrs` only (IFRS 7).

**Data queries (three):**
- Credit risk: debtor aging + impairment provisioning from Note 10 snapshot
- Liquidity risk: payables and borrowings maturity from Notes 13/16 snapshots
- Market risk: foreign currency exposure from `bank_transactions` where `currency != company.default_currency`

**Content:** Three sub-sections (one heading block per risk category) + tables. AI narrative for each sub-section. Zero balance across all three → suppress.

---

#### Note 30 — Standards Not Yet Effective

**Auto-gen level:** `auto` — vendor-maintained list in `note_templates` table.

**Data query:**
```sql
SELECT nt.standard_reference, nt.title, nt.effective_from, nt.change_summary
FROM note_templates nt
WHERE nt.effective_from > ${end}
  AND nt.framework IN ('ifrs_smes', 'both')
  AND nt.supersedes IS NOT NULL
ORDER BY nt.effective_from ASC
```

**Content:** Paragraph introducing the disclosure requirement + list of forthcoming standards. Never suppress — mandatory.

---

### Task B4 — noteGenerators/index.ts (barrel)

**File:** `src/modules/accounting/services/afs/noteGenerators/index.ts`

Export all 30 generator functions plus a `NOTE_GENERATOR_MAP`:

```typescript
import { generateNote1AccountingPolicies, generateNote2Estimates, generateNote3PPE, /* ... */ } from './notes1to10';
import { generateNote11Cash, /* ... */ } from './notes11to20';
import { generateNote21FinanceCosts, /* ... */ } from './notes21to30';

export type NoteGeneratorFn = (
  companyId: string,
  fiscalYear: number,
  framework: ReportingFramework,
) => Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }>;

export const NOTE_GENERATOR_MAP: Partial<Record<SectionType, NoteGeneratorFn>> = {
  note_1:  generateNote1AccountingPolicies,
  note_2:  generateNote2Estimates,
  note_3:  generateNote3PPE,
  // ... note_4 through note_30
};
```

**Acceptance criteria:**
- Every `note_1` through `note_30` key present in map
- TypeScript compiles with zero errors
- Framework-specific notes (4, 14, 28, 29) receive `framework` arg and return early with null content when framework mismatch

---

## Wave B5 — noteEngineService.ts (orchestrator — depends on A1, A2, A3, B1-B4)

**File:** `src/modules/accounting/services/afs/noteEngineService.ts`

**Purpose:** The 4-stage pipeline controller. Fetches the `AfsSection` + its `NoteTemplate`, runs data queries, renders content, persists, then enqueues the AI narrative job.

**Full interface:**

```typescript
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { isZeroBalance } from './noteDataQueryService';
import { NOTE_GENERATOR_MAP } from './noteGenerators';
import type { SectionType, NoteContent, ReportingFramework } from './afsTypes';
import type { DbRow } from '@/types/db';

export async function generateSection(
  companyId: string,
  documentId: string,
  sectionId: string,
  fiscalYear: number,
  framework: ReportingFramework,
): Promise<void>

export async function generateAllSections(
  companyId: string,
  documentId: string,
  fiscalYear: number,
  framework: ReportingFramework,
): Promise<void>
```

**4-stage pipeline for `generateSection`:**

```
Stage 1 — Fetch section + template
  SELECT afs_sections + note_templates WHERE sectionId + company_id = companyId

Stage 2 — Run note generator
  const generator = NOTE_GENERATOR_MAP[sectionType]
  if (!generator) throw new Error(`No generator for ${sectionType}`)
  const { dataSnapshot, content } = await generator(companyId, fiscalYear, framework)

Stage 3 — Auto-suppress check
  if (isZeroBalance(dataSnapshot) && !template.isMandatory) {
    UPDATE afs_sections SET
      data_snapshot = { suppressReason: 'zero_balance', ...dataSnapshot },
      status = 'pending',
      updated_at = NOW()
    WHERE id = sectionId AND document_id = documentId
    return  // do not proceed to AI stage
  }

Stage 4 — Persist rendered content
  UPDATE afs_sections SET
    data_snapshot = dataSnapshot,
    content = content,
    status = 'auto_generated',
    updated_at = NOW()
  WHERE id = sectionId AND document_id = documentId

Stage 5 — Enqueue AI narrative (if template has aiPromptTemplate)
  INSERT INTO afs_generation_log (document_id, section_id, job_type, status)
  VALUES (documentId, sectionId, 'ai_narrative', 'queued')
  ON CONFLICT DO NOTHING
```

**`generateAllSections` implementation:**

```typescript
export async function generateAllSections(
  companyId: string,
  documentId: string,
  fiscalYear: number,
  framework: ReportingFramework,
): Promise<void> {
  const sections = await sql`
    SELECT id, section_type FROM afs_sections
    WHERE document_id = ${documentId}
      AND document_id IN (
        SELECT id FROM afs_documents WHERE id = ${documentId} AND company_id = ${companyId}
      )
    ORDER BY sort_order ASC
  ` as DbRow[];

  await Promise.all(
    sections.map(s =>
      generateSection(companyId, documentId, s.id as string, fiscalYear, framework)
    )
  );
}
```

**Error handling:**
- Each individual section failure is caught and logged; does not abort other sections
- Log `log.error` with `{ companyId, documentId, sectionId, error: err.message }`
- Re-throw only in `generateSection` (let caller decide); swallow in `generateAllSections` per-section but log and continue

**Acceptance criteria:**
- `generateAllSections` runs all sections concurrently with `Promise.all`
- Zero-balance mandatory notes are NOT suppressed
- Zero-balance non-mandatory notes set `status = 'pending'` + `suppressReason = 'zero_balance'`
- AI job enqueued only when `template.aiPromptTemplate` is non-null
- Company_id verified by subquery on `afs_documents` — no cross-tenant data

---

## Wave C — API Routes (parallel, all depend on Wave B5)

### Task C1 — Regenerate section

**File:** `pages/api/accounting/afs/[documentId]/sections/[sectionId]/regenerate.ts`

**Route:** `POST /api/accounting/afs/[documentId]/sections/[sectionId]/regenerate`

**Handler:**

```typescript
import { withCompany } from '@/lib/withCompany';
import { withErrorHandler } from '@/lib/withErrorHandler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { generateSection } from '@/modules/accounting/services/afs/noteEngineService';
import type { NextApiRequest, NextApiResponse } from 'next';

async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') return apiResponse.badRequest(res, 'Method not allowed');

  const { documentId, sectionId } = req.query as { documentId: string; sectionId: string };
  const { companyId, fiscalYear, framework } = req.body as {
    companyId: string;
    fiscalYear: number;
    framework: ReportingFramework;
  };

  log.info('Regenerating AFS section', { documentId, sectionId }, 'afs/regenerate');

  await generateSection(companyId, documentId, sectionId, fiscalYear, framework);

  return apiResponse.success(res, { regenerated: true });
}

export default withCompany(withErrorHandler(handler as any));
```

**Validation:**
- `fiscalYear` must be a number between 2000 and current year + 1
- `framework` must be `'ifrs_smes'` or `'full_ifrs'`
- Section must belong to document which must belong to `company_id` (enforced by service)

---

### Task C2 — AI narrative (generate + accept)

**File:** `pages/api/accounting/afs/[documentId]/sections/[sectionId]/ai-narrative.ts`

**Routes:**
- `POST` — run AI narrative generation for this section
- `PUT` — accept the AI narrative (merge into `overrides`)

**POST handler:**
1. Fetch `afs_sections.content` + `note_templates.ai_prompt_template` for this section
2. If `aiPromptTemplate` is null → `apiResponse.badRequest(res, 'No AI prompt template for this note')`
3. Fetch company name from `companies` table
4. Call `generateNoteNarrative(sectionType, content, aiPromptTemplate, companyContext)`
5. UPDATE `afs_sections SET ai_narrative = result, status = 'ai_enhanced', updated_at = NOW()` WHERE `id = sectionId AND document_id IN (SELECT id FROM afs_documents WHERE company_id = ${companyId})`
6. Return `apiResponse.success(res, { aiNarrative: result })`

**PUT handler (accept):**
1. Fetch current `ai_narrative` from section
2. If null → `apiResponse.badRequest(res, 'No AI narrative to accept')`
3. Merge AI narrative as a paragraph block at the end of `content.blocks`
4. UPDATE `afs_sections SET ai_narrative_accepted = true, overrides = merged_content, updated_at = NOW()`
5. Return `apiResponse.success(res, { accepted: true })`

**Acceptance criteria:**
- POST generates and persists `ai_narrative`; sets status to `ai_enhanced`
- PUT accepts narrative into `overrides`, sets `ai_narrative_accepted = true`
- Neither mutates `data_snapshot` (immutable after generation)
- All DB writes scoped by `company_id` subquery

---

### Task C3 — Suppress note

**File:** `pages/api/accounting/afs/[documentId]/sections/[sectionId]/suppress.ts`

**Route:** `POST /api/accounting/afs/[documentId]/sections/[sectionId]/suppress`

**Body:** `{ suppress: boolean; reason: string }`

**Suppress (suppress=true):**
```sql
UPDATE afs_sections
SET data_snapshot = jsonb_set(
      COALESCE(data_snapshot, '{}'::jsonb),
      '{suppressReason}',
      ${JSON.stringify(reason)}::jsonb
    ),
    status = 'pending',
    updated_at = NOW()
WHERE id = ${sectionId}
  AND document_id IN (
    SELECT id FROM afs_documents WHERE id = ${documentId} AND company_id = ${companyId}
  )
```

**Unsuppress (suppress=false):**
```sql
UPDATE afs_sections
SET data_snapshot = data_snapshot - 'suppressReason',
    status = 'pending',
    updated_at = NOW()
WHERE id = ${sectionId}
  AND document_id IN (
    SELECT id FROM afs_documents WHERE id = ${documentId} AND company_id = ${companyId}
  )
```

**Validation:**
- `reason` required and non-empty when `suppress=true`
- Cannot suppress a section with `status = 'signed_off'` → `apiResponse.badRequest`

---

### Task C4 — Reorder sections

**File:** `pages/api/accounting/afs/[documentId]/sections/reorder.ts`

**Route:** `PUT /api/accounting/afs/[documentId]/sections/reorder`

**Body:** `{ reorder: Array<{ sectionId: string; newSortOrder: number }> }`

**Handler:**
1. Validate all `sectionId` values belong to `documentId` which belongs to `company_id`
2. Run all updates in a single transaction-equivalent `Promise.all` (Neon does not support interactive transactions over HTTP — run as fast batch):

```sql
UPDATE afs_sections
SET sort_order = ${newSortOrder}, updated_at = NOW()
WHERE id = ${sectionId}
  AND document_id = ${documentId}
  AND document_id IN (
    SELECT id FROM afs_documents WHERE id = ${documentId} AND company_id = ${companyId}
  )
```

3. Return updated section order: `apiResponse.success(res, { reordered: reorder.length })`

**Validation:**
- Array must be non-empty
- `newSortOrder` must be a positive integer
- No duplicate `newSortOrder` values in the batch (return 400 if duplicates detected)
- Maximum 50 sections per reorder batch

---

## Wave D — Tests

### Task D1 — noteEngineService.test.ts

**File:** `tests/unit/services/afs/noteEngineService.test.ts`

**Mocks:**
```typescript
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/modules/accounting/services/afs/noteGenerators', () => ({
  NOTE_GENERATOR_MAP: {
    note_3: vi.fn(),
  },
}));
```

**Test cases:**

| Test | Description |
|------|-------------|
| `generateSection — happy path` | Generator returns data, content persisted, status set to `auto_generated` |
| `generateSection — zero balance non-mandatory` | Generator returns empty snapshot, status set to `pending`, suppressReason written |
| `generateSection — zero balance mandatory` | Generator returns empty snapshot BUT `is_mandatory=true`, content still persisted normally |
| `generateSection — no generator registered` | Throws `No generator for sectionType` |
| `generateSection — AI job enqueued` | When template has `ai_prompt_template`, inserts row into `afs_generation_log` |
| `generateAllSections — runs all in parallel` | Verifies `Promise.all` behaviour by stubbing 3 sections and confirming all ran |
| `generateAllSections — continues on partial failure` | One generator throws; others still persist; error logged |

---

### Task D2 — noteRendererService.test.ts

**File:** `tests/unit/services/afs/noteRendererService.test.ts`

**Test cases:**

| Test | Description |
|------|-------------|
| `renderNoteContent — produces paragraph block from intro` | `contentSchema.intro` → first block is `{ type: 'paragraph', text: intro }` |
| `renderNoteContent — produces table block from non-empty queryKey` | Single row snapshot → table block with correct headers and formatted values |
| `renderNoteContent — omits table for empty query result` | Zero rows → no table block in output |
| `renderNoteContent — appends totals row when totalRow=true` | Numeric columns summed correctly |
| `renderNoteContent — heading block rendered` | `contentSchema.sections[].heading` → `{ type: 'heading', level: 3 }` |
| `renderNoteContent — numberColumns formatted` | Columns in `numberColumns` get `fmt()` applied; others are stringified as-is |
| `renderNoteContent — does not throw on empty snapshot` | Returns `{ title, blocks: [paragraph] }` |

---

### Task D3 — notes1to10.test.ts

**File:** `tests/unit/services/afs/noteGenerators/notes1to10.test.ts`

**Mocks:**
```typescript
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
```

**Test cases per note:**

| Note | Tests |
|------|-------|
| Note 1 (Accounting Policies) | Returns paragraph block; uses company `depreciation_method` and `default_currency` |
| Note 3 (PPE) | Returns table block with correct column headers; total row appended; carrying value computed as cost minus accumulated depreciation; empty rows → zero-balance snapshot |
| Note 3 (PPE) — zero balance | `rows.length === 0` → `dataSnapshot.ppe = []`; content has only paragraph block |
| Note 10 (Receivables) | Aging table present; gross = sum of all buckets |

**Pattern (follows `balanceSheetService.test.ts` style):**
```typescript
const COMPANY_ID = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c';
const FISCAL_YEAR = 2025;

describe('generateNote3PPE', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns table with carrying values when fixed_assets rows exist', async () => {
    (sql as unknown as MockedFunction<...>).mockResolvedValueOnce([
      { category: 'Vehicles', total_cost: 100000, total_accum_dep: 40000,
        additions: 0, disposals: 0, dep_charge: 20000 },
    ]);

    const { dataSnapshot, content } = await generateNote3PPE(COMPANY_ID, FISCAL_YEAR);

    expect(dataSnapshot.ppe).toHaveLength(1);
    const tableBlock = content.blocks.find(b => b.type === 'table');
    expect(tableBlock).toBeDefined();
    expect(tableBlock!.rows[0]![3]).toBe('60,000.00'); // carrying value
  });
});
```

---

## Migration Strategy — Legacy disclosureNoteGenerators.ts

The 7 generators in `disclosureNoteGenerators.ts` are migrated into the new engine as follows:

| Legacy function | Migrated to | Notes |
|-----------------|-------------|-------|
| `noteAccountingPolicies` | `generateNote1AccountingPolicies` in `notes1to10.ts` | Converted to `NoteContent` block model |
| `notePPE` | `generateNote3PPE` in `notes1to10.ts` | Extended with fiscal range additions/disposals |
| `noteReceivables` | `generateNote10Receivables` in `notes1to10.ts` | Same SQL, new block model |
| `notePayables` | `generateNote16Payables` in `notes11to20.ts` | Same SQL, new block model |
| `noteRevenue` | `generateNote18Revenue` in `notes11to20.ts` | Extended with disaggregation |
| `noteCash` | `generateNote11Cash` in `notes11to20.ts` | Same SQL, new block model |
| `noteTaxation` | `generateNote17Taxation` in `notes11to20.ts` | Extended with deferred tax |

**Do NOT delete `disclosureNoteGenerators.ts` or `disclosureNoteService.ts` in this plan.** They serve the existing `/api/accounting/disclosure-notes` endpoint. Deprecation happens in a future plan once the AFS UI is live.

---

## Acceptance Criteria (Plan-Level)

All of the following must be true before this plan is marked complete:

- [ ] `bun run test:unit` passes all tests in `tests/unit/services/afs/`
- [ ] `bunx tsc --noEmit` returns zero errors
- [ ] All 8 new service files are ≤300 lines each (split further if needed)
- [ ] All 4 new API route files are ≤300 lines each
- [ ] Every DB query in every file includes `company_id` scope
- [ ] No `console.log` anywhere — `log` from `@/lib/logger` only
- [ ] No empty `catch` blocks
- [ ] `isZeroBalance` suppresses non-mandatory notes; never suppresses mandatory ones
- [ ] AI narrative stored in `ai_narrative` column, never auto-merged into `content`
- [ ] Note 4 (ROU Assets), Note 14 (Lease Liabilities), Note 28 (Segments), Note 29 (Fin Instruments Risk) excluded from IFRS for SMEs documents
- [ ] Reorder API rejects duplicate `newSortOrder` values with 400
- [ ] Suppress API rejects suppression of `signed_off` sections with 400
- [ ] `generateAllSections` continues after individual section failures (logs + continues)

---

## Definition of Done

1. All wave tasks have green checkboxes
2. `bun run test:unit` green (all AFS tests)
3. `bunx tsc --noEmit` zero errors
4. Manual smoke test: create AFS document via Plan 1, call `POST /api/accounting/afs/{docId}/generate`, verify all 30 section records created in `afs_sections`, verify zero-balance notes suppressed, verify AI job rows in `afs_generation_log`
5. Hein sign-off

---

*Plan written: 2026-04-16 | Spec: Section 2 of `docs/superpowers/specs/2026-04-16-financial-reporting-afs-design.md` | Prerequisite: Plan 1 (Document Engine Foundation)*
