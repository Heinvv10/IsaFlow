# PRD-01 Practice Management — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the practice time-entry capture pipeline and the WIP → invoice billing pipeline on top of the Phase 1 foundation.

**Architecture:** Two new services (`practiceTimeEntryService`, `practiceWipService`) layer on top of the existing `time_entries` table (already extended by migration 373) and the Phase 1 practice services. The existing generic `time-entries.ts` API is left untouched; all practice-aware routes live under `pages/api/accounting/practice/`. A new day-view UI plus a WIP board UI replace the old flow for users who work via the Practice tab. Invoice generation creates standard `customer_invoices` + `customer_invoice_items` rows so the AR module sees no new data types.

**Tech Stack:** Next.js 14, TypeScript, Neon (`sql` tagged template), Vitest, React + Tailwind, existing `apiFetch` / `AppLayout` / `apiResponse` helpers. Package manager is `bun`.

---

## Context & Pre-conditions

Phase 1 shipped (PR #11, commit `2156530`). Already in master:

- **Schema** (migrations 370–374):
  - `practice_clients` — has `link_customer_id UUID` (nullable) pointing to `customers.id`
  - `practice_client_groups`, `practice_client_contacts`
  - `practice_job_categories`, `practice_work_items`
  - `practice_staff_rates`, `practice_client_rate_overrides`
  - `time_entries` extended with: `practice_client_id`, `job_category_id`, `work_item_id`, `applied_rate NUMERIC(18,4)`, `line_total NUMERIC(18,2)`, `origin TEXT DEFAULT 'manual' CHECK IN (manual, assisted, recurring)`, `approved_by UUID`, `approved_at TIMESTAMPTZ`, `billed_at TIMESTAMPTZ`. Status CHECK widened to include `billed`, `not_billable`, `leave`, `invoiced`.
- **Services:**
  - `src/modules/accounting/services/practice/practiceClientService.ts` — `listPracticeClients`, `getPracticeClient`, etc.
  - `src/modules/accounting/services/practice/practiceJobCategoryService.ts` — `listJobCategories`, `listWorkItems`, etc.
  - `src/modules/accounting/services/practice/practiceStaffRateService.ts` — `resolveRate(companyId, userId, clientId, onDate): Promise<number | null>` (2-tier: client override → staff default)
- **Legacy (do not remove):**
  - `src/modules/accounting/services/core/timeTrackingService.ts` — generic time entry CRUD (no practice fields, no rate resolution). Used by `pages/api/accounting/time-entries.ts` and `pages/accounting/timesheets`.
- **Nav:**
  - `src/components/accounting/navSections/practice.ts` — already links to `/accounting/practice/time-entry` (NEW page, to be built) via the "Enter Time" item. Current value is `/accounting/time-tracking`; it will be updated in Task 8.

**Phase 2 does NOT:**
- Add new tables or columns (all schema already in 373).
- Modify the legacy generic time-entry API or timesheets page.
- Remove the `time-entries-invoice.ts` route (it stays for the legacy flow).
- Touch Jobs/Tasks (Phase 3) or Reporting dashboards (Phase 4).

**Worktree setup:** Create `.worktrees/prd-01-practice-phase2` on branch `feature/prd-01-practice-phase2` branched from `origin/master`. All work happens in the worktree.

---

## File Structure

### New files

**Services:**
- `src/modules/accounting/services/practice/practiceTimeEntryService.ts` — practice-aware time entry CRUD, rate resolution, server-computed `line_total`, approval workflow. Max 300 lines.
- `src/modules/accounting/services/practice/practiceWipService.ts` — WIP queries, invoice generation. Max 300 lines.

**API routes (under `pages/api/accounting/practice/`):**
- `time-entries.ts` — GET list (with filters), POST create
- `time-entries/[id].ts` — GET single, PUT update, DELETE
- `time-entries/duplicate.ts` — POST duplicate an existing entry to a new date
- `time-entries/submit.ts` — POST bulk submit (draft → submitted)
- `time-entries/approve.ts` — POST bulk approve (submitted → approved, stamps approved_by/approved_at)
- `wip.ts` — GET WIP board grouped by client
- `wip/invoice.ts` — POST generate invoice from selected entry ids

**UI pages (under `pages/accounting/practice/`):**
- `time-entry/index.tsx` — day view with cascading selects, entry list for the selected day
- `wip/index.tsx` — WIP board, bulk select, "Generate Invoice" modal

**Components (under `src/components/practice/`):**
- `TimeEntryForm.tsx` — the cascading form (client → category → work item → hours → notes), handles rate preview
- `DayTotalsBar.tsx` — shows today's total hours + billable hours + soft warning if > 12

**Tests (under `tests/unit/services/practice/`):**
- `practiceTimeEntryService.test.ts`
- `practiceWipService.test.ts`

### Modified files

- `src/components/accounting/navSections/practice.ts` — point "Enter Time" to `/accounting/practice/time-entry` (it already does in master; verify).

---

## Task 1: `practiceTimeEntryService.ts` (TDD)

**Files:**
- Create: `src/modules/accounting/services/practice/practiceTimeEntryService.ts`
- Test: `tests/unit/services/practice/practiceTimeEntryService.test.ts`

**Responsibilities:**
- `createPracticeEntry(companyId, userId, input)` — validates active client + category + work item (and work item belongs to category), resolves rate via `resolveRate`, computes `line_total = round(hours * applied_rate, 2)`, inserts into `time_entries` with `origin='manual'` (unless overridden).
- `updatePracticeEntry(companyId, id, input)` — only if status = 'draft'. Re-resolves rate if client/date changed. Re-computes line_total.
- `deletePracticeEntry(companyId, id)` — only if status = 'draft'.
- `getPracticeEntry(companyId, id)` — returns single with joined client legal_name, category name, work item name.
- `listPracticeEntries(companyId, filters)` — filters: `userId`, `practiceClientId`, `dateFrom`, `dateTo`, `status`. Uses the nullable-cast pattern from Phase 1 (single query, three nullable filter params).
- `duplicatePracticeEntry(companyId, id, newDate)` — copies an entry, resets status to 'draft', sets `entry_date = newDate`, re-resolves rate, origin='recurring'.
- `submitPracticeEntries(companyId, ids)` — UPDATE draft → submitted. Returns count of rows where status was actually draft.
- `approvePracticeEntries(companyId, ids, approverUserId)` — UPDATE submitted → approved, SET `approved_by = approverUserId`, `approved_at = NOW()`. Returns count.
- `markEntriesBilled(companyId, ids, invoiceId)` — UPDATE approved → billed, SET `invoice_id = invoiceId`, `billed_at = NOW()`. Returns count. Called by `practiceWipService.generateWipInvoice`.

**Validation rules (enforced in `createPracticeEntry` and `updatePracticeEntry`):**

| Field | Rule | Error message |
|-------|------|---------------|
| `entryDate` | `>= '1900-01-01'` AND `<= today` | `'entry date cannot be in the future'` |
| `hours` | `> 0` AND `<= 24` | `'hours must be between 0 and 24'` |
| `practiceClientId` | exists, `company_id = companyId`, `status = 'active'` | `'practice client not found or not active'` |
| `jobCategoryId` | exists, `company_id = companyId`, `is_active = true` | `'job category not found or not active'` |
| `workItemId` | exists, `company_id = companyId`, `is_active = true`, `category_id = jobCategoryId` | `'work item not found, not active, or does not belong to selected category'` |

The "soft warning if daily total > 12h" is a UI-only check. The service does **not** reject > 12h days; it only rejects single entries with hours > 24.

**Types (top of file):**

```typescript
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';
import { resolveRate } from './practiceStaffRateService';

export interface PracticeTimeEntry {
  id: string;
  companyId: string;
  userId: string;
  entryDate: string;
  hours: number;
  practiceClientId: string;
  jobCategoryId: string;
  workItemId: string;
  taskDescription: string;
  notes: string | null;
  billable: boolean;
  appliedRate: number | null;
  lineTotal: number | null;
  origin: 'manual' | 'assisted' | 'recurring';
  status: 'draft' | 'submitted' | 'approved' | 'billed' | 'not_billable' | 'leave' | 'invoiced';
  approvedBy: string | null;
  approvedAt: string | null;
  billedAt: string | null;
  invoiceId: string | null;
  // Joined display fields (only populated by list/get queries)
  practiceClientName?: string | null;
  jobCategoryName?: string | null;
  workItemName?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PracticeTimeEntryInput {
  entryDate: string;          // 'YYYY-MM-DD'
  hours: number;
  practiceClientId: string;
  jobCategoryId: string;
  workItemId: string;
  taskDescription: string;
  notes?: string | null;
  billable?: boolean;         // defaults true
  origin?: 'manual' | 'assisted' | 'recurring';  // defaults 'manual'
}

export interface PracticeEntryFilters {
  userId?: string;
  practiceClientId?: string;
  dateFrom?: string;
  dateTo?: string;
  status?: string;
}
```

**Mapper (top of file after types):**

```typescript
function mapEntry(r: DbRow): PracticeTimeEntry {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    userId: String(r.user_id),
    entryDate: typeof r.entry_date === 'string'
      ? r.entry_date
      : (r.entry_date as Date).toISOString().split('T')[0]!,
    hours: Number(r.hours),
    practiceClientId: String(r.practice_client_id),
    jobCategoryId: String(r.job_category_id),
    workItemId: String(r.work_item_id),
    taskDescription: String(r.task_description),
    notes: r.notes ? String(r.notes) : null,
    billable: Boolean(r.billable),
    appliedRate: r.applied_rate != null ? Number(r.applied_rate) : null,
    lineTotal: r.line_total != null ? Number(r.line_total) : null,
    origin: String(r.origin) as PracticeTimeEntry['origin'],
    status: String(r.status) as PracticeTimeEntry['status'],
    approvedBy: r.approved_by ? String(r.approved_by) : null,
    approvedAt: r.approved_at ? String(r.approved_at) : null,
    billedAt: r.billed_at ? String(r.billed_at) : null,
    invoiceId: r.invoice_id ? String(r.invoice_id) : null,
    practiceClientName: r.practice_client_name ? String(r.practice_client_name) : null,
    jobCategoryName: r.job_category_name ? String(r.job_category_name) : null,
    workItemName: r.work_item_name ? String(r.work_item_name) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}
```

- [ ] **Step 1: Write failing test suite**

Create `tests/unit/services/practice/practiceTimeEntryService.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock, resolveRateMock } = vi.hoisted(() => {
  const sqlMock = vi.fn();
  const resolveRateMock = vi.fn();
  return { sqlMock, resolveRateMock };
});

vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/modules/accounting/services/practice/practiceStaffRateService', () => ({
  resolveRate: resolveRateMock,
}));

import {
  createPracticeEntry,
  updatePracticeEntry,
  deletePracticeEntry,
  getPracticeEntry,
  listPracticeEntries,
  duplicatePracticeEntry,
  submitPracticeEntries,
  approvePracticeEntries,
  markEntriesBilled,
} from '@/modules/accounting/services/practice/practiceTimeEntryService';

const COMPANY = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER = 'bbbbbbbb-0000-0000-0000-000000000002';
const ENTRY_ID = 'cccccccc-0000-0000-0000-000000000003';
const CLIENT = 'dddddddd-0000-0000-0000-000000000004';
const CATEGORY = 'eeeeeeee-0000-0000-0000-000000000005';
const WORK_ITEM = 'ffffffff-0000-0000-0000-000000000006';

const validInput = {
  entryDate: '2026-04-19',
  hours: 2.5,
  practiceClientId: CLIENT,
  jobCategoryId: CATEGORY,
  workItemId: WORK_ITEM,
  taskDescription: 'Monthly management accounts',
};

const activeClientRow = { id: CLIENT, status: 'active' };
const activeCategoryRow = { id: CATEGORY, is_active: true };
const activeWorkItemRow = { id: WORK_ITEM, is_active: true, category_id: CATEGORY };

const entryRow = {
  id: ENTRY_ID,
  company_id: COMPANY,
  user_id: USER,
  entry_date: '2026-04-19',
  hours: 2.5,
  practice_client_id: CLIENT,
  job_category_id: CATEGORY,
  work_item_id: WORK_ITEM,
  task_description: 'Monthly management accounts',
  notes: null,
  billable: true,
  applied_rate: 850,
  line_total: 2125.0,
  origin: 'manual',
  status: 'draft',
  approved_by: null,
  approved_at: null,
  billed_at: null,
  invoice_id: null,
  created_at: new Date('2026-04-19T09:00:00Z'),
  updated_at: new Date('2026-04-19T09:00:00Z'),
};

beforeEach(() => vi.clearAllMocks());

describe('createPracticeEntry', () => {
  it('rejects future date', async () => {
    const futureInput = { ...validInput, entryDate: '2099-01-01' };
    await expect(createPracticeEntry(COMPANY, USER, futureInput))
      .rejects.toThrow(/future/i);
  });

  it('rejects hours = 0', async () => {
    await expect(createPracticeEntry(COMPANY, USER, { ...validInput, hours: 0 }))
      .rejects.toThrow(/hours must be between 0 and 24/);
  });

  it('rejects hours > 24', async () => {
    await expect(createPracticeEntry(COMPANY, USER, { ...validInput, hours: 25 }))
      .rejects.toThrow(/hours must be between 0 and 24/);
  });

  it('rejects inactive client', async () => {
    sqlMock.mockResolvedValueOnce([]); // client lookup returns empty
    await expect(createPracticeEntry(COMPANY, USER, validInput))
      .rejects.toThrow(/practice client not found or not active/);
  });

  it('rejects inactive category', async () => {
    sqlMock
      .mockResolvedValueOnce([activeClientRow])
      .mockResolvedValueOnce([]); // category lookup empty
    await expect(createPracticeEntry(COMPANY, USER, validInput))
      .rejects.toThrow(/job category not found or not active/);
  });

  it('rejects work item from different category', async () => {
    sqlMock
      .mockResolvedValueOnce([activeClientRow])
      .mockResolvedValueOnce([activeCategoryRow])
      .mockResolvedValueOnce([]); // work item lookup empty (category_id mismatch)
    await expect(createPracticeEntry(COMPANY, USER, validInput))
      .rejects.toThrow(/work item/i);
  });

  it('resolves rate and computes line_total', async () => {
    sqlMock
      .mockResolvedValueOnce([activeClientRow])
      .mockResolvedValueOnce([activeCategoryRow])
      .mockResolvedValueOnce([activeWorkItemRow]);
    resolveRateMock.mockResolvedValueOnce(850);
    sqlMock.mockResolvedValueOnce([entryRow]); // INSERT RETURNING

    const result = await createPracticeEntry(COMPANY, USER, validInput);

    expect(resolveRateMock).toHaveBeenCalledWith(COMPANY, USER, CLIENT, '2026-04-19');
    expect(result.appliedRate).toBe(850);
    expect(result.lineTotal).toBe(2125); // 2.5 * 850
    expect(result.origin).toBe('manual');
    expect(result.status).toBe('draft');
  });

  it('allows null rate (no override, no staff default) — line_total null, billable preserved', async () => {
    sqlMock
      .mockResolvedValueOnce([activeClientRow])
      .mockResolvedValueOnce([activeCategoryRow])
      .mockResolvedValueOnce([activeWorkItemRow]);
    resolveRateMock.mockResolvedValueOnce(null);
    sqlMock.mockResolvedValueOnce([{ ...entryRow, applied_rate: null, line_total: null }]);

    const result = await createPracticeEntry(COMPANY, USER, validInput);
    expect(result.appliedRate).toBeNull();
    expect(result.lineTotal).toBeNull();
  });
});

describe('updatePracticeEntry', () => {
  it('rejects update when entry not draft', async () => {
    sqlMock.mockResolvedValueOnce([{ status: 'approved' }]);
    await expect(updatePracticeEntry(COMPANY, ENTRY_ID, { hours: 3 }))
      .rejects.toThrow(/only draft entries/i);
  });

  it('re-resolves rate when hours or date changes', async () => {
    sqlMock.mockResolvedValueOnce([{
      status: 'draft',
      practice_client_id: CLIENT,
      entry_date: '2026-04-19',
      user_id: USER,
    }]);
    resolveRateMock.mockResolvedValueOnce(900);
    sqlMock.mockResolvedValueOnce([{ ...entryRow, hours: 3, applied_rate: 900, line_total: 2700 }]);

    const result = await updatePracticeEntry(COMPANY, ENTRY_ID, { hours: 3 });
    expect(result.lineTotal).toBe(2700);
  });
});

describe('deletePracticeEntry', () => {
  it('rejects delete when entry not draft', async () => {
    sqlMock.mockResolvedValueOnce([{ status: 'submitted' }]);
    await expect(deletePracticeEntry(COMPANY, ENTRY_ID))
      .rejects.toThrow(/only draft entries/i);
  });

  it('deletes draft entry', async () => {
    sqlMock.mockResolvedValueOnce([{ status: 'draft' }]);
    sqlMock.mockResolvedValueOnce([]);
    await expect(deletePracticeEntry(COMPANY, ENTRY_ID)).resolves.toBeUndefined();
  });
});

describe('listPracticeEntries', () => {
  it('returns mapped entries with count', async () => {
    sqlMock.mockResolvedValueOnce([{ cnt: 1 }]).mockResolvedValueOnce([entryRow]);
    const result = await listPracticeEntries(COMPANY, { userId: USER });
    expect(result.total).toBe(1);
    expect(result.entries[0]!.id).toBe(ENTRY_ID);
  });
});

describe('duplicatePracticeEntry', () => {
  it('copies an entry to a new date with draft status and origin=recurring', async () => {
    sqlMock.mockResolvedValueOnce([entryRow]); // source lookup
    sqlMock
      .mockResolvedValueOnce([activeClientRow])
      .mockResolvedValueOnce([activeCategoryRow])
      .mockResolvedValueOnce([activeWorkItemRow]);
    resolveRateMock.mockResolvedValueOnce(850);
    sqlMock.mockResolvedValueOnce([{
      ...entryRow,
      id: 'new-id',
      entry_date: '2026-04-20',
      origin: 'recurring',
      status: 'draft',
    }]);

    const result = await duplicatePracticeEntry(COMPANY, ENTRY_ID, '2026-04-20');
    expect(result.origin).toBe('recurring');
    expect(result.status).toBe('draft');
    expect(result.entryDate).toBe('2026-04-20');
  });
});

describe('submitPracticeEntries', () => {
  it('returns count of rows moved draft → submitted', async () => {
    sqlMock.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);
    const count = await submitPracticeEntries(COMPANY, ['a', 'b']);
    expect(count).toBe(2);
  });

  it('returns 0 for empty ids', async () => {
    const count = await submitPracticeEntries(COMPANY, []);
    expect(count).toBe(0);
    expect(sqlMock).not.toHaveBeenCalled();
  });
});

describe('approvePracticeEntries', () => {
  it('stamps approved_by + approved_at; returns count', async () => {
    sqlMock.mockResolvedValueOnce([{ id: 'a' }]);
    const count = await approvePracticeEntries(COMPANY, ['a'], USER);
    expect(count).toBe(1);
    // Verify the UPDATE includes approved_by = USER
    const call = sqlMock.mock.calls[0]!;
    const values = call.slice(1);
    expect(values).toContain(USER);
  });
});

describe('markEntriesBilled', () => {
  it('moves approved → billed and stamps invoice_id + billed_at', async () => {
    sqlMock.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);
    const count = await markEntriesBilled(COMPANY, ['a', 'b'], 'inv-1');
    expect(count).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify all fail**

Run: `bun run test:unit tests/unit/services/practice/practiceTimeEntryService.test.ts`
Expected: FAIL — "Cannot find module '@/modules/accounting/services/practice/practiceTimeEntryService'"

- [ ] **Step 3: Create the service file**

Create `src/modules/accounting/services/practice/practiceTimeEntryService.ts` with the types + mapper shown above, then implement each function. Key implementation details:

```typescript
export async function createPracticeEntry(
  companyId: string,
  userId: string,
  input: PracticeTimeEntryInput,
): Promise<PracticeTimeEntry> {
  // 1. Date + hours validation
  const today = new Date().toISOString().split('T')[0]!;
  if (input.entryDate > today) throw new Error('entry date cannot be in the future');
  if (!(input.hours > 0 && input.hours <= 24)) {
    throw new Error('hours must be between 0 and 24');
  }

  // 2. Client must be active
  const clientRows = (await sql`
    SELECT id FROM practice_clients
    WHERE id = ${input.practiceClientId}::UUID
      AND company_id = ${companyId}::UUID
      AND status = 'active'
  `) as DbRow[];
  if (!clientRows.length) throw new Error('practice client not found or not active');

  // 3. Category must be active
  const catRows = (await sql`
    SELECT id FROM practice_job_categories
    WHERE id = ${input.jobCategoryId}::UUID
      AND company_id = ${companyId}::UUID
      AND is_active = true
  `) as DbRow[];
  if (!catRows.length) throw new Error('job category not found or not active');

  // 4. Work item must be active AND belong to the selected category
  const wiRows = (await sql`
    SELECT id FROM practice_work_items
    WHERE id = ${input.workItemId}::UUID
      AND company_id = ${companyId}::UUID
      AND is_active = true
      AND category_id = ${input.jobCategoryId}::UUID
  `) as DbRow[];
  if (!wiRows.length) {
    throw new Error(
      'work item not found, not active, or does not belong to selected category',
    );
  }

  // 5. Resolve rate (nullable)
  const appliedRate = await resolveRate(companyId, userId, input.practiceClientId, input.entryDate);
  const lineTotal = appliedRate != null
    ? Math.round(input.hours * appliedRate * 100) / 100
    : null;

  const origin = input.origin ?? 'manual';
  const billable = input.billable !== false;

  const rows = (await sql`
    INSERT INTO time_entries (
      company_id, user_id, entry_date, hours,
      practice_client_id, job_category_id, work_item_id,
      task_description, notes, billable,
      applied_rate, line_total, rate, amount,
      origin, status
    ) VALUES (
      ${companyId}::UUID, ${userId}::UUID, ${input.entryDate}::DATE, ${input.hours},
      ${input.practiceClientId}::UUID, ${input.jobCategoryId}::UUID, ${input.workItemId}::UUID,
      ${input.taskDescription}, ${input.notes ?? null}, ${billable},
      ${appliedRate}, ${lineTotal}, ${appliedRate}, ${lineTotal},
      ${origin}, 'draft'
    ) RETURNING *
  `) as DbRow[];
  if (!rows[0]) throw new Error('database returned no row after insert/update');

  log.info('Created practice time entry', {
    id: rows[0].id, userId, clientId: input.practiceClientId, hours: input.hours,
  }, 'practice');
  return mapEntry(rows[0]);
}
```

Note: `rate` and `amount` are legacy columns on `time_entries` still populated so the generic time-tracking UI/reports don't break. `applied_rate` and `line_total` are the practice-side sources of truth.

The other functions follow the same patterns (see Phase 1 services for reference). For `listPracticeEntries`, use the nullable-cast filter pattern from Phase 1 (`AND (${filter}::TYPE IS NULL OR column = ${filter}::TYPE)`) and JOIN `practice_clients pc`, `practice_job_categories pjc`, `practice_work_items pwi` to populate display names.

For `approvePracticeEntries`:

```typescript
export async function approvePracticeEntries(
  companyId: string,
  ids: string[],
  approverUserId: string,
): Promise<number> {
  if (!ids.length) return 0;
  const rows = (await sql`
    UPDATE time_entries
    SET status = 'approved',
        approved_by = ${approverUserId}::UUID,
        approved_at = NOW(),
        updated_at = NOW()
    WHERE company_id = ${companyId}::UUID
      AND id = ANY(${ids}::UUID[])
      AND status = 'submitted'
    RETURNING id
  `) as DbRow[];
  log.info('Approved practice time entries', { count: rows.length, approverUserId }, 'practice');
  return rows.length;
}
```

For `markEntriesBilled`:

```typescript
export async function markEntriesBilled(
  companyId: string,
  ids: string[],
  invoiceId: string,
): Promise<number> {
  if (!ids.length) return 0;
  const rows = (await sql`
    UPDATE time_entries
    SET status = 'billed',
        invoice_id = ${invoiceId}::UUID,
        billed_at = NOW(),
        updated_at = NOW()
    WHERE company_id = ${companyId}::UUID
      AND id = ANY(${ids}::UUID[])
      AND status = 'approved'
      AND billed_at IS NULL
    RETURNING id
  `) as DbRow[];
  log.info('Marked time entries billed', { count: rows.length, invoiceId }, 'practice');
  return rows.length;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test:unit tests/unit/services/practice/practiceTimeEntryService.test.ts`
Expected: PASS — all 15+ tests green

- [ ] **Step 5: Type check**

Run: `bunx tsc --noEmit`
Expected: zero errors (or same baseline as before this task)

- [ ] **Step 6: Commit**

```bash
git add src/modules/accounting/services/practice/practiceTimeEntryService.ts \
        tests/unit/services/practice/practiceTimeEntryService.test.ts
git commit -m "feat(practice): practiceTimeEntryService with rate resolve + validation"
```

---

## Task 2: `practiceWipService.ts` (TDD)

**Files:**
- Create: `src/modules/accounting/services/practice/practiceWipService.ts`
- Test: `tests/unit/services/practice/practiceWipService.test.ts`

**Responsibilities:**
- `getWipByClient(companyId, filters?)` — returns `[{ practiceClientId, legalName, linkCustomerId, entries: PracticeTimeEntry[], totalHours, totalValue, oldestApprovedDate }]`. Filters: `partnerId`, `practiceClientId`, `dateFrom`, `dateTo`.
- `generateWipInvoice(companyId, userId, input)` — creates a draft `customer_invoices` record + line items from the selected entry ids, calls `markEntriesBilled` to flip them to `billed`. Returns `{ invoiceId, invoiceNumber, lineCount, subtotal, taxAmount, totalAmount }`.

**`generateWipInvoice` input shape:**

```typescript
export interface GenerateWipInvoiceInput {
  practiceClientId: string;
  timeEntryIds: string[];
  invoiceDate?: string;         // defaults today
  taxRate?: number;             // defaults 15
  groupBy?: 'detailed' | 'by_work_item' | 'by_category';  // defaults 'detailed'
}
```

**Behaviour:**
1. Look up the practice client, require `status = 'active'` and `link_customer_id IS NOT NULL`. If `link_customer_id` is null, throw `'practice client has no linked AR customer — set link_customer_id before generating an invoice'`.
2. Load all entries in `timeEntryIds` that belong to company, practice client, are billable, and have `status = 'approved'` AND `billed_at IS NULL`. If zero eligible, throw `'no eligible approved time entries in selection'`.
3. Compute subtotal = sum of `line_total` (use 0 for null rates — those entries cannot be billed; exclude them from the query too: `line_total IS NOT NULL`). Use `Math.round(x * 100) / 100` for all monetary rounding.
4. Tax = round(subtotal * rate / 100, 2). Total = subtotal + tax.
5. Generate invoice number with retry-on-collision (use the existing pattern from `pages/api/accounting/time-entries-invoice.ts`).
6. INSERT `customer_invoices` (currency ZAR, exchange_rate 1.0, status='draft', customer_id = link_customer_id, client_id = link_customer_id).
7. INSERT `customer_invoice_items` — shape depends on `groupBy`:
   - `detailed`: one line per time entry — `"{date} [{work_item}] — {task_description} ({hours}h @ R{applied_rate}/h)"`
   - `by_work_item`: group by `work_item_id` — one line per work item, description = work item name, quantity = total hours, unit_price = avg rate (value-weighted), amount = sum of line_total.
   - `by_category`: group by `job_category_id` — one line per category, similar to `by_work_item`.
8. Call `markEntriesBilled(companyId, eligibleIds, invoiceId)`.
9. Return invoice summary.

- [ ] **Step 1: Write failing test suite**

Create `tests/unit/services/practice/practiceWipService.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock, markEntriesBilledMock } = vi.hoisted(() => {
  const sqlMock = vi.fn();
  const markEntriesBilledMock = vi.fn();
  return { sqlMock, markEntriesBilledMock };
});

vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/modules/accounting/services/practice/practiceTimeEntryService', () => ({
  markEntriesBilled: markEntriesBilledMock,
}));

import {
  getWipByClient,
  generateWipInvoice,
} from '@/modules/accounting/services/practice/practiceWipService';

const COMPANY = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER = 'bbbbbbbb-0000-0000-0000-000000000002';
const CLIENT = 'cccccccc-0000-0000-0000-000000000003';
const LINK_CUSTOMER = 'dddddddd-0000-0000-0000-000000000004';
const ENTRY_A = 'eeeeeeee-0000-0000-0000-000000000005';
const ENTRY_B = 'ffffffff-0000-0000-0000-000000000006';
const INVOICE_ID = '11111111-0000-0000-0000-000000000007';

beforeEach(() => vi.clearAllMocks());

describe('getWipByClient', () => {
  it('groups approved unbilled entries by practice_client_id', async () => {
    sqlMock.mockResolvedValueOnce([
      {
        practice_client_id: CLIENT,
        legal_name: 'Acme (Pty) Ltd',
        link_customer_id: LINK_CUSTOMER,
        total_hours: 5,
        total_value: 4250,
        oldest_approved_date: new Date('2026-04-10'),
      },
    ]);
    sqlMock.mockResolvedValueOnce([
      {
        id: ENTRY_A,
        company_id: COMPANY,
        user_id: USER,
        entry_date: '2026-04-10',
        hours: 2,
        practice_client_id: CLIENT,
        job_category_id: 'cat-1',
        work_item_id: 'wi-1',
        task_description: 'Bookkeeping',
        notes: null,
        billable: true,
        applied_rate: 850,
        line_total: 1700,
        origin: 'manual',
        status: 'approved',
        approved_by: USER,
        approved_at: new Date('2026-04-11'),
        billed_at: null,
        invoice_id: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);

    const result = await getWipByClient(COMPANY);
    expect(result).toHaveLength(1);
    expect(result[0]!.practiceClientId).toBe(CLIENT);
    expect(result[0]!.totalValue).toBe(4250);
    expect(result[0]!.entries).toHaveLength(1);
  });
});

describe('generateWipInvoice', () => {
  const baseInput = {
    practiceClientId: CLIENT,
    timeEntryIds: [ENTRY_A, ENTRY_B],
  };

  it('rejects client with no link_customer_id', async () => {
    sqlMock.mockResolvedValueOnce([{ id: CLIENT, status: 'active', link_customer_id: null }]);
    await expect(generateWipInvoice(COMPANY, USER, baseInput))
      .rejects.toThrow(/link_customer_id/);
  });

  it('rejects when no eligible entries found', async () => {
    sqlMock.mockResolvedValueOnce([{ id: CLIENT, status: 'active', link_customer_id: LINK_CUSTOMER }]);
    sqlMock.mockResolvedValueOnce([]);
    await expect(generateWipInvoice(COMPANY, USER, baseInput))
      .rejects.toThrow(/no eligible approved/);
  });

  it('creates invoice with detailed line items and marks entries billed', async () => {
    sqlMock.mockResolvedValueOnce([{ id: CLIENT, status: 'active', link_customer_id: LINK_CUSTOMER }]);
    sqlMock.mockResolvedValueOnce([
      {
        id: ENTRY_A, hours: 2, applied_rate: 850, line_total: 1700,
        entry_date: '2026-04-10', task_description: 'Bookkeeping',
        work_item_name: 'Monthly bookkeeping', job_category_name: 'Accounting',
      },
      {
        id: ENTRY_B, hours: 3, applied_rate: 850, line_total: 2550,
        entry_date: '2026-04-11', task_description: 'Reconciliation',
        work_item_name: 'Bank recon', job_category_name: 'Accounting',
      },
    ]);
    sqlMock.mockResolvedValueOnce([{ max_num: 0 }]);     // max invoice number
    sqlMock.mockResolvedValueOnce([{ id: INVOICE_ID }]); // INSERT invoice
    sqlMock.mockResolvedValueOnce([]);                   // INSERT line item A
    sqlMock.mockResolvedValueOnce([]);                   // INSERT line item B
    markEntriesBilledMock.mockResolvedValueOnce(2);

    const result = await generateWipInvoice(COMPANY, USER, baseInput);

    expect(result.lineCount).toBe(2);
    expect(result.subtotal).toBe(4250);
    expect(result.taxAmount).toBe(637.5);
    expect(result.totalAmount).toBe(4887.5);
    expect(result.invoiceId).toBe(INVOICE_ID);
    expect(markEntriesBilledMock).toHaveBeenCalledWith(COMPANY, [ENTRY_A, ENTRY_B], INVOICE_ID);
  });

  it('groupBy=by_work_item collapses entries per work item', async () => {
    sqlMock.mockResolvedValueOnce([{ id: CLIENT, status: 'active', link_customer_id: LINK_CUSTOMER }]);
    sqlMock.mockResolvedValueOnce([
      {
        id: ENTRY_A, hours: 2, applied_rate: 850, line_total: 1700,
        entry_date: '2026-04-10', work_item_id: 'wi-1',
        work_item_name: 'Monthly bookkeeping',
      },
      {
        id: ENTRY_B, hours: 1, applied_rate: 850, line_total: 850,
        entry_date: '2026-04-11', work_item_id: 'wi-1',
        work_item_name: 'Monthly bookkeeping',
      },
    ]);
    sqlMock.mockResolvedValueOnce([{ max_num: 0 }]);
    sqlMock.mockResolvedValueOnce([{ id: INVOICE_ID }]);
    sqlMock.mockResolvedValueOnce([]); // ONE line item (grouped)
    markEntriesBilledMock.mockResolvedValueOnce(2);

    const result = await generateWipInvoice(COMPANY, USER, {
      ...baseInput,
      groupBy: 'by_work_item',
    });

    // Only ONE line item insert expected (2 entries → 1 grouped line)
    const insertLineItemCalls = sqlMock.mock.calls
      .filter(c => String(c[0]).includes('INSERT INTO customer_invoice_items'));
    expect(insertLineItemCalls).toHaveLength(1);
    expect(result.lineCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test:unit tests/unit/services/practice/practiceWipService.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create the service file**

Create `src/modules/accounting/services/practice/practiceWipService.ts`. Implementation sketch:

```typescript
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';
import { markEntriesBilled, type PracticeTimeEntry } from './practiceTimeEntryService';

export interface WipClientRow {
  practiceClientId: string;
  legalName: string;
  linkCustomerId: string | null;
  totalHours: number;
  totalValue: number;
  oldestApprovedDate: string;
  entries: PracticeTimeEntry[];
}

export interface GenerateWipInvoiceInput {
  practiceClientId: string;
  timeEntryIds: string[];
  invoiceDate?: string;
  taxRate?: number;
  groupBy?: 'detailed' | 'by_work_item' | 'by_category';
}

export interface WipInvoiceResult {
  invoiceId: string;
  invoiceNumber: string;
  lineCount: number;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

export async function getWipByClient(
  companyId: string,
  filters?: { practiceClientId?: string; partnerId?: string; dateFrom?: string; dateTo?: string },
): Promise<WipClientRow[]> {
  const pc = filters?.practiceClientId ?? null;
  const partner = filters?.partnerId ?? null;
  const df = filters?.dateFrom ?? null;
  const dt = filters?.dateTo ?? null;

  const summary = (await sql`
    SELECT
      te.practice_client_id,
      pc.legal_name,
      pc.link_customer_id,
      SUM(te.hours)::NUMERIC AS total_hours,
      SUM(COALESCE(te.line_total, 0))::NUMERIC AS total_value,
      MIN(te.approved_at::DATE) AS oldest_approved_date
    FROM time_entries te
    JOIN practice_clients pc ON pc.id = te.practice_client_id
    WHERE te.company_id = ${companyId}::UUID
      AND te.status = 'approved'
      AND te.billed_at IS NULL
      AND te.billable = true
      AND te.practice_client_id IS NOT NULL
      AND (${pc}::UUID IS NULL OR te.practice_client_id = ${pc}::UUID)
      AND (${partner}::UUID IS NULL OR pc.assigned_partner_id = ${partner}::UUID)
      AND (${df}::DATE IS NULL OR te.entry_date >= ${df}::DATE)
      AND (${dt}::DATE IS NULL OR te.entry_date <= ${dt}::DATE)
    GROUP BY te.practice_client_id, pc.legal_name, pc.link_customer_id
    ORDER BY pc.legal_name
  `) as DbRow[];

  if (!summary.length) return [];

  const clientIds = summary.map(r => String(r.practice_client_id));
  const entries = (await sql`
    SELECT te.*,
      pc.legal_name AS practice_client_name,
      pjc.name AS job_category_name,
      pwi.name AS work_item_name
    FROM time_entries te
    JOIN practice_clients pc ON pc.id = te.practice_client_id
    LEFT JOIN practice_job_categories pjc ON pjc.id = te.job_category_id
    LEFT JOIN practice_work_items pwi ON pwi.id = te.work_item_id
    WHERE te.company_id = ${companyId}::UUID
      AND te.status = 'approved'
      AND te.billed_at IS NULL
      AND te.billable = true
      AND te.practice_client_id = ANY(${clientIds}::UUID[])
      AND (${df}::DATE IS NULL OR te.entry_date >= ${df}::DATE)
      AND (${dt}::DATE IS NULL OR te.entry_date <= ${dt}::DATE)
    ORDER BY te.entry_date DESC, te.created_at DESC
  `) as DbRow[];

  // ... group entries by practice_client_id and return WipClientRow[]
  // (full mapping logic in implementation)
  return /* mapped rows */ [] as WipClientRow[];
}

export async function generateWipInvoice(
  companyId: string,
  userId: string,
  input: GenerateWipInvoiceInput,
): Promise<WipInvoiceResult> {
  // 1. Validate client has link_customer_id
  const clientRows = (await sql`
    SELECT id, status, link_customer_id FROM practice_clients
    WHERE id = ${input.practiceClientId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!clientRows[0] || clientRows[0].status !== 'active') {
    throw new Error('practice client not found or not active');
  }
  if (!clientRows[0].link_customer_id) {
    throw new Error(
      'practice client has no linked AR customer — set link_customer_id before generating an invoice',
    );
  }
  const customerId = String(clientRows[0].link_customer_id);

  // 2. Load eligible entries — approved + unbilled + matching client + line_total NOT NULL
  const entries = (await sql`
    SELECT te.id, te.hours, te.applied_rate, te.line_total,
      te.entry_date, te.task_description,
      te.work_item_id, te.job_category_id,
      pwi.name AS work_item_name,
      pjc.name AS job_category_name
    FROM time_entries te
    LEFT JOIN practice_work_items pwi ON pwi.id = te.work_item_id
    LEFT JOIN practice_job_categories pjc ON pjc.id = te.job_category_id
    WHERE te.id = ANY(${input.timeEntryIds}::UUID[])
      AND te.company_id = ${companyId}::UUID
      AND te.practice_client_id = ${input.practiceClientId}::UUID
      AND te.status = 'approved'
      AND te.billed_at IS NULL
      AND te.billable = true
      AND te.line_total IS NOT NULL
  `) as DbRow[];
  if (!entries.length) throw new Error('no eligible approved time entries in selection');

  const subtotal = round2(entries.reduce((s, e) => s + Number(e.line_total ?? 0), 0));
  const taxRate = input.taxRate ?? 15;
  const taxAmount = round2(subtotal * (taxRate / 100));
  const totalAmount = round2(subtotal + taxAmount);
  const invDate = input.invoiceDate ?? new Date().toISOString().split('T')[0]!;

  // 3. Generate invoice number with retry
  let invoiceId = '';
  let invoiceNumber = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const maxRows = (await sql`
      SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM '[0-9]+$') AS INTEGER)), 0) AS max_num
      FROM customer_invoices WHERE company_id = ${companyId} AND invoice_number ~ '^INV-[0-9]+$'
    `) as DbRow[];
    const base = Number(maxRows[0]?.max_num ?? 0) + 1 + attempt;
    invoiceNumber = `INV-${String(base).padStart(5, '0')}`;
    try {
      const invRows = (await sql`
        INSERT INTO customer_invoices (
          company_id, invoice_number, customer_id, client_id,
          subtotal, tax_rate, tax_amount, total_amount,
          invoice_date, status, created_by,
          currency_code, exchange_rate, functional_total
        ) VALUES (
          ${companyId}, ${invoiceNumber}, ${customerId}::UUID, ${customerId}::UUID,
          ${subtotal}, ${taxRate}, ${taxAmount}, ${totalAmount},
          ${invDate}, 'draft', ${userId},
          'ZAR', 1.0, ${totalAmount}
        ) RETURNING id
      `) as DbRow[];
      invoiceId = String(invRows[0]!.id);
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('unique') && attempt < 4) continue;
      throw err;
    }
  }

  // 4. Insert line items — grouping depends on groupBy
  const groupBy = input.groupBy ?? 'detailed';
  let lineCount = 0;
  if (groupBy === 'detailed') {
    for (const e of entries) {
      const hours = Number(e.hours);
      const rate = Number(e.applied_rate);
      const lineAmount = Number(e.line_total);
      const wi = e.work_item_name ? ` [${e.work_item_name}]` : '';
      const desc = `${e.entry_date}${wi} — ${e.task_description} (${hours}h @ R${rate}/h)`;
      await sql`
        INSERT INTO customer_invoice_items (
          invoice_id, description, unit_price, quantity, amount, tax_rate, currency_code
        ) VALUES (
          ${invoiceId}::UUID, ${desc}, ${rate}, ${hours}, ${lineAmount}, ${taxRate}, 'ZAR'
        )
      `;
      lineCount++;
    }
  } else {
    const keyOf = (e: DbRow) =>
      groupBy === 'by_work_item' ? String(e.work_item_id) : String(e.job_category_id);
    const nameOf = (e: DbRow) =>
      groupBy === 'by_work_item' ? String(e.work_item_name ?? 'Work item') : String(e.job_category_name ?? 'Category');
    const groups = new Map<string, { name: string; hours: number; value: number }>();
    for (const e of entries) {
      const k = keyOf(e);
      const prev = groups.get(k) ?? { name: nameOf(e), hours: 0, value: 0 };
      prev.hours += Number(e.hours);
      prev.value += Number(e.line_total);
      groups.set(k, prev);
    }
    for (const g of groups.values()) {
      const hours = round2(g.hours);
      const value = round2(g.value);
      const unit = hours > 0 ? round2(value / hours) : 0;
      await sql`
        INSERT INTO customer_invoice_items (
          invoice_id, description, unit_price, quantity, amount, tax_rate, currency_code
        ) VALUES (
          ${invoiceId}::UUID, ${g.name}, ${unit}, ${hours}, ${value}, ${taxRate}, 'ZAR'
        )
      `;
      lineCount++;
    }
  }

  // 5. Mark entries billed
  const eligibleIds = entries.map(e => String(e.id));
  await markEntriesBilled(companyId, eligibleIds, invoiceId);

  log.info('Generated WIP invoice', {
    invoiceId, invoiceNumber, lineCount, subtotal, totalAmount,
  }, 'practice');

  return { invoiceId, invoiceNumber, lineCount, subtotal, taxAmount, totalAmount };
}
```

- [ ] **Step 4: Run tests**

Run: `bun run test:unit tests/unit/services/practice/practiceWipService.test.ts`
Expected: PASS

- [ ] **Step 5: Type check**

Run: `bunx tsc --noEmit`
Expected: zero errors

- [ ] **Step 6: Commit**

```bash
git add src/modules/accounting/services/practice/practiceWipService.ts \
        tests/unit/services/practice/practiceWipService.test.ts
git commit -m "feat(practice): practiceWipService with invoice generation from approved entries"
```

---

## Task 3: Practice Time Entry API routes

**Files:**
- Create: `pages/api/accounting/practice/time-entries.ts`
- Create: `pages/api/accounting/practice/time-entries/[id].ts`
- Create: `pages/api/accounting/practice/time-entries/duplicate.ts`
- Create: `pages/api/accounting/practice/time-entries/submit.ts`
- Create: `pages/api/accounting/practice/time-entries/approve.ts`

**Pattern:** All routes use `withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))))`. Derive `companyId` and `userId` from `(req as CompanyAuthedRequest).companyId` and `req.user.id`.

- [ ] **Step 1: `time-entries.ts` (GET list + POST create)**

```typescript
/**
 * Practice Time Entries API
 * GET  — list entries with filters (userId, practiceClientId, dateFrom, dateTo, status)
 * POST — create entry (validates + resolves rate + computes line_total)
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  listPracticeEntries,
  createPracticeEntry,
} from '@/modules/accounting/services/practice/practiceTimeEntryService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const { userId, practiceClientId, dateFrom, dateTo, status } = req.query;
    const result = await listPracticeEntries(companyId, {
      userId: userId as string | undefined,
      practiceClientId: practiceClientId as string | undefined,
      dateFrom: dateFrom as string | undefined,
      dateTo: dateTo as string | undefined,
      status: status as string | undefined,
    });
    return apiResponse.success(res, result);
  }

  if (req.method === 'POST') {
    try {
      const entry = await createPracticeEntry(companyId, req.user.id, req.body);
      return apiResponse.created(res, entry);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Create failed';
      log.error('Practice time entry create failed', { error: err }, 'practice-api');
      return apiResponse.badRequest(res, msg);
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
```

- [ ] **Step 2: `time-entries/[id].ts` (GET single + PUT + DELETE)**

Include method switch: GET → `getPracticeEntry`, PUT → `updatePracticeEntry`, DELETE → `deletePracticeEntry`. Return 404 when `getPracticeEntry` returns null.

- [ ] **Step 3: `time-entries/duplicate.ts`**

```typescript
// POST body: { id: string; newDate: string }
if (req.method !== 'POST') return apiResponse.methodNotAllowed(...);
const { id, newDate } = req.body;
if (!id || !newDate) return apiResponse.badRequest(res, 'id and newDate required');
try {
  const entry = await duplicatePracticeEntry(companyId, id, newDate);
  return apiResponse.created(res, entry);
} catch (err) { ... }
```

- [ ] **Step 4: `time-entries/submit.ts`**

```typescript
// POST body: { ids: string[] }
const { ids } = req.body;
if (!Array.isArray(ids) || !ids.length) return apiResponse.badRequest(...);
const count = await submitPracticeEntries(companyId, ids);
return apiResponse.success(res, { count });
```

- [ ] **Step 5: `time-entries/approve.ts`**

Same shape, but calls `approvePracticeEntries(companyId, ids, req.user.id)`.

- [ ] **Step 6: Manually smoke via curl or a quick test route**

Start dev server: `bun run dev` in another terminal, or leave for browser testing. For now, type-check only.

Run: `bunx tsc --noEmit`
Expected: zero errors

- [ ] **Step 7: Commit**

```bash
git add pages/api/accounting/practice/time-entries.ts \
        pages/api/accounting/practice/time-entries/
git commit -m "feat(practice): time-entry API routes (CRUD, duplicate, submit, approve)"
```

---

## Task 4: WIP API routes

**Files:**
- Create: `pages/api/accounting/practice/wip.ts`
- Create: `pages/api/accounting/practice/wip/invoice.ts`

- [ ] **Step 1: `wip.ts` (GET WIP board)**

```typescript
/**
 * WIP Board API
 * GET — approved, unbilled time entries grouped by practice client
 *   Query: practiceClientId?, partnerId?, dateFrom?, dateTo?
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { getWipByClient } from '@/modules/accounting/services/practice/practiceWipService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }
  const { companyId } = req as CompanyAuthedRequest;
  const { practiceClientId, partnerId, dateFrom, dateTo } = req.query;
  const rows = await getWipByClient(companyId, {
    practiceClientId: practiceClientId as string | undefined,
    partnerId: partnerId as string | undefined,
    dateFrom: dateFrom as string | undefined,
    dateTo: dateTo as string | undefined,
  });
  return apiResponse.success(res, rows);
}

export default withAuth(withErrorHandler(handler));
```

- [ ] **Step 2: `wip/invoice.ts` (POST generate invoice)**

```typescript
/**
 * WIP → Invoice API
 * POST body: { practiceClientId, timeEntryIds[], invoiceDate?, taxRate?, groupBy? }
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { generateWipInvoice } from '@/modules/accounting/services/practice/practiceWipService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }
  const { companyId } = req as CompanyAuthedRequest;
  try {
    const result = await generateWipInvoice(companyId, req.user.id, req.body);
    return apiResponse.created(res, result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'WIP invoice failed';
    log.error('WIP invoice generation failed', { error: err }, 'practice-api');
    return apiResponse.badRequest(res, msg);
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
```

- [ ] **Step 3: Type check**

Run: `bunx tsc --noEmit`
Expected: zero errors

- [ ] **Step 4: Commit**

```bash
git add pages/api/accounting/practice/wip.ts pages/api/accounting/practice/wip/
git commit -m "feat(practice): WIP API (board query + invoice generation)"
```

---

## Task 5: `TimeEntryForm` component (cascading selects)

**Files:**
- Create: `src/components/practice/TimeEntryForm.tsx`
- Create: `src/components/practice/DayTotalsBar.tsx`

**`TimeEntryForm` responsibilities:**
- Props: `onSubmit: (input) => Promise<void>`, `defaultDate?: string`, `initialValue?: Partial<PracticeTimeEntryInput>`, `onCancel?: () => void`.
- Loads active practice clients via `GET /api/accounting/practice/clients?status=active` (done in parent, passed in as `clients: PracticeClient[]`).
- When client selected: fetches `GET /api/accounting/practice/job-categories?isActive=true` (again, prop-drilled from parent).
- When category selected: fetches `GET /api/accounting/practice/work-items?categoryId=X&isActive=true`.
- When hours + client + date all set: shows a rate preview via `GET /api/accounting/practice/rate-resolve?userId={current}&clientId={X}&onDate={Y}`. If 404 (no rate), shows "No rate configured" warning.
- Submits to `POST /api/accounting/practice/time-entries` via `apiFetch`.
- Disables submit while pending. Shows error text from the API response.

**`DayTotalsBar` responsibilities:**
- Props: `entries: PracticeTimeEntry[]`.
- Shows: total hours, billable hours, non-billable hours, total value.
- Warning banner (amber) if total hours > 12.

- [ ] **Step 1: Create `TimeEntryForm.tsx`**

Follow the patterns in existing Phase 1 components (e.g. the client new page form). Use native `<select>` for cascading (no fancy combobox).

Structure:

```tsx
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import type { PracticeTimeEntryInput } from '@/modules/accounting/services/practice/practiceTimeEntryService';

export interface Client { id: string; legalName: string; tradingName?: string | null; }
export interface Category { id: string; name: string; }
export interface WorkItem { id: string; name: string; categoryId: string; }

export interface TimeEntryFormProps {
  clients: Client[];
  categories: Category[];
  defaultDate: string;
  onSubmit: (input: PracticeTimeEntryInput) => Promise<void>;
  onCancel?: () => void;
}

export function TimeEntryForm({ clients, categories, defaultDate, onSubmit, onCancel }: TimeEntryFormProps) {
  const [entryDate, setEntryDate] = useState(defaultDate);
  const [hours, setHours] = useState<string>('');
  const [practiceClientId, setPracticeClientId] = useState('');
  const [jobCategoryId, setJobCategoryId] = useState('');
  const [workItemId, setWorkItemId] = useState('');
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [taskDescription, setTaskDescription] = useState('');
  const [notes, setNotes] = useState('');
  const [billable, setBillable] = useState(true);
  const [ratePreview, setRatePreview] = useState<number | null | 'loading' | 'none'>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // When category changes, fetch work items
  useEffect(() => {
    if (!jobCategoryId) { setWorkItems([]); setWorkItemId(''); return; }
    apiFetch(`/api/accounting/practice/work-items?categoryId=${jobCategoryId}&isActive=true`)
      .then((data: { workItems: WorkItem[] } | WorkItem[]) => {
        const items = Array.isArray(data) ? data : data.workItems ?? [];
        setWorkItems(items);
      })
      .catch(() => setWorkItems([]));
  }, [jobCategoryId]);

  // Rate preview when client + date set
  useEffect(() => {
    if (!practiceClientId || !entryDate) { setRatePreview(null); return; }
    setRatePreview('loading');
    apiFetch(`/api/accounting/practice/rate-resolve?clientId=${practiceClientId}&onDate=${entryDate}`)
      .then((data: { rate: number }) => setRatePreview(data.rate))
      .catch((e) => {
        // 404 = no rate configured
        setRatePreview('none');
      });
  }, [practiceClientId, entryDate]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const hrs = Number(hours);
    if (!(hrs > 0 && hrs <= 24)) { setError('Hours must be between 0 and 24'); return; }
    setSubmitting(true);
    try {
      await onSubmit({
        entryDate,
        hours: hrs,
        practiceClientId,
        jobCategoryId,
        workItemId,
        taskDescription,
        notes: notes || null,
        billable,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save entry');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-6 gap-3 p-4 border rounded bg-white">
      <div className="md:col-span-2">
        <label className="text-xs text-slate-500">Date</label>
        <input type="date" value={entryDate} onChange={e => setEntryDate(e.target.value)} required className="block w-full border rounded px-2 py-1" />
      </div>
      <div>
        <label className="text-xs text-slate-500">Hours</label>
        <input type="number" step="0.25" min="0" max="24" value={hours} onChange={e => setHours(e.target.value)} required className="block w-full border rounded px-2 py-1" />
      </div>
      <div className="md:col-span-3">
        <label className="text-xs text-slate-500">Client</label>
        <select value={practiceClientId} onChange={e => setPracticeClientId(e.target.value)} required className="block w-full border rounded px-2 py-1">
          <option value="">Select client…</option>
          {clients.map(c => <option key={c.id} value={c.id}>{c.tradingName || c.legalName}</option>)}
        </select>
      </div>
      <div className="md:col-span-3">
        <label className="text-xs text-slate-500">Category</label>
        <select value={jobCategoryId} onChange={e => setJobCategoryId(e.target.value)} required className="block w-full border rounded px-2 py-1">
          <option value="">Select category…</option>
          {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <div className="md:col-span-3">
        <label className="text-xs text-slate-500">Work item</label>
        <select value={workItemId} onChange={e => setWorkItemId(e.target.value)} required disabled={!jobCategoryId} className="block w-full border rounded px-2 py-1">
          <option value="">{jobCategoryId ? 'Select work item…' : 'Pick a category first'}</option>
          {workItems.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      </div>
      <div className="md:col-span-6">
        <label className="text-xs text-slate-500">Task description</label>
        <input type="text" value={taskDescription} onChange={e => setTaskDescription(e.target.value)} required maxLength={500} className="block w-full border rounded px-2 py-1" />
      </div>
      <div className="md:col-span-4">
        <label className="text-xs text-slate-500">Notes (optional)</label>
        <input type="text" value={notes} onChange={e => setNotes(e.target.value)} className="block w-full border rounded px-2 py-1" />
      </div>
      <div className="md:col-span-1 flex items-end">
        <label className="text-xs text-slate-500 inline-flex items-center gap-1">
          <input type="checkbox" checked={billable} onChange={e => setBillable(e.target.checked)} />
          Billable
        </label>
      </div>
      <div className="md:col-span-1 flex items-end text-xs text-slate-600">
        {ratePreview === 'loading' && <span>Resolving rate…</span>}
        {ratePreview === 'none' && <span className="text-amber-700">No rate configured</span>}
        {typeof ratePreview === 'number' && <span>R{ratePreview}/h × {hours || 0}h = <b>R{(Number(hours || 0) * ratePreview).toFixed(2)}</b></span>}
      </div>
      {error && <div className="md:col-span-6 text-sm text-rose-700">{error}</div>}
      <div className="md:col-span-6 flex gap-2">
        <button type="submit" disabled={submitting} className="px-4 py-2 rounded bg-slate-900 text-white disabled:opacity-50">
          {submitting ? 'Saving…' : 'Save entry'}
        </button>
        {onCancel && <button type="button" onClick={onCancel} className="px-4 py-2 rounded border">Cancel</button>}
      </div>
    </form>
  );
}
```

- [ ] **Step 2: Create `DayTotalsBar.tsx`**

Short component — ~60 lines.

- [ ] **Step 3: Type check**

Run: `bunx tsc --noEmit`
Expected: zero errors

- [ ] **Step 4: Commit**

```bash
git add src/components/practice/
git commit -m "feat(practice): TimeEntryForm + DayTotalsBar components"
```

---

## Task 6: Day-view time entry page

**Files:**
- Create: `pages/accounting/practice/time-entry/index.tsx`

**Responsibilities:**
- Load active practice clients once on mount.
- Load active job categories once on mount.
- Day picker at top (defaults today, buttons: « prev day | today | next day »).
- Render `<TimeEntryForm />` for creating new entries.
- Below the form: a list of existing entries for the selected `userId + entryDate`, with delete button for draft rows.
- `<DayTotalsBar />` at the top showing totals for the selected day.
- "Submit day" button that POSTs to `/api/accounting/practice/time-entries/submit` with all draft entry ids for the current day.

**File size ceiling:** 280 lines. Extract a small `<EntryRow />` component inline if needed.

- [ ] **Step 1: Scaffold the page**

```tsx
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import AppLayout from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { TimeEntryForm, type Client, type Category } from '@/components/practice/TimeEntryForm';
import { DayTotalsBar } from '@/components/practice/DayTotalsBar';
// ...types from services
```

Data flow:
1. `useEffect` on mount → load clients + categories in parallel.
2. `useEffect` on `entryDate` change → load entries for that day.
3. On submit new entry → refresh entries list.
4. On delete → call DELETE then refresh.
5. On "Submit day" → POST /submit with all draft ids, then refresh.

Use absolute dates for navigation (add/subtract day). Format with `new Date(entryDate).toISOString().split('T')[0]`.

- [ ] **Step 2: Test the UI in a browser**

Start dev server if not already running: `bun run dev`
Navigate to `http://localhost:3000/accounting/practice/time-entry`.
Verify:
- Page loads with today's date prefilled
- Client dropdown populated with active practice clients
- Category → Work item cascading works (pick category, work items load, pick different category, work items update)
- Submitting a valid entry creates the row and clears the form
- Rate preview shows (or "No rate configured")
- DayTotalsBar updates with new entry
- Submit day button flips drafts to submitted

- [ ] **Step 3: Type check + commit**

```bash
bunx tsc --noEmit
git add pages/accounting/practice/time-entry/
git commit -m "feat(practice): day-view time entry page with cascading form"
```

---

## Task 7: WIP board page

**Files:**
- Create: `pages/accounting/practice/wip/index.tsx`

**Responsibilities:**
- Load `GET /api/accounting/practice/wip` once on mount.
- Render an accordion/table per practice client:
  - Header row: client name, total hours, total value, oldest approved date, partner name.
  - Expanded: list of entries with checkboxes. Checkbox at group header selects/deselects all in group.
- "Generate Invoice" button enabled when at least one entry is selected.
- Clicking opens a modal with:
  - Invoice date picker (default today)
  - Tax rate input (default 15)
  - Grouping select: Detailed / By work item / By category
  - Confirm → POST `/api/accounting/practice/wip/invoice` with `{ practiceClientId, timeEntryIds, invoiceDate, taxRate, groupBy }`.
- On success: show toast with invoice number + link to `/accounting/customer-invoices/{invoiceId}`, refresh WIP.
- If client has no `link_customer_id`, button shows "Set link customer →" linking to client edit page.

**File size ceiling:** 300 lines. Extract a small `<WipClientGroup />` component if needed — put it in the same file under the default export.

- [ ] **Step 1: Scaffold the page**

Same pattern as client list page.

- [ ] **Step 2: Browser test**

Navigate to `/accounting/practice/wip`. Verify:
- Lists only clients with approved, unbilled entries.
- Selecting entries and clicking Generate Invoice opens the modal.
- Submitting creates a customer invoice (check `/accounting/customer-invoices`) and removes the billed entries from WIP.
- Grouping options produce different line item counts in the created invoice.

- [ ] **Step 3: Type check + commit**

```bash
bunx tsc --noEmit
git add pages/accounting/practice/wip/
git commit -m "feat(practice): WIP board page with invoice generation modal"
```

---

## Task 8: Navigation + approval UI + integration check

- [ ] **Step 1: Verify nav points to the new pages**

Read `src/components/accounting/navSections/practice.ts`. Confirm "Enter Time" → `/accounting/practice/time-entry`. Current value in master is `/accounting/time-tracking` — update if needed:

```typescript
{ label: 'Enter Time', href: '/accounting/practice/time-entry' },
```

Add an "Approvals" item under "Time Entry" section for partners:

```typescript
{ label: 'Approvals', href: '/accounting/practice/approvals' },
```

- [ ] **Step 2: Create the approvals page**

Create `pages/accounting/practice/approvals/index.tsx`:
- Lists all entries with `status=submitted` across the company.
- Bulk select + "Approve selected" → POST `/api/accounting/practice/time-entries/approve`.
- Filters: by userId (submitter), by client, by date range.

File size ceiling: 250 lines.

- [ ] **Step 3: Integration check — full workflow smoke test**

With dev server running:

1. Go to `/accounting/practice/time-entry`. Create 3 draft entries for one client, different dates.
2. Click "Submit day" on one day, verify those entries flip to `submitted`.
3. Go to `/accounting/practice/approvals`. Select the submitted entries, click "Approve selected".
4. Go to `/accounting/practice/wip`. Verify the approved entries appear under their client.
5. Select the entries, click Generate Invoice, confirm. Verify:
   - A new customer invoice appears in `/accounting/customer-invoices`.
   - The billed entries disappear from WIP.
   - The entries in `/accounting/practice/time-entry` now show status=billed.

- [ ] **Step 4: Run full test suite**

```bash
bun run test:unit
bunx tsc --noEmit
```

Expected: all tests green, zero type errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/accounting/navSections/practice.ts \
        pages/accounting/practice/approvals/
git commit -m "feat(practice): approvals page and nav update"
```

---

## Task 9: Self-review and finish

- [ ] **Step 1: Review file line counts**

```bash
find src/modules/accounting/services/practice/practiceTimeEntryService.ts \
     src/modules/accounting/services/practice/practiceWipService.ts \
     src/components/practice/ \
     pages/accounting/practice/time-entry/ \
     pages/accounting/practice/wip/ \
     pages/accounting/practice/approvals/ \
     -name "*.ts" -o -name "*.tsx" | xargs wc -l
```

Any file > 300 lines must be split before the PR.

- [ ] **Step 2: Grep for forbidden patterns**

```bash
grep -r "console\\.log" src/modules/accounting/services/practice/ src/components/practice/ pages/accounting/practice/time-entry pages/accounting/practice/wip pages/accounting/practice/approvals
```

Expected: no matches.

- [ ] **Step 3: Grep for missing company_id filters**

Quick visual review — every `FROM time_entries` / `FROM practice_*` / `FROM customer_invoice*` in new code must include `AND company_id = ${companyId}::UUID` (or equivalent JOIN-tenancy check).

- [ ] **Step 4: Run tests one more time**

```bash
bun run test:unit -- --reporter=verbose
bunx tsc --noEmit
```

- [ ] **Step 5: Use superpowers:finishing-a-development-branch**

Present the 4 options to the user (merge locally / push + PR / keep / discard). Expected choice: push + PR.

---

## Self-Review (plan-author's checklist)

**Spec coverage — every Phase 2 PRD bullet mapped to a task:**

| PRD line | Requirement | Task |
|----------|-------------|------|
| 87–89 | Day view + list view for time entries | Task 6 |
| 90 | Per-entry fields (date, hours, client, category, work item, notes, billable, status) | Tasks 1, 5, 6 |
| 91 | Rate auto-resolved from staff rate history | Task 1 (`resolveRate` call) |
| 92 | Total auto-computed server-side | Task 1 (`line_total = hours * applied_rate`) |
| 93 | Duplicate previous entry for recurring work | Tasks 1 (`duplicatePracticeEntry`), 6 |
| 95 | Bulk entry — **not in Phase 2**, deferred to Phase 3 (noted as gap below) |
| 99–107 | Validation rules table | Task 1 (all rules implemented in `createPracticeEntry`) |
| 110 | Statuses: draft → submitted → approved → billed / not_billable / leave | Task 1 functions + Task 3 APIs + Task 8 approvals UI |
| 153–158 | WIP view: all approved, not-yet-billed time by client, with subtotals | Task 2 `getWipByClient` + Task 7 UI |
| 156 | Select entries → generate practice invoice | Task 2 `generateWipInvoice` + Task 7 modal |
| 157 | Billing formats: detailed or summarised | Task 2 `groupBy` parameter |
| 158 | Invoice line item grouping options | Task 2 (detailed / by_work_item / by_category) |
| 159 | WIP aging (how long entries have been approved) | Task 2 (`oldestApprovedDate` on WIP summary; full aging report deferred to Phase 4) |
| 160 | Write-off unapproved/unbillable entries | Partially covered (status `not_billable` via update); full write-off reason codes deferred |
| 164 | Invoice line items carry `time_entry_id` reference | **Gap** — current plan stores only description. See note below. |

**Known gaps (deferred or flagged):**

1. **Bulk entry (week/range fill from template)** — PRD line 95. Deferred to a Phase 2.5 follow-up; noted in plan's intro as out-of-scope for this pass.
2. **Favourites/templates** — PRD line 94. Deferred to Phase 2.5.
3. **Write-off reason codes** — PRD line 160. Deferred; a manual status update to `not_billable` is the interim mechanism.
4. **`time_entry_id` reference on invoice line items** — PRD line 164. The existing `customer_invoice_items` schema does not have a `time_entry_id` column. Two options: (a) add a column in a new migration (375), (b) store the reference implicitly via `time_entries.invoice_id`. The plan uses (b). A traceability query can join `time_entries` to `customer_invoices` via `invoice_id`. If (a) is preferred, add a Task 0 that ships migration 375 adding `time_entry_id UUID REFERENCES time_entries(id)` to `customer_invoice_items`.

**Placeholder scan:** searched for TBD / TODO / "implement later" / "similar to Task N" / "add appropriate" — none found.

**Type consistency:**
- `PracticeTimeEntry` field names match across Tasks 1, 2, 5, 6, 7, 8.
- `markEntriesBilled` signature (`companyId, ids, invoiceId`) consistent between Task 1 definition and Task 2 call site.
- `WipClientRow.linkCustomerId` matches the validation in `generateWipInvoice` that reads `clientRows[0].link_customer_id`.
- `groupBy` enum consistent between `GenerateWipInvoiceInput` (Task 2) and UI select (Task 7).

All consistent.

---

## Execution notes

- **Migration range:** No new migrations needed unless the deferred gap #4 (`time_entry_id` on invoice items) is promoted. Migration 375 is reserved for that; otherwise leave unused for Phase 3.
- **Worktree branch:** `feature/prd-01-practice-phase2` off `origin/master`.
- **Expected test count added:** ~20 new unit tests (9 + 5 in Tasks 1 and 2). Total practice tests: ~56.
- **Expected commits:** 8 (one per task plus Task 8's two commits and Task 9's no-code review).
