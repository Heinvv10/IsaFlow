# PRD-01 Practice Management — Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Jobs + Tasks workflow engine on top of the Phase 1/2 foundation — partners can package client work into jobs, preparers pick up tasks, time entries link to jobs for traceability.

**Architecture:** Two new tables (`practice_jobs`, `practice_tasks`) + one column add on `time_entries` (optional `job_id`). Two new services in the existing `practice` module. New API routes under `pages/api/accounting/practice/jobs` and `/tasks`. New UI: Jobs list (with Kanban toggle), Task inbox, Job detail. Nav updated.

**Tech Stack:** Same as Phase 1/2 — Next.js 14, TypeScript, Neon, Vitest, Tailwind.

**Scope boundary:** Notifications (email/push for overdue) are explicitly deferred — the UI will surface overdue via amber styling, but no outbound channel is built. Client portal for job/task visibility is PRD non-goal (Phase 2 of the overall suite, not this plan).

---

## Context & Pre-conditions

Phase 1 + Phase 2 + Phase 2.5 shipped. Available in master (or PR #15 for Phase 2):
- `practice_clients`, `practice_client_groups`, `practice_client_contacts`
- `practice_job_categories`, `practice_work_items`
- `practice_staff_rates`, `practice_client_rate_overrides`
- `time_entries` extended with practice_client_id, job_category_id, work_item_id, applied_rate, line_total, origin, approved_by/at, billed_at, write_off_reason, written_off_by/at
- `practice_entry_templates`
- Services: `practiceClientService`, `practiceJobCategoryService`, `practiceStaffRateService`, `practiceTimeEntryService`, `practiceTimeEntryWorkflow`, `practiceWipService`, `practiceEntryTemplateService`
- UI: Practice tab nav, client pages, time entry day view, WIP board, approvals

**Migration numbers available:** 378, 379, 385–389 (380–384 are payroll; 375–377 go to PR #15's follow-ups).

**Worktree:** `.worktrees/prd-01-practice-phase3` on branch `feature/prd-01-practice-phase3` branched from `origin/master`.

---

## File Structure

### New files

**Migrations:**
- `scripts/migrations/sql/378_practice_jobs.sql`
- `scripts/migrations/sql/379_practice_tasks.sql`
- `scripts/migrations/sql/385_time_entries_job_link.sql`

**Services:**
- `src/modules/accounting/services/practice/practiceJobService.ts`
- `src/modules/accounting/services/practice/practiceTaskService.ts`

**API routes (under `pages/api/accounting/practice/`):**
- `jobs.ts` (GET + POST)
- `jobs/[id].ts` (GET/PUT/DELETE)
- `jobs/transition.ts` (POST status transition)
- `tasks.ts` (GET + POST)
- `tasks/[id].ts` (GET/PUT/DELETE)
- `tasks/transition.ts` (POST status transition)
- `tasks/recurring.ts` (POST generate next instance)

**UI pages:**
- `pages/accounting/practice/jobs/index.tsx` — list + Kanban toggle
- `pages/accounting/practice/jobs/new.tsx` — create form
- `pages/accounting/practice/jobs/[id].tsx` — detail + linked tasks + linked time entries
- `pages/accounting/practice/tasks/index.tsx` — task inbox with filter tabs

**Components:**
- `src/components/practice/JobStatusBadge.tsx` — colored status pill (reused in list, kanban, detail)
- `src/components/practice/KanbanBoard.tsx` — columns-by-status board used on jobs list

**Tests:**
- `tests/unit/services/practice/practiceJobService.test.ts`
- `tests/unit/services/practice/practiceTaskService.test.ts`

### Modified files

- `src/components/accounting/navSections/practice.ts` — confirm Jobs & Tasks items point at the new routes (they already do per Phase 1).

---

## Status Vocabulary

**Jobs:** `new` → `in_progress` → `review` → `approved` → `billed` → `complete`. Plus terminal `cancelled`.

Allowed transitions (enforced server-side):
- `new` → `in_progress`, `cancelled`
- `in_progress` → `review`, `cancelled`
- `review` → `in_progress`, `approved`, `cancelled`
- `approved` → `billed`, `cancelled`
- `billed` → `complete`
- `complete` / `cancelled` → terminal

**Tasks:** `pending` → `in_progress` → `done`. Plus terminal `cancelled`.

**Recurring rule:** store as TEXT, one of: `'weekly'` | `'monthly'` | `'quarterly'` | `'yearly'`. MVP. No RRULE parser.

---

## Task 1: Migrations

**Files:**
- Create: `scripts/migrations/sql/378_practice_jobs.sql`
- Create: `scripts/migrations/sql/379_practice_tasks.sql`
- Create: `scripts/migrations/sql/385_time_entries_job_link.sql`

- [ ] **Step 1: Write migration 378**

```sql
-- 378_practice_jobs.sql
-- Client-linked work packages with status workflow.

CREATE TABLE IF NOT EXISTS practice_jobs (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           UUID NOT NULL REFERENCES companies(id),
  practice_client_id   UUID NOT NULL REFERENCES practice_clients(id),
  job_category_id      UUID REFERENCES practice_job_categories(id),
  title                TEXT NOT NULL,
  description          TEXT,
  partner_id           UUID,
  preparer_id          UUID,
  due_date             DATE,
  priority             TEXT NOT NULL DEFAULT 'normal'
                         CHECK (priority IN ('low','normal','high','urgent')),
  status               TEXT NOT NULL DEFAULT 'new'
                         CHECK (status IN ('new','in_progress','review','approved','billed','complete','cancelled')),
  financial_year       TEXT,
  billing_type         TEXT CHECK (billing_type IN ('hourly','fixed','retainer')),
  budgeted_hours       NUMERIC(8,2),
  fixed_fee_amount     NUMERIC(18,2),
  started_at           TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ,
  created_by           UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pj_company_client ON practice_jobs(company_id, practice_client_id);
CREATE INDEX IF NOT EXISTS idx_pj_company_status ON practice_jobs(company_id, status);
CREATE INDEX IF NOT EXISTS idx_pj_company_partner ON practice_jobs(company_id, partner_id);
CREATE INDEX IF NOT EXISTS idx_pj_company_due ON practice_jobs(company_id, due_date);
```

- [ ] **Step 2: Write migration 379**

```sql
-- 379_practice_tasks.sql
-- Sub-items under a job, standalone internal tasks, recurring-rule support.

CREATE TABLE IF NOT EXISTS practice_tasks (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           UUID NOT NULL REFERENCES companies(id),
  job_id               UUID REFERENCES practice_jobs(id),
  parent_task_id       UUID REFERENCES practice_tasks(id),
  title                TEXT NOT NULL,
  description          TEXT,
  assigned_to          UUID,
  due_date             DATE,
  priority             TEXT NOT NULL DEFAULT 'normal'
                         CHECK (priority IN ('low','normal','high','urgent')),
  status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','in_progress','done','cancelled')),
  recurring_rule       TEXT
                         CHECK (recurring_rule IS NULL
                                OR recurring_rule IN ('weekly','monthly','quarterly','yearly')),
  completed_at         TIMESTAMPTZ,
  created_by           UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pt_company_job ON practice_tasks(company_id, job_id);
CREATE INDEX IF NOT EXISTS idx_pt_company_assigned ON practice_tasks(company_id, assigned_to);
CREATE INDEX IF NOT EXISTS idx_pt_company_status_due ON practice_tasks(company_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_pt_parent ON practice_tasks(parent_task_id) WHERE parent_task_id IS NOT NULL;
```

- [ ] **Step 3: Write migration 385**

```sql
-- 385_time_entries_job_link.sql
-- Optional link from a time entry to the job it was billed under.

ALTER TABLE time_entries
  ADD COLUMN IF NOT EXISTS job_id UUID REFERENCES practice_jobs(id);

CREATE INDEX IF NOT EXISTS idx_te_job ON time_entries(company_id, job_id)
  WHERE job_id IS NOT NULL;
```

- [ ] **Step 4: Commit**

```bash
git add scripts/migrations/sql/378_practice_jobs.sql \
        scripts/migrations/sql/379_practice_tasks.sql \
        scripts/migrations/sql/385_time_entries_job_link.sql
git commit -m "feat(practice): Phase 3 schema — jobs, tasks, time_entry.job_id"
```

---

## Task 2: `practiceJobService.ts` (TDD)

**Files:**
- Create: `src/modules/accounting/services/practice/practiceJobService.ts`
- Test: `tests/unit/services/practice/practiceJobService.test.ts`

**Exports:**

```typescript
export interface PracticeJob {
  id: string;
  companyId: string;
  practiceClientId: string;
  jobCategoryId: string | null;
  title: string;
  description: string | null;
  partnerId: string | null;
  preparerId: string | null;
  dueDate: string | null;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  status: 'new' | 'in_progress' | 'review' | 'approved' | 'billed' | 'complete' | 'cancelled';
  financialYear: string | null;
  billingType: 'hourly' | 'fixed' | 'retainer' | null;
  budgetedHours: number | null;
  fixedFeeAmount: number | null;
  startedAt: string | null;
  completedAt: string | null;
  createdBy: string | null;
  practiceClientName?: string | null;  // joined
  jobCategoryName?: string | null;     // joined
  createdAt: string;
  updatedAt: string;
}

export interface PracticeJobInput {
  practiceClientId: string;
  jobCategoryId?: string | null;
  title: string;
  description?: string | null;
  partnerId?: string | null;
  preparerId?: string | null;
  dueDate?: string | null;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  financialYear?: string | null;
  billingType?: 'hourly' | 'fixed' | 'retainer' | null;
  budgetedHours?: number | null;
  fixedFeeAmount?: number | null;
}

export interface JobFilters {
  practiceClientId?: string;
  partnerId?: string;
  preparerId?: string;
  status?: PracticeJob['status'];
  dueBefore?: string;
}

export async function listJobs(companyId: string, filters?: JobFilters): Promise<{ jobs: PracticeJob[]; total: number }>;
export async function getJob(companyId: string, id: string): Promise<PracticeJob | null>;
export async function createJob(companyId: string, userId: string, input: PracticeJobInput): Promise<PracticeJob>;
export async function updateJob(companyId: string, id: string, input: Partial<PracticeJobInput>): Promise<PracticeJob>;
export async function deleteJob(companyId: string, id: string): Promise<void>;  // hard delete only if no child tasks and no time entries linked
export async function transitionJob(companyId: string, id: string, newStatus: PracticeJob['status'], userId: string): Promise<PracticeJob>;
```

**Validation:**
- `title` required, trim, non-empty. Throw `'job title is required'`.
- `practiceClientId` must be active in company. Throw `'practice client not found or not active'`.
- `jobCategoryId` if provided must be active. Throw `'job category not found or not active'`.
- `transitionJob`: enforce the transition table from the Status Vocabulary section. Throw `'invalid status transition from X to Y'` on any disallowed transition. On transition to `in_progress`, set `started_at = NOW()` if null. On transition to `complete`, set `completed_at = NOW()`.
- `deleteJob`: throw `'cannot delete job with existing tasks or time entries — cancel it instead'` if any `practice_tasks.job_id = id` OR `time_entries.job_id = id`. Otherwise hard DELETE.

**Tests (≥12):**
- list returns mapped + count (happy)
- list filters by status, clientId, partnerId
- get returns null / returns mapped with joined names
- create rejects empty title
- create rejects inactive client
- create happy (sets status='new' by default)
- update rejects when job not found
- update happy
- transitionJob rejects invalid transitions (new → approved is invalid; new → in_progress OK)
- transitionJob stamps started_at on first transition to in_progress
- transitionJob stamps completed_at on transition to complete
- deleteJob rejects when child tasks exist
- deleteJob hard-deletes when clean

**Follow Phase 2's service file pattern** — `sql` tagged template, DbRow, log, max 300 lines, nullable-cast filter pattern for list.

- [ ] Steps: write tests → run (fail) → implement service → run (pass) → `bunx tsc --noEmit` → commit

```bash
git add src/modules/accounting/services/practice/practiceJobService.ts \
        tests/unit/services/practice/practiceJobService.test.ts
git commit -m "feat(practice): practiceJobService — CRUD + status workflow"
```

---

## Task 3: `practiceTaskService.ts` (TDD)

**Files:**
- Create: `src/modules/accounting/services/practice/practiceTaskService.ts`
- Test: `tests/unit/services/practice/practiceTaskService.test.ts`

**Exports:**

```typescript
export interface PracticeTask {
  id: string;
  companyId: string;
  jobId: string | null;
  parentTaskId: string | null;
  title: string;
  description: string | null;
  assignedTo: string | null;
  dueDate: string | null;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  status: 'pending' | 'in_progress' | 'done' | 'cancelled';
  recurringRule: 'weekly' | 'monthly' | 'quarterly' | 'yearly' | null;
  completedAt: string | null;
  createdBy: string | null;
  jobTitle?: string | null;  // joined from practice_jobs
  createdAt: string;
  updatedAt: string;
}

export interface PracticeTaskInput {
  jobId?: string | null;
  parentTaskId?: string | null;
  title: string;
  description?: string | null;
  assignedTo?: string | null;
  dueDate?: string | null;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  recurringRule?: 'weekly' | 'monthly' | 'quarterly' | 'yearly' | null;
}

export interface TaskFilters {
  jobId?: string;
  assignedTo?: string;
  status?: PracticeTask['status'];
  overdueOnly?: boolean;
  parentTaskId?: string;
}

export async function listTasks(companyId: string, filters?: TaskFilters): Promise<{ tasks: PracticeTask[]; total: number }>;
export async function getTask(companyId: string, id: string): Promise<PracticeTask | null>;
export async function createTask(companyId: string, userId: string, input: PracticeTaskInput): Promise<PracticeTask>;
export async function updateTask(companyId: string, id: string, input: Partial<PracticeTaskInput>): Promise<PracticeTask>;
export async function deleteTask(companyId: string, id: string): Promise<void>;
export async function transitionTask(companyId: string, id: string, newStatus: PracticeTask['status']): Promise<PracticeTask>;
export async function generateNextRecurringInstance(companyId: string, userId: string, sourceTaskId: string): Promise<PracticeTask>;
```

**Validation:**
- `title` required non-empty
- `jobId` if provided: verify the job exists + is in company + status != 'cancelled'. Throw `'job not found or cancelled'`.
- `parentTaskId` if provided: verify parent is in company. Cannot be self. Throw `'parent task invalid'`.
- `transitionTask`: pending ↔ in_progress OK. pending/in_progress → done OK. pending/in_progress → cancelled OK. done/cancelled terminal. On transition to done, set `completed_at = NOW()`.
- `generateNextRecurringInstance`: requires source task has `recurring_rule`, `due_date` not null. New due date = source due_date + (1 week / 1 month / 3 months / 1 year). New task inherits: title, description, assigned_to, priority, job_id, parent_task_id, recurring_rule. Status = 'pending', completed_at = null.

**`overdueOnly`:** when true, filter `status NOT IN ('done','cancelled') AND due_date < CURRENT_DATE`.

**Tests (≥10):**
- list happy + count
- list filters by assignedTo, status
- list overdueOnly returns only stale pending/in_progress tasks
- create rejects empty title
- create rejects cancelled job
- create happy (defaults priority='normal', status='pending')
- update happy
- transitionTask invalid transitions
- transitionTask stamps completed_at on done
- generateNextRecurringInstance rejects source with no recurring_rule
- generateNextRecurringInstance rejects source with no due_date
- generateNextRecurringInstance monthly adds one month (test both 2026-01-15 → 2026-02-15 and 2026-01-31 → 2026-02-28 edge case — use `Date` UTC math; if day-of-month doesn't exist in next month, clamp to last day)

**File size ceiling:** 300 lines.

- [ ] Steps: write tests → run (fail) → implement service → run (pass) → tsc → commit

```bash
git add src/modules/accounting/services/practice/practiceTaskService.ts \
        tests/unit/services/practice/practiceTaskService.test.ts
git commit -m "feat(practice): practiceTaskService — CRUD + status workflow + recurring generator"
```

---

## Task 4: Jobs API routes

**Files:**
- Create: `pages/api/accounting/practice/jobs.ts` (GET list + POST create)
- Create: `pages/api/accounting/practice/jobs/[id].ts` (GET/PUT/DELETE)
- Create: `pages/api/accounting/practice/jobs/transition.ts` (POST `{ id, newStatus }`)

Same pattern as Phase 2 Task 3 — `withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))))` for writes. GET list route: no write middleware. Pass `req.user.id` as createdBy/transitioner.

- [ ] Create + tsc + commit.

```bash
git add pages/api/accounting/practice/jobs.ts pages/api/accounting/practice/jobs/
git commit -m "feat(practice): jobs API routes (CRUD + transition)"
```

---

## Task 5: Tasks API routes

**Files:**
- Create: `pages/api/accounting/practice/tasks.ts` (GET + POST)
- Create: `pages/api/accounting/practice/tasks/[id].ts` (GET/PUT/DELETE)
- Create: `pages/api/accounting/practice/tasks/transition.ts` (POST `{ id, newStatus }`)
- Create: `pages/api/accounting/practice/tasks/recurring.ts` (POST `{ sourceTaskId }` → new task)

Same middleware pattern.

- [ ] Create + tsc + commit.

```bash
git add pages/api/accounting/practice/tasks.ts pages/api/accounting/practice/tasks/
git commit -m "feat(practice): tasks API routes (CRUD + transition + recurring)"
```

---

## Task 6: Jobs list page + Kanban

**Files:**
- Create: `pages/accounting/practice/jobs/index.tsx` — ≤ 280 lines
- Create: `pages/accounting/practice/jobs/new.tsx` — ≤ 200 lines
- Create: `src/components/practice/JobStatusBadge.tsx` — ≤ 60 lines
- Create: `src/components/practice/KanbanBoard.tsx` — ≤ 200 lines

### Jobs list behaviour

- Load all jobs on mount (or filtered): `GET /api/accounting/practice/jobs?status=...`
- Top bar: filter by status (multi-select), client (dropdown populated from `/clients?status=active`), partner (if list of users available — else skip)
- View toggle: `[List] | [Kanban]` — persists in URL query (`?view=kanban`)
- List view: rows with client, title, partner, due date, priority, status badge, "View" link → `/jobs/{id}`
- Kanban view: columns per status (`new`, `in_progress`, `review`, `approved`, `billed`, `complete`, `cancelled`). Cards per job: title, client name, due date, priority dot. Clicking card → detail page.

**No drag-and-drop in Phase 3.** The Kanban is read-only-with-transition-menu: click a card → open a small popover with "Move to [next allowed status]" buttons. Avoids DnD infra.

### JobStatusBadge

Colored pill based on status — `new` slate, `in_progress` blue, `review` amber, `approved` green, `billed` emerald, `complete` neutral, `cancelled` rose.

### KanbanBoard props

```typescript
{
  jobs: PracticeJob[];
  onTransition: (jobId: string, newStatus: string) => Promise<void>;
}
```

Computes column groups internally by `status`.

### New-job form

Fields: client (required, from active list), title (required), category (optional), partner (optional text input for user id placeholder OR skip if we don't have a users API yet), due date, priority, financial year, billing type, budgeted hours, fixed fee amount. Submit → POST, then redirect to detail.

- [ ] Steps: create + tsc + commit.

```bash
git add pages/accounting/practice/jobs/ src/components/practice/JobStatusBadge.tsx src/components/practice/KanbanBoard.tsx
git commit -m "feat(practice): jobs list with kanban toggle + new-job form + status badge"
```

---

## Task 7: Tasks inbox page

**File:**
- Create: `pages/accounting/practice/tasks/index.tsx` — ≤ 280 lines

### Behaviour

- Tabs: `My Tasks` (default) | `Overdue` | `Upcoming` | `All` | `Unassigned`
- Each tab maps to a filter set:
  - My Tasks: `assignedTo={currentUserId}`, `status in ('pending','in_progress')`
  - Overdue: `overdueOnly=true`
  - Upcoming: `status in ('pending','in_progress')`, `dueDate` within next 14 days
  - All: no filter
  - Unassigned: `assignedTo IS NULL`, `status != 'done'`
- Row: checkbox (for bulk transition, optional), title, linked job, assignee, due date (amber if overdue), priority, status badge with click-to-toggle (opens dropdown: "Mark in progress" / "Mark done" / "Cancel")
- Inline quick-add: sticky bottom bar with title + assignee + due date + "Add"

- [ ] Create + tsc + commit.

```bash
git add pages/accounting/practice/tasks/
git commit -m "feat(practice): task inbox with filter tabs + inline quick-add"
```

---

## Task 8: Job detail page

**File:**
- Create: `pages/accounting/practice/jobs/[id].tsx` — ≤ 300 lines

### Behaviour

- Header: title, client link, partner, preparer, status badge, priority, due date
- Three tabs / sections:
  - **Details:** full form (editable in-place; Save button on change)
  - **Tasks:** list of `practice_tasks` where `job_id = :id`; inline add + transition buttons (reuse pattern from Task 7)
  - **Time:** list of `time_entries` where `job_id = :id`; total hours + total value. Link to the day-view page for each entry.
- Actions row: "Transition →" menu (next allowed statuses), "Delete job" (calls DELETE; shows the "has tasks/entries" error if it fires)

### Load

- `GET /api/accounting/practice/jobs/{id}` — header
- `GET /api/accounting/practice/tasks?jobId={id}` — tasks
- `GET /api/accounting/practice/time-entries?jobId={id}` — time entries (requires Task 1 migration 385 + listPracticeEntries filter on jobId; see note below)

**Note:** `listPracticeEntries` in Phase 2 does NOT filter by jobId. Add the filter in this task (mechanical change — one more nullable filter). Update the associated test in `practiceTimeEntryService.test.ts` to cover the new filter. If the filter addition pushes the service file over 300 lines, trim elsewhere first.

- [ ] Create + tsc + commit.

```bash
git add pages/accounting/practice/jobs/[id].tsx \
        src/modules/accounting/services/practice/practiceTimeEntryService.ts \
        tests/unit/services/practice/practiceTimeEntryService.test.ts
git commit -m "feat(practice): job detail page + time-entry jobId filter"
```

---

## Task 9: Nav verification + overdue-indicator polish

- [ ] **Step 1: Verify nav points at the right routes**

`src/components/accounting/navSections/practice.ts` — confirm:
- `{ label: 'Jobs', href: '/accounting/practice/jobs' }` ✓
- `{ label: 'Tasks', href: '/accounting/practice/tasks' }` ✓

Both already point at the new pages. No change needed unless the Phase 1 version has stale URLs.

- [ ] **Step 2: Overdue indicator on the day-view entry page**

In `pages/accounting/practice/time-entry/index.tsx`, if an entry's linked `job_id` → `due_date` is past, show a small amber `!` icon next to the task description. Pull joined `job_due_date` from the listPracticeEntries query (skip if too invasive — acceptable to defer).

Keep it minimal. If it requires more than a 10-line change, skip it entirely and note as a Phase 4 follow-up.

- [ ] **Step 3: Commit (if changes)**

```bash
git add src/components/accounting/navSections/practice.ts pages/accounting/practice/time-entry/index.tsx
git commit -m "feat(practice): nav verify + overdue indicator on time entries"
```

---

## Task 10: Self-review + finish

- [ ] **Step 1: File-size audit**

```bash
find src/modules/accounting/services/practice/practiceJobService.ts \
     src/modules/accounting/services/practice/practiceTaskService.ts \
     src/components/practice/JobStatusBadge.tsx \
     src/components/practice/KanbanBoard.tsx \
     pages/accounting/practice/jobs/ \
     pages/accounting/practice/tasks/ \
     pages/api/accounting/practice/jobs/ \
     pages/api/accounting/practice/tasks/ \
     -type f \( -name "*.ts" -o -name "*.tsx" \) -exec wc -l {} \;
```

Anything > 300 must be split.

- [ ] **Step 2: Full test + tsc**

```bash
bun run test:unit
bunx tsc --noEmit
```

- [ ] **Step 3: Manual smoke flow** (with dev server running)

1. Create a job for an existing client
2. Add three tasks to that job
3. Transition the job new → in_progress
4. Log time entries and link them to the job (via day-view if filter implemented, or via direct PUT for smoke)
5. Transition one task to done; check recurring=monthly generates next task
6. View the job detail page — shows tasks + time entries + totals
7. Transition job through review → approved → billed → complete
8. Try to delete a completed job — should fail if tasks/time entries exist

If dev server not started, skip the smoke and document the manual test plan in the PR description.

- [ ] **Step 4: Use superpowers:finishing-a-development-branch**

Present the 4 options. Expected: push + PR.

---

## Self-Review (plan-author's checklist)

**Spec coverage:**

| PRD requirement | Task |
|---|---|
| practice_jobs table with full field set | Task 1 |
| practice_tasks with recurring_rule, parent_task_id | Task 1 |
| Job status workflow new → in_progress → review → approved → billed → complete | Task 2 `transitionJob` |
| Task CRUD + recurring engine | Task 3 |
| Jobs API | Task 4 |
| Tasks API | Task 5 |
| Jobs/tasks UI list + Kanban view | Tasks 6, 7 |
| Link time entries to jobs | Task 1 (migration 385) + Task 8 (UI + filter) |
| Dashboard: overdue, upcoming, unassigned | Task 7 (filter tabs) — dashboard-widget-on-home deferred |
| Notifications: overdue reminders | **Deferred** — outbound channels not in scope. UI shows amber on overdue. |

**Known deferrals:**

1. **Overdue email/push notifications** — requires outbound channel infrastructure, job scheduler, template engine. Out of Phase 3.
2. **Recurring-task cron** — the `generateNextRecurringInstance` endpoint is called manually (e.g. from a button on the task row). Automatic daily generation requires a cron job. Can be added in Phase 4 with an internal scheduler endpoint (`/api/cron/generate-recurring-tasks`).
3. **Kanban drag-and-drop** — Phase 3 Kanban is click-to-transition. Full DnD requires a drop library (e.g. `dnd-kit`) — scoped creep.
4. **Users/staff directory for partner/preparer dropdowns** — if the project has no users API yet, fields stay as UUID text inputs with a TODO to swap for a proper dropdown. Non-blocking.
5. **Dashboard home widget** — aggregates jobs + tasks + WIP. The tasks inbox already surfaces overdue/upcoming — a home-page widget is cosmetic.

**Placeholder scan:** No TBD / TODO markers in task bodies (placeholder code blocks are marked explicitly as "MVP" or "deferred").

**Type consistency:**
- `PracticeJob.status` and `transitionJob` use the same 7-value union.
- `PracticeTask.status` and `transitionTask` use the same 4-value union.
- `recurring_rule` literal union matches DB CHECK constraint.
- `priority` literal union matches DB CHECK constraint on both tables.
- `billing_type` literal union matches DB CHECK + `practice_clients.billing_model` semantics.

All consistent.

---

## Execution notes

- **Migration range:** 378, 379, 385 used.
- **Worktree branch:** `feature/prd-01-practice-phase3` off `origin/master`.
- **Expected test count added:** ~22 new unit tests (12 jobs + 10 tasks). Total practice tests should hit ~113.
- **Expected commits:** ~10 (one per task, plus the service-file trim if Task 8's filter-addition pushes it over).
