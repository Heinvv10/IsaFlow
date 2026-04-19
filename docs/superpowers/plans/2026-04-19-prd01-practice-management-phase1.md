# PRD-01 Practice Management Suite — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the foundation entities (Practice CRM, Job Taxonomy, Staff Rates) and extend time_entries schema so accounting firms can replace their Excel-based client/job/time systems.

**Architecture:** New `practice_*` tables in migrations 370–374, three new services under `src/modules/accounting/services/practice/`, API routes under `pages/api/accounting/practice/`, UI pages under `pages/accounting/practice/`, and a new Practice nav tab. The `time_entries` table is extended via ALTER (not recreated). Existing `timeTrackingService.ts` is left untouched.

**Tech Stack:** Next.js 14, TypeScript, Neon (sql tagged template), Vitest (TDD), Tailwind CSS, bun.

**Migration range assigned:** 370–379

---

## File Map

### New migrations
- `scripts/migrations/sql/370_practice_clients.sql` — practice_clients, practice_client_groups, practice_client_contacts
- `scripts/migrations/sql/371_practice_job_taxonomy.sql` — practice_job_categories, practice_work_items
- `scripts/migrations/sql/372_practice_staff_rates.sql` — practice_staff_rates, practice_client_rate_overrides
- `scripts/migrations/sql/373_time_entries_enhance.sql` — ALTER time_entries add practice columns
- `scripts/migrations/sql/374_practice_seed_categories.sql` — seed default SA accounting job categories

### New services
- `src/modules/accounting/services/practice/practiceClientService.ts` — CRUD for clients, groups, contacts + duplicate detection
- `src/modules/accounting/services/practice/practiceJobCategoryService.ts` — CRUD for categories and work items
- `src/modules/accounting/services/practice/practiceStaffRateService.ts` — CRUD + rate resolution (staff default → client override)

### New tests
- `tests/unit/services/practice/practiceClientService.test.ts`
- `tests/unit/services/practice/practiceJobCategoryService.test.ts`
- `tests/unit/services/practice/practiceStaffRateService.test.ts`

### New API routes
- `pages/api/accounting/practice/clients.ts` — GET list + POST create
- `pages/api/accounting/practice/clients/[id].ts` — GET + PUT + DELETE
- `pages/api/accounting/practice/client-groups.ts` — GET + POST
- `pages/api/accounting/practice/client-contacts.ts` — GET + POST
- `pages/api/accounting/practice/client-contacts/[id].ts` — PUT + DELETE
- `pages/api/accounting/practice/job-categories.ts` — GET + POST
- `pages/api/accounting/practice/job-categories/[id].ts` — PUT + DELETE
- `pages/api/accounting/practice/work-items.ts` — GET + POST
- `pages/api/accounting/practice/work-items/[id].ts` — PUT + DELETE
- `pages/api/accounting/practice/staff-rates.ts` — GET + POST
- `pages/api/accounting/practice/staff-rates/[id].ts` — PUT + DELETE
- `pages/api/accounting/practice/rate-resolve.ts` — GET resolved rate for a user+client on a date

### New UI pages
- `pages/accounting/practice/clients/index.tsx` — client list with search + status filter
- `pages/accounting/practice/clients/new.tsx` — create client form
- `pages/accounting/practice/clients/[id].tsx` — client detail + edit + contacts tab
- `pages/accounting/practice/job-categories/index.tsx` — category admin with inline work items

### New nav section
- `src/components/accounting/navSections/practice.ts` — practiceTab definition
- Modify: `src/components/accounting/accountingNavConfig.ts` — add practiceTab to TABS

---

## Task 1: Migration 370 — Practice Clients

**Files:**
- Create: `scripts/migrations/sql/370_practice_clients.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 370_practice_clients.sql
-- Practice CRM: client registry distinct from AR customers

CREATE TABLE IF NOT EXISTS practice_client_groups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pcg_company ON practice_client_groups(company_id);

CREATE TABLE IF NOT EXISTS practice_clients (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID NOT NULL,
  legal_name          TEXT NOT NULL,
  trading_name        TEXT,
  registration_no     TEXT,
  tax_no              TEXT,
  client_group_id     UUID REFERENCES practice_client_groups(id),
  assigned_partner_id UUID,
  assigned_manager_id UUID,
  billing_model       TEXT NOT NULL DEFAULT 'hourly'
                        CHECK (billing_model IN ('hourly','fixed','retainer')),
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('prospect','onboarding','active','inactive','archived')),
  link_customer_id    UUID,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pc_company        ON practice_clients(company_id);
CREATE INDEX IF NOT EXISTS idx_pc_company_status ON practice_clients(company_id, status);
CREATE INDEX IF NOT EXISTS idx_pc_group          ON practice_clients(company_id, client_group_id);

CREATE TABLE IF NOT EXISTS practice_client_contacts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  client_id  UUID NOT NULL REFERENCES practice_clients(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  email      TEXT,
  phone      TEXT,
  role       TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pcc_client ON practice_client_contacts(client_id);
```

- [ ] **Step 2: Verify file exists and is valid SQL**

```bash
cat scripts/migrations/sql/370_practice_clients.sql | head -5
```

Expected: shows `-- 370_practice_clients.sql`

---

## Task 2: Migration 371 — Job Taxonomy

**Files:**
- Create: `scripts/migrations/sql/371_practice_job_taxonomy.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 371_practice_job_taxonomy.sql
-- Two-level job code taxonomy: Category → Work Item

CREATE TABLE IF NOT EXISTS practice_job_categories (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL,
  name          TEXT NOT NULL,
  sort_order    INT NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  reporting_tag TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pjc_company ON practice_job_categories(company_id, sort_order);

CREATE TABLE IF NOT EXISTS practice_work_items (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           UUID NOT NULL,
  category_id          UUID NOT NULL REFERENCES practice_job_categories(id),
  name                 TEXT NOT NULL,
  sort_order           INT NOT NULL DEFAULT 0,
  is_active            BOOLEAN NOT NULL DEFAULT true,
  default_billable     BOOLEAN NOT NULL DEFAULT true,
  default_rate_override NUMERIC(12,2),
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pwi_category ON practice_work_items(company_id, category_id);
```

- [ ] **Step 2: Verify**

```bash
cat scripts/migrations/sql/371_practice_job_taxonomy.sql | head -3
```

---

## Task 3: Migration 372 — Staff Rates

**Files:**
- Create: `scripts/migrations/sql/372_practice_staff_rates.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 372_practice_staff_rates.sql
-- Staff billing rate history with client-level overrides

CREATE TABLE IF NOT EXISTS practice_staff_rates (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID NOT NULL,
  user_id        UUID NOT NULL,
  rate           NUMERIC(12,2) NOT NULL CHECK (rate >= 0),
  currency       TEXT NOT NULL DEFAULT 'ZAR',
  effective_from DATE NOT NULL,
  effective_to   DATE,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT chk_psr_dates CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE INDEX IF NOT EXISTS idx_psr_user ON practice_staff_rates(company_id, user_id, effective_from);

CREATE TABLE IF NOT EXISTS practice_client_rate_overrides (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID NOT NULL,
  client_id      UUID NOT NULL REFERENCES practice_clients(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL,
  rate           NUMERIC(12,2) NOT NULL CHECK (rate >= 0),
  effective_from DATE NOT NULL,
  effective_to   DATE,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT chk_pcro_dates CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE INDEX IF NOT EXISTS idx_pcro_client_user ON practice_client_rate_overrides(company_id, client_id, user_id, effective_from);
```

- [ ] **Step 2: Verify**

```bash
cat scripts/migrations/sql/372_practice_staff_rates.sql | head -3
```

---

## Task 4: Migration 373 — Extend time_entries

**Files:**
- Create: `scripts/migrations/sql/373_time_entries_enhance.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 373_time_entries_enhance.sql
-- Extend time_entries with practice billing and workflow columns

ALTER TABLE time_entries
  ADD COLUMN IF NOT EXISTS practice_client_id UUID REFERENCES practice_clients(id),
  ADD COLUMN IF NOT EXISTS job_category_id    UUID REFERENCES practice_job_categories(id),
  ADD COLUMN IF NOT EXISTS work_item_id       UUID REFERENCES practice_work_items(id),
  ADD COLUMN IF NOT EXISTS applied_rate       NUMERIC(18,4),
  ADD COLUMN IF NOT EXISTS line_total         NUMERIC(18,2),
  ADD COLUMN IF NOT EXISTS origin             TEXT NOT NULL DEFAULT 'manual'
                             CHECK (origin IN ('manual','assisted','recurring')),
  ADD COLUMN IF NOT EXISTS invoice_id_new     UUID,
  ADD COLUMN IF NOT EXISTS approved_by        UUID,
  ADD COLUMN IF NOT EXISTS approved_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS billed_at          TIMESTAMPTZ;

-- Widen status CHECK to include practice statuses (drop old, add new)
ALTER TABLE time_entries DROP CONSTRAINT IF EXISTS time_entries_status_check;
ALTER TABLE time_entries
  ADD CONSTRAINT time_entries_status_check
    CHECK (status IN ('draft','submitted','approved','billed','not_billable','leave','invoiced'));

CREATE INDEX IF NOT EXISTS idx_te_practice_client ON time_entries(company_id, practice_client_id);
CREATE INDEX IF NOT EXISTS idx_te_work_item       ON time_entries(company_id, work_item_id);
CREATE INDEX IF NOT EXISTS idx_te_approved        ON time_entries(company_id, status, approved_at);
```

- [ ] **Step 2: Verify**

```bash
cat scripts/migrations/sql/373_time_entries_enhance.sql | head -3
```

---

## Task 5: Migration 374 — Seed Default Categories

**Files:**
- Create: `scripts/migrations/sql/374_practice_seed_categories.sql`

- [ ] **Step 1: Write the migration**

The seed inserts are wrapped in a DO block so they only fire if the company has no categories. Since this is multi-tenant SaaS we cannot seed per-tenant here — instead, seed into a `company_id = NULL` template that the UI can clone. Actually, for initial release, the API's POST /job-categories can pre-seed on first load. The migration only creates a `practice_default_job_categories` reference table (non-tenant).

```sql
-- 374_practice_seed_categories.sql
-- Default SA accounting firm job categories (reference table, non-tenant)

CREATE TABLE IF NOT EXISTS practice_default_categories (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  sort_order   INT NOT NULL DEFAULT 0,
  reporting_tag TEXT
);

INSERT INTO practice_default_categories (name, sort_order, reporting_tag) VALUES
  ('Accounting',           1,  'accounting'),
  ('Payroll',              2,  'payroll'),
  ('SARS',                 3,  'sars'),
  ('Financial Statements', 4,  'afs'),
  ('CIPC',                 5,  'cipc'),
  ('Tax Advisory',         6,  'tax'),
  ('Audit Support',        7,  'audit'),
  ('Admin',                8,  'admin'),
  ('Meeting',              9,  'admin')
ON CONFLICT DO NOTHING;
```

- [ ] **Step 2: Verify**

```bash
cat scripts/migrations/sql/374_practice_seed_categories.sql | head -3
```

- [ ] **Step 3: Commit migrations**

```bash
git add scripts/migrations/sql/370_practice_clients.sql \
        scripts/migrations/sql/371_practice_job_taxonomy.sql \
        scripts/migrations/sql/372_practice_staff_rates.sql \
        scripts/migrations/sql/373_time_entries_enhance.sql \
        scripts/migrations/sql/374_practice_seed_categories.sql
git commit -m "feat(db): migrations 370-374 — practice clients, job taxonomy, staff rates, time_entries enhance"
```

---

## Task 6: practiceClientService — Tests First

**Files:**
- Create: `tests/unit/services/practice/practiceClientService.test.ts`
- Create: `src/modules/accounting/services/practice/practiceClientService.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/services/practice/practiceClientService.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => {
  const sqlMock = vi.fn();
  return { sqlMock };
});

vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import {
  listPracticeClients,
  getPracticeClient,
  createPracticeClient,
  updatePracticeClient,
  deletePracticeClient,
  listClientGroups,
  createClientGroup,
  listClientContacts,
  createClientContact,
  deleteClientContact,
} from '@/modules/accounting/services/practice/practiceClientService';

const COMPANY = 'aaaaaaaa-0000-0000-0000-000000000001';
const CLIENT_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const GROUP_ID = 'cccccccc-0000-0000-0000-000000000003';
const CONTACT_ID = 'dddddddd-0000-0000-0000-000000000004';

const clientRow = {
  id: CLIENT_ID,
  company_id: COMPANY,
  legal_name: 'Marneweck Holdings (Pty) Ltd',
  trading_name: 'Marneweck',
  registration_no: '2020/123456/07',
  tax_no: '1234567890',
  client_group_id: null,
  assigned_partner_id: null,
  assigned_manager_id: null,
  billing_model: 'hourly',
  status: 'active',
  link_customer_id: null,
  created_at: new Date('2026-01-01'),
  updated_at: new Date('2026-01-01'),
};

beforeEach(() => vi.clearAllMocks());

describe('listPracticeClients', () => {
  it('returns mapped clients for company', async () => {
    sqlMock.mockResolvedValueOnce([{ cnt: 1 }]).mockResolvedValueOnce([clientRow]);
    const result = await listPracticeClients(COMPANY);
    expect(result.total).toBe(1);
    expect(result.clients[0]!.legalName).toBe('Marneweck Holdings (Pty) Ltd');
    expect(result.clients[0]!.companyId).toBe(COMPANY);
  });

  it('filters by status', async () => {
    sqlMock.mockResolvedValueOnce([{ cnt: 0 }]).mockResolvedValueOnce([]);
    const result = await listPracticeClients(COMPANY, { status: 'inactive' });
    expect(result.total).toBe(0);
    expect(result.clients).toHaveLength(0);
  });
});

describe('getPracticeClient', () => {
  it('returns null when not found', async () => {
    sqlMock.mockResolvedValueOnce([]);
    const result = await getPracticeClient(COMPANY, CLIENT_ID);
    expect(result).toBeNull();
  });

  it('returns mapped client when found', async () => {
    sqlMock.mockResolvedValueOnce([clientRow]);
    const result = await getPracticeClient(COMPANY, CLIENT_ID);
    expect(result?.id).toBe(CLIENT_ID);
    expect(result?.billingModel).toBe('hourly');
  });
});

describe('createPracticeClient', () => {
  it('creates and returns the new client', async () => {
    sqlMock.mockResolvedValueOnce([]).mockResolvedValueOnce([clientRow]);
    const result = await createPracticeClient(COMPANY, {
      legalName: 'Marneweck Holdings (Pty) Ltd',
      billingModel: 'hourly',
      status: 'active',
    });
    expect(result.id).toBe(CLIENT_ID);
  });

  it('throws on duplicate legal_name + company', async () => {
    sqlMock.mockResolvedValueOnce([{ id: 'existing' }]);
    await expect(
      createPracticeClient(COMPANY, {
        legalName: 'Marneweck Holdings (Pty) Ltd',
        billingModel: 'hourly',
        status: 'active',
      })
    ).rejects.toThrow('duplicate');
  });
});

describe('updatePracticeClient', () => {
  it('updates and returns modified client', async () => {
    const updated = { ...clientRow, trading_name: 'MH Group', updated_at: new Date() };
    sqlMock.mockResolvedValueOnce([clientRow]).mockResolvedValueOnce([updated]);
    const result = await updatePracticeClient(COMPANY, CLIENT_ID, { tradingName: 'MH Group' });
    expect(result.tradingName).toBe('MH Group');
  });

  it('throws when client not found', async () => {
    sqlMock.mockResolvedValueOnce([]);
    await expect(updatePracticeClient(COMPANY, CLIENT_ID, {})).rejects.toThrow('not found');
  });
});

describe('deletePracticeClient', () => {
  it('soft-deletes by setting status to archived', async () => {
    sqlMock.mockResolvedValueOnce([clientRow]).mockResolvedValueOnce([]);
    await expect(deletePracticeClient(COMPANY, CLIENT_ID)).resolves.toBeUndefined();
  });

  it('throws when client not found', async () => {
    sqlMock.mockResolvedValueOnce([]);
    await expect(deletePracticeClient(COMPANY, CLIENT_ID)).rejects.toThrow('not found');
  });
});

describe('listClientGroups', () => {
  it('returns groups for company', async () => {
    sqlMock.mockResolvedValueOnce([{ id: GROUP_ID, company_id: COMPANY, name: 'Marneweck Group', description: null, created_at: new Date(), updated_at: new Date() }]);
    const groups = await listClientGroups(COMPANY);
    expect(groups[0]!.name).toBe('Marneweck Group');
  });
});

describe('createClientGroup', () => {
  it('inserts and returns the group', async () => {
    sqlMock.mockResolvedValueOnce([{ id: GROUP_ID, company_id: COMPANY, name: 'New Group', description: 'desc', created_at: new Date(), updated_at: new Date() }]);
    const result = await createClientGroup(COMPANY, { name: 'New Group', description: 'desc' });
    expect(result.id).toBe(GROUP_ID);
    expect(result.name).toBe('New Group');
  });
});

describe('listClientContacts', () => {
  it('returns contacts for a client', async () => {
    sqlMock.mockResolvedValueOnce([{ id: CONTACT_ID, company_id: COMPANY, client_id: CLIENT_ID, name: 'John', email: 'j@example.com', phone: null, role: 'Director', is_primary: true, created_at: new Date() }]);
    const contacts = await listClientContacts(COMPANY, CLIENT_ID);
    expect(contacts[0]!.name).toBe('John');
    expect(contacts[0]!.isPrimary).toBe(true);
  });
});

describe('createClientContact', () => {
  it('inserts and returns contact', async () => {
    sqlMock.mockResolvedValueOnce([{ id: CONTACT_ID, company_id: COMPANY, client_id: CLIENT_ID, name: 'Jane', email: 'jane@example.com', phone: null, role: null, is_primary: false, created_at: new Date() }]);
    const result = await createClientContact(COMPANY, CLIENT_ID, { name: 'Jane', email: 'jane@example.com' });
    expect(result.id).toBe(CONTACT_ID);
  });
});

describe('deleteClientContact', () => {
  it('deletes without error', async () => {
    sqlMock.mockResolvedValueOnce([]);
    await expect(deleteClientContact(COMPANY, CONTACT_ID)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL (module not found)**

```bash
bun run test:unit tests/unit/services/practice/practiceClientService.test.ts
```

Expected: FAIL — `Cannot find module '@/modules/accounting/services/practice/practiceClientService'`

- [ ] **Step 3: Implement practiceClientService**

```typescript
// src/modules/accounting/services/practice/practiceClientService.ts
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';

export interface PracticeClient {
  id: string;
  companyId: string;
  legalName: string;
  tradingName: string | null;
  registrationNo: string | null;
  taxNo: string | null;
  clientGroupId: string | null;
  assignedPartnerId: string | null;
  assignedManagerId: string | null;
  billingModel: 'hourly' | 'fixed' | 'retainer';
  status: 'prospect' | 'onboarding' | 'active' | 'inactive' | 'archived';
  linkCustomerId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PracticeClientInput {
  legalName: string;
  tradingName?: string;
  registrationNo?: string;
  taxNo?: string;
  clientGroupId?: string;
  assignedPartnerId?: string;
  assignedManagerId?: string;
  billingModel: 'hourly' | 'fixed' | 'retainer';
  status: 'prospect' | 'onboarding' | 'active' | 'inactive' | 'archived';
  linkCustomerId?: string;
}

export interface ClientGroup {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClientContact {
  id: string;
  companyId: string;
  clientId: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: string | null;
  isPrimary: boolean;
  createdAt: string;
}

function mapClient(r: DbRow): PracticeClient {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    legalName: String(r.legal_name),
    tradingName: r.trading_name ? String(r.trading_name) : null,
    registrationNo: r.registration_no ? String(r.registration_no) : null,
    taxNo: r.tax_no ? String(r.tax_no) : null,
    clientGroupId: r.client_group_id ? String(r.client_group_id) : null,
    assignedPartnerId: r.assigned_partner_id ? String(r.assigned_partner_id) : null,
    assignedManagerId: r.assigned_manager_id ? String(r.assigned_manager_id) : null,
    billingModel: String(r.billing_model) as PracticeClient['billingModel'],
    status: String(r.status) as PracticeClient['status'],
    linkCustomerId: r.link_customer_id ? String(r.link_customer_id) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function mapGroup(r: DbRow): ClientGroup {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    name: String(r.name),
    description: r.description ? String(r.description) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function mapContact(r: DbRow): ClientContact {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    clientId: String(r.client_id),
    name: String(r.name),
    email: r.email ? String(r.email) : null,
    phone: r.phone ? String(r.phone) : null,
    role: r.role ? String(r.role) : null,
    isPrimary: Boolean(r.is_primary),
    createdAt: String(r.created_at),
  };
}

export async function listPracticeClients(
  companyId: string,
  filters?: { status?: string; search?: string; groupId?: string; limit?: number; offset?: number },
): Promise<{ clients: PracticeClient[]; total: number }> {
  const lim = filters?.limit ?? 50;
  const off = filters?.offset ?? 0;
  const countRows = (await sql`
    SELECT COUNT(*)::int AS cnt FROM practice_clients WHERE company_id = ${companyId}::UUID
  `) as DbRow[];
  const rows = (await sql`
    SELECT * FROM practice_clients
    WHERE company_id = ${companyId}::UUID
    ORDER BY legal_name ASC
    LIMIT ${lim} OFFSET ${off}
  `) as DbRow[];
  return { clients: rows.map(mapClient), total: Number(countRows[0]?.cnt ?? 0) };
}

export async function getPracticeClient(companyId: string, id: string): Promise<PracticeClient | null> {
  const rows = (await sql`
    SELECT * FROM practice_clients
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  return rows.length ? mapClient(rows[0]!) : null;
}

export async function createPracticeClient(
  companyId: string,
  input: PracticeClientInput,
): Promise<PracticeClient> {
  const dupes = (await sql`
    SELECT id FROM practice_clients
    WHERE company_id = ${companyId}::UUID AND legal_name = ${input.legalName}
  `) as DbRow[];
  if (dupes.length) throw new Error('duplicate: client with this legal name already exists');

  const rows = (await sql`
    INSERT INTO practice_clients (
      company_id, legal_name, trading_name, registration_no, tax_no,
      client_group_id, assigned_partner_id, assigned_manager_id,
      billing_model, status, link_customer_id
    ) VALUES (
      ${companyId}::UUID, ${input.legalName},
      ${input.tradingName ?? null}, ${input.registrationNo ?? null}, ${input.taxNo ?? null},
      ${input.clientGroupId ?? null}::UUID, ${input.assignedPartnerId ?? null}::UUID,
      ${input.assignedManagerId ?? null}::UUID,
      ${input.billingModel}, ${input.status}, ${input.linkCustomerId ?? null}::UUID
    ) RETURNING *
  `) as DbRow[];

  log.info('Created practice client', { id: rows[0]?.id, companyId }, 'practice');
  return mapClient(rows[0]!);
}

export async function updatePracticeClient(
  companyId: string,
  id: string,
  input: Partial<PracticeClientInput>,
): Promise<PracticeClient> {
  const existing = (await sql`
    SELECT id FROM practice_clients WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!existing.length) throw new Error('not found');

  const rows = (await sql`
    UPDATE practice_clients SET
      legal_name          = COALESCE(${input.legalName ?? null}, legal_name),
      trading_name        = COALESCE(${input.tradingName ?? null}, trading_name),
      registration_no     = COALESCE(${input.registrationNo ?? null}, registration_no),
      tax_no              = COALESCE(${input.taxNo ?? null}, tax_no),
      client_group_id     = COALESCE(${input.clientGroupId ?? null}::UUID, client_group_id),
      assigned_partner_id = COALESCE(${input.assignedPartnerId ?? null}::UUID, assigned_partner_id),
      assigned_manager_id = COALESCE(${input.assignedManagerId ?? null}::UUID, assigned_manager_id),
      billing_model       = COALESCE(${input.billingModel ?? null}, billing_model),
      status              = COALESCE(${input.status ?? null}, status),
      link_customer_id    = COALESCE(${input.linkCustomerId ?? null}::UUID, link_customer_id),
      updated_at          = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
    RETURNING *
  `) as DbRow[];

  log.info('Updated practice client', { id }, 'practice');
  return mapClient(rows[0]!);
}

export async function deletePracticeClient(companyId: string, id: string): Promise<void> {
  const existing = (await sql`
    SELECT id FROM practice_clients WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!existing.length) throw new Error('not found');

  await sql`
    UPDATE practice_clients SET status = 'archived', updated_at = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `;
  log.info('Archived practice client', { id }, 'practice');
}

export async function listClientGroups(companyId: string): Promise<ClientGroup[]> {
  const rows = (await sql`
    SELECT * FROM practice_client_groups
    WHERE company_id = ${companyId}::UUID
    ORDER BY name ASC
  `) as DbRow[];
  return rows.map(mapGroup);
}

export async function createClientGroup(
  companyId: string,
  input: { name: string; description?: string },
): Promise<ClientGroup> {
  const rows = (await sql`
    INSERT INTO practice_client_groups (company_id, name, description)
    VALUES (${companyId}::UUID, ${input.name}, ${input.description ?? null})
    RETURNING *
  `) as DbRow[];
  log.info('Created client group', { id: rows[0]?.id }, 'practice');
  return mapGroup(rows[0]!);
}

export async function listClientContacts(companyId: string, clientId: string): Promise<ClientContact[]> {
  const rows = (await sql`
    SELECT * FROM practice_client_contacts
    WHERE company_id = ${companyId}::UUID AND client_id = ${clientId}::UUID
    ORDER BY is_primary DESC, name ASC
  `) as DbRow[];
  return rows.map(mapContact);
}

export async function createClientContact(
  companyId: string,
  clientId: string,
  input: { name: string; email?: string; phone?: string; role?: string; isPrimary?: boolean },
): Promise<ClientContact> {
  const rows = (await sql`
    INSERT INTO practice_client_contacts (company_id, client_id, name, email, phone, role, is_primary)
    VALUES (
      ${companyId}::UUID, ${clientId}::UUID, ${input.name},
      ${input.email ?? null}, ${input.phone ?? null}, ${input.role ?? null},
      ${input.isPrimary ?? false}
    ) RETURNING *
  `) as DbRow[];
  return mapContact(rows[0]!);
}

export async function deleteClientContact(companyId: string, contactId: string): Promise<void> {
  await sql`
    DELETE FROM practice_client_contacts
    WHERE id = ${contactId}::UUID AND company_id = ${companyId}::UUID
  `;
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
bun run test:unit tests/unit/services/practice/practiceClientService.test.ts
```

Expected: all 12 tests pass.

- [ ] **Step 5: Type-check**

```bash
bunx tsc --noEmit 2>&1 | grep practice
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add tests/unit/services/practice/practiceClientService.test.ts \
        src/modules/accounting/services/practice/practiceClientService.ts
git commit -m "feat(practice): practiceClientService — TDD, CRUD + groups + contacts"
```

---

## Task 7: practiceJobCategoryService — Tests First

**Files:**
- Create: `tests/unit/services/practice/practiceJobCategoryService.test.ts`
- Create: `src/modules/accounting/services/practice/practiceJobCategoryService.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/services/practice/practiceJobCategoryService.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import {
  listJobCategories,
  createJobCategory,
  updateJobCategory,
  deleteJobCategory,
  listWorkItems,
  createWorkItem,
  updateWorkItem,
  seedDefaultCategories,
} from '@/modules/accounting/services/practice/practiceJobCategoryService';

const COMPANY = 'aaaaaaaa-0000-0000-0000-000000000001';
const CAT_ID  = 'bbbbbbbb-0000-0000-0000-000000000002';
const ITEM_ID = 'cccccccc-0000-0000-0000-000000000003';

const catRow = {
  id: CAT_ID, company_id: COMPANY, name: 'Payroll',
  sort_order: 1, is_active: true, reporting_tag: 'payroll',
  created_at: new Date(), updated_at: new Date(),
};
const itemRow = {
  id: ITEM_ID, company_id: COMPANY, category_id: CAT_ID,
  name: 'Monthly Processing', sort_order: 1, is_active: true,
  default_billable: true, default_rate_override: null,
  created_at: new Date(), updated_at: new Date(),
};

beforeEach(() => vi.clearAllMocks());

describe('listJobCategories', () => {
  it('returns mapped categories', async () => {
    sqlMock.mockResolvedValueOnce([catRow]);
    const result = await listJobCategories(COMPANY);
    expect(result[0]!.name).toBe('Payroll');
    expect(result[0]!.isActive).toBe(true);
  });
});

describe('createJobCategory', () => {
  it('inserts and returns category', async () => {
    sqlMock.mockResolvedValueOnce([catRow]);
    const result = await createJobCategory(COMPANY, { name: 'Payroll', sortOrder: 1 });
    expect(result.id).toBe(CAT_ID);
  });
});

describe('updateJobCategory', () => {
  it('updates and returns category', async () => {
    const updated = { ...catRow, name: 'Payroll & HR' };
    sqlMock.mockResolvedValueOnce([catRow]).mockResolvedValueOnce([updated]);
    const result = await updateJobCategory(COMPANY, CAT_ID, { name: 'Payroll & HR' });
    expect(result.name).toBe('Payroll & HR');
  });

  it('throws when not found', async () => {
    sqlMock.mockResolvedValueOnce([]);
    await expect(updateJobCategory(COMPANY, CAT_ID, {})).rejects.toThrow('not found');
  });
});

describe('deleteJobCategory', () => {
  it('soft-deletes (sets is_active = false)', async () => {
    sqlMock.mockResolvedValueOnce([catRow]).mockResolvedValueOnce([]);
    await expect(deleteJobCategory(COMPANY, CAT_ID)).resolves.toBeUndefined();
  });
});

describe('listWorkItems', () => {
  it('returns work items for category', async () => {
    sqlMock.mockResolvedValueOnce([itemRow]);
    const result = await listWorkItems(COMPANY, CAT_ID);
    expect(result[0]!.name).toBe('Monthly Processing');
    expect(result[0]!.defaultBillable).toBe(true);
  });

  it('returns all active work items when no categoryId given', async () => {
    sqlMock.mockResolvedValueOnce([itemRow]);
    const result = await listWorkItems(COMPANY);
    expect(result).toHaveLength(1);
  });
});

describe('createWorkItem', () => {
  it('inserts and returns work item', async () => {
    sqlMock.mockResolvedValueOnce([itemRow]);
    const result = await createWorkItem(COMPANY, CAT_ID, { name: 'Monthly Processing' });
    expect(result.id).toBe(ITEM_ID);
    expect(result.categoryId).toBe(CAT_ID);
  });
});

describe('updateWorkItem', () => {
  it('updates work item', async () => {
    const updated = { ...itemRow, name: 'Monthly Payroll Run' };
    sqlMock.mockResolvedValueOnce([itemRow]).mockResolvedValueOnce([updated]);
    const result = await updateWorkItem(COMPANY, ITEM_ID, { name: 'Monthly Payroll Run' });
    expect(result.name).toBe('Monthly Payroll Run');
  });
});

describe('seedDefaultCategories', () => {
  it('inserts default categories from reference table when company has none', async () => {
    sqlMock.mockResolvedValueOnce([{ cnt: 0 }]).mockResolvedValueOnce([]);
    await expect(seedDefaultCategories(COMPANY)).resolves.toBeUndefined();
  });

  it('skips seeding when company already has categories', async () => {
    sqlMock.mockResolvedValueOnce([{ cnt: 3 }]);
    await expect(seedDefaultCategories(COMPANY)).resolves.toBeUndefined();
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
bun run test:unit tests/unit/services/practice/practiceJobCategoryService.test.ts
```

- [ ] **Step 3: Implement practiceJobCategoryService**

```typescript
// src/modules/accounting/services/practice/practiceJobCategoryService.ts
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';

export interface JobCategory {
  id: string;
  companyId: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  reportingTag: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkItem {
  id: string;
  companyId: string;
  categoryId: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  defaultBillable: boolean;
  defaultRateOverride: number | null;
  createdAt: string;
  updatedAt: string;
}

function mapCategory(r: DbRow): JobCategory {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    name: String(r.name),
    sortOrder: Number(r.sort_order),
    isActive: Boolean(r.is_active),
    reportingTag: r.reporting_tag ? String(r.reporting_tag) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function mapWorkItem(r: DbRow): WorkItem {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    categoryId: String(r.category_id),
    name: String(r.name),
    sortOrder: Number(r.sort_order),
    isActive: Boolean(r.is_active),
    defaultBillable: Boolean(r.default_billable),
    defaultRateOverride: r.default_rate_override != null ? Number(r.default_rate_override) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export async function listJobCategories(companyId: string, includeInactive = false): Promise<JobCategory[]> {
  const rows = (await sql`
    SELECT * FROM practice_job_categories
    WHERE company_id = ${companyId}::UUID
      ${includeInactive ? sql`` : sql`AND is_active = true`}
    ORDER BY sort_order ASC, name ASC
  `) as DbRow[];
  return rows.map(mapCategory);
}

export async function createJobCategory(
  companyId: string,
  input: { name: string; sortOrder?: number; reportingTag?: string },
): Promise<JobCategory> {
  const rows = (await sql`
    INSERT INTO practice_job_categories (company_id, name, sort_order, reporting_tag)
    VALUES (${companyId}::UUID, ${input.name}, ${input.sortOrder ?? 0}, ${input.reportingTag ?? null})
    RETURNING *
  `) as DbRow[];
  log.info('Created job category', { id: rows[0]?.id }, 'practice');
  return mapCategory(rows[0]!);
}

export async function updateJobCategory(
  companyId: string,
  id: string,
  input: { name?: string; sortOrder?: number; isActive?: boolean; reportingTag?: string },
): Promise<JobCategory> {
  const existing = (await sql`
    SELECT id FROM practice_job_categories WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!existing.length) throw new Error('not found');

  const rows = (await sql`
    UPDATE practice_job_categories SET
      name          = COALESCE(${input.name ?? null}, name),
      sort_order    = COALESCE(${input.sortOrder ?? null}, sort_order),
      is_active     = COALESCE(${input.isActive ?? null}, is_active),
      reporting_tag = COALESCE(${input.reportingTag ?? null}, reporting_tag),
      updated_at    = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
    RETURNING *
  `) as DbRow[];
  return mapCategory(rows[0]!);
}

export async function deleteJobCategory(companyId: string, id: string): Promise<void> {
  const existing = (await sql`
    SELECT id FROM practice_job_categories WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!existing.length) throw new Error('not found');

  await sql`
    UPDATE practice_job_categories SET is_active = false, updated_at = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `;
  log.info('Deactivated job category', { id }, 'practice');
}

export async function listWorkItems(companyId: string, categoryId?: string, includeInactive = false): Promise<WorkItem[]> {
  const rows = (await sql`
    SELECT * FROM practice_work_items
    WHERE company_id = ${companyId}::UUID
      ${categoryId ? sql`AND category_id = ${categoryId}::UUID` : sql``}
      ${includeInactive ? sql`` : sql`AND is_active = true`}
    ORDER BY sort_order ASC, name ASC
  `) as DbRow[];
  return rows.map(mapWorkItem);
}

export async function createWorkItem(
  companyId: string,
  categoryId: string,
  input: { name: string; sortOrder?: number; defaultBillable?: boolean; defaultRateOverride?: number },
): Promise<WorkItem> {
  const rows = (await sql`
    INSERT INTO practice_work_items (company_id, category_id, name, sort_order, default_billable, default_rate_override)
    VALUES (
      ${companyId}::UUID, ${categoryId}::UUID, ${input.name},
      ${input.sortOrder ?? 0}, ${input.defaultBillable ?? true},
      ${input.defaultRateOverride ?? null}
    ) RETURNING *
  `) as DbRow[];
  return mapWorkItem(rows[0]!);
}

export async function updateWorkItem(
  companyId: string,
  id: string,
  input: { name?: string; sortOrder?: number; isActive?: boolean; defaultBillable?: boolean; defaultRateOverride?: number },
): Promise<WorkItem> {
  const existing = (await sql`
    SELECT id FROM practice_work_items WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!existing.length) throw new Error('not found');

  const rows = (await sql`
    UPDATE practice_work_items SET
      name                 = COALESCE(${input.name ?? null}, name),
      sort_order           = COALESCE(${input.sortOrder ?? null}, sort_order),
      is_active            = COALESCE(${input.isActive ?? null}, is_active),
      default_billable     = COALESCE(${input.defaultBillable ?? null}, default_billable),
      default_rate_override = COALESCE(${input.defaultRateOverride ?? null}, default_rate_override),
      updated_at           = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
    RETURNING *
  `) as DbRow[];
  return mapWorkItem(rows[0]!);
}

export async function seedDefaultCategories(companyId: string): Promise<void> {
  const count = (await sql`
    SELECT COUNT(*)::int AS cnt FROM practice_job_categories WHERE company_id = ${companyId}::UUID
  `) as DbRow[];
  if (Number(count[0]?.cnt) > 0) return;

  await sql`
    INSERT INTO practice_job_categories (company_id, name, sort_order, reporting_tag)
    SELECT ${companyId}::UUID, name, sort_order, reporting_tag
    FROM practice_default_categories
    ORDER BY sort_order
  `;
  log.info('Seeded default categories', { companyId }, 'practice');
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
bun run test:unit tests/unit/services/practice/practiceJobCategoryService.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add tests/unit/services/practice/practiceJobCategoryService.test.ts \
        src/modules/accounting/services/practice/practiceJobCategoryService.ts
git commit -m "feat(practice): practiceJobCategoryService — TDD, categories + work items + seed"
```

---

## Task 8: practiceStaffRateService — Tests First

**Files:**
- Create: `tests/unit/services/practice/practiceStaffRateService.test.ts`
- Create: `src/modules/accounting/services/practice/practiceStaffRateService.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/services/practice/practiceStaffRateService.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import {
  listStaffRates,
  createStaffRate,
  updateStaffRate,
  resolveRate,
  listClientRateOverrides,
  createClientRateOverride,
} from '@/modules/accounting/services/practice/practiceStaffRateService';

const COMPANY   = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER_ID   = 'bbbbbbbb-0000-0000-0000-000000000002';
const CLIENT_ID = 'cccccccc-0000-0000-0000-000000000003';
const RATE_ID   = 'dddddddd-0000-0000-0000-000000000004';

const rateRow = {
  id: RATE_ID, company_id: COMPANY, user_id: USER_ID,
  rate: '850.00', currency: 'ZAR',
  effective_from: '2026-01-01', effective_to: null,
  created_at: new Date(),
};

beforeEach(() => vi.clearAllMocks());

describe('listStaffRates', () => {
  it('returns rates for a user', async () => {
    sqlMock.mockResolvedValueOnce([rateRow]);
    const result = await listStaffRates(COMPANY, USER_ID);
    expect(result[0]!.rate).toBe(850);
    expect(result[0]!.currency).toBe('ZAR');
  });
});

describe('createStaffRate', () => {
  it('inserts and returns staff rate', async () => {
    sqlMock.mockResolvedValueOnce([rateRow]);
    const result = await createStaffRate(COMPANY, {
      userId: USER_ID, rate: 850, currency: 'ZAR', effectiveFrom: '2026-01-01',
    });
    expect(result.rate).toBe(850);
  });
});

describe('updateStaffRate', () => {
  it('updates effective_to to close a rate', async () => {
    const closed = { ...rateRow, effective_to: '2026-03-31' };
    sqlMock.mockResolvedValueOnce([rateRow]).mockResolvedValueOnce([closed]);
    const result = await updateStaffRate(COMPANY, RATE_ID, { effectiveTo: '2026-03-31' });
    expect(result.effectiveTo).toBe('2026-03-31');
  });

  it('throws when not found', async () => {
    sqlMock.mockResolvedValueOnce([]);
    await expect(updateStaffRate(COMPANY, RATE_ID, {})).rejects.toThrow('not found');
  });
});

describe('resolveRate', () => {
  it('returns client override rate when one exists', async () => {
    sqlMock.mockResolvedValueOnce([{ rate: '1200.00' }]);
    const rate = await resolveRate(COMPANY, USER_ID, CLIENT_ID, '2026-04-01');
    expect(rate).toBe(1200);
  });

  it('falls back to staff default when no client override', async () => {
    sqlMock.mockResolvedValueOnce([]).mockResolvedValueOnce([{ rate: '850.00' }]);
    const rate = await resolveRate(COMPANY, USER_ID, CLIENT_ID, '2026-04-01');
    expect(rate).toBe(850);
  });

  it('returns null when no rate configured at all', async () => {
    sqlMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const rate = await resolveRate(COMPANY, USER_ID, CLIENT_ID, '2026-04-01');
    expect(rate).toBeNull();
  });
});

describe('listClientRateOverrides', () => {
  it('returns overrides for a client', async () => {
    sqlMock.mockResolvedValueOnce([{ id: 'x', company_id: COMPANY, client_id: CLIENT_ID, user_id: USER_ID, rate: '1200.00', effective_from: '2026-01-01', effective_to: null, created_at: new Date() }]);
    const result = await listClientRateOverrides(COMPANY, CLIENT_ID);
    expect(result[0]!.rate).toBe(1200);
  });
});

describe('createClientRateOverride', () => {
  it('inserts and returns override', async () => {
    sqlMock.mockResolvedValueOnce([{ id: 'x', company_id: COMPANY, client_id: CLIENT_ID, user_id: USER_ID, rate: '1200.00', effective_from: '2026-01-01', effective_to: null, created_at: new Date() }]);
    const result = await createClientRateOverride(COMPANY, {
      clientId: CLIENT_ID, userId: USER_ID, rate: 1200, effectiveFrom: '2026-01-01',
    });
    expect(result.rate).toBe(1200);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
bun run test:unit tests/unit/services/practice/practiceStaffRateService.test.ts
```

- [ ] **Step 3: Implement practiceStaffRateService**

```typescript
// src/modules/accounting/services/practice/practiceStaffRateService.ts
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';

export interface StaffRate {
  id: string;
  companyId: string;
  userId: string;
  rate: number;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
}

export interface ClientRateOverride {
  id: string;
  companyId: string;
  clientId: string;
  userId: string;
  rate: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
}

function mapRate(r: DbRow): StaffRate {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    userId: String(r.user_id),
    rate: Number(r.rate),
    currency: String(r.currency),
    effectiveFrom: String(r.effective_from),
    effectiveTo: r.effective_to ? String(r.effective_to) : null,
    createdAt: String(r.created_at),
  };
}

function mapOverride(r: DbRow): ClientRateOverride {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    clientId: String(r.client_id),
    userId: String(r.user_id),
    rate: Number(r.rate),
    effectiveFrom: String(r.effective_from),
    effectiveTo: r.effective_to ? String(r.effective_to) : null,
    createdAt: String(r.created_at),
  };
}

export async function listStaffRates(companyId: string, userId: string): Promise<StaffRate[]> {
  const rows = (await sql`
    SELECT * FROM practice_staff_rates
    WHERE company_id = ${companyId}::UUID AND user_id = ${userId}::UUID
    ORDER BY effective_from DESC
  `) as DbRow[];
  return rows.map(mapRate);
}

export async function createStaffRate(
  companyId: string,
  input: { userId: string; rate: number; currency?: string; effectiveFrom: string; effectiveTo?: string },
): Promise<StaffRate> {
  const rows = (await sql`
    INSERT INTO practice_staff_rates (company_id, user_id, rate, currency, effective_from, effective_to)
    VALUES (
      ${companyId}::UUID, ${input.userId}::UUID, ${input.rate},
      ${input.currency ?? 'ZAR'}, ${input.effectiveFrom}::DATE,
      ${input.effectiveTo ?? null}::DATE
    ) RETURNING *
  `) as DbRow[];
  log.info('Created staff rate', { id: rows[0]?.id, userId: input.userId }, 'practice');
  return mapRate(rows[0]!);
}

export async function updateStaffRate(
  companyId: string,
  id: string,
  input: { effectiveTo?: string; rate?: number },
): Promise<StaffRate> {
  const existing = (await sql`
    SELECT id FROM practice_staff_rates WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!existing.length) throw new Error('not found');

  const rows = (await sql`
    UPDATE practice_staff_rates SET
      rate         = COALESCE(${input.rate ?? null}, rate),
      effective_to = COALESCE(${input.effectiveTo ?? null}::DATE, effective_to)
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
    RETURNING *
  `) as DbRow[];
  return mapRate(rows[0]!);
}

export async function resolveRate(
  companyId: string,
  userId: string,
  clientId: string,
  onDate: string,
): Promise<number | null> {
  // Priority 1: client override
  const override = (await sql`
    SELECT rate FROM practice_client_rate_overrides
    WHERE company_id = ${companyId}::UUID
      AND user_id    = ${userId}::UUID
      AND client_id  = ${clientId}::UUID
      AND effective_from <= ${onDate}::DATE
      AND (effective_to IS NULL OR effective_to >= ${onDate}::DATE)
    ORDER BY effective_from DESC
    LIMIT 1
  `) as DbRow[];
  if (override.length) return Number(override[0]!.rate);

  // Priority 2: staff default
  const staff = (await sql`
    SELECT rate FROM practice_staff_rates
    WHERE company_id   = ${companyId}::UUID
      AND user_id      = ${userId}::UUID
      AND effective_from <= ${onDate}::DATE
      AND (effective_to IS NULL OR effective_to >= ${onDate}::DATE)
    ORDER BY effective_from DESC
    LIMIT 1
  `) as DbRow[];
  if (staff.length) return Number(staff[0]!.rate);

  return null;
}

export async function listClientRateOverrides(companyId: string, clientId: string): Promise<ClientRateOverride[]> {
  const rows = (await sql`
    SELECT * FROM practice_client_rate_overrides
    WHERE company_id = ${companyId}::UUID AND client_id = ${clientId}::UUID
    ORDER BY effective_from DESC
  `) as DbRow[];
  return rows.map(mapOverride);
}

export async function createClientRateOverride(
  companyId: string,
  input: { clientId: string; userId: string; rate: number; effectiveFrom: string; effectiveTo?: string },
): Promise<ClientRateOverride> {
  const rows = (await sql`
    INSERT INTO practice_client_rate_overrides (company_id, client_id, user_id, rate, effective_from, effective_to)
    VALUES (
      ${companyId}::UUID, ${input.clientId}::UUID, ${input.userId}::UUID,
      ${input.rate}, ${input.effectiveFrom}::DATE, ${input.effectiveTo ?? null}::DATE
    ) RETURNING *
  `) as DbRow[];
  return mapOverride(rows[0]!);
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
bun run test:unit tests/unit/services/practice/practiceStaffRateService.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add tests/unit/services/practice/practiceStaffRateService.test.ts \
        src/modules/accounting/services/practice/practiceStaffRateService.ts
git commit -m "feat(practice): practiceStaffRateService — TDD, rate history + client overrides + resolve"
```

---

## Task 9: API Routes — Clients & Groups

**Files:**
- Create: `pages/api/accounting/practice/clients.ts`
- Create: `pages/api/accounting/practice/clients/[id].ts`
- Create: `pages/api/accounting/practice/client-groups.ts`
- Create: `pages/api/accounting/practice/client-contacts.ts`
- Create: `pages/api/accounting/practice/client-contacts/[id].ts`

- [ ] **Step 1: Write clients.ts (list + create)**

```typescript
// pages/api/accounting/practice/clients.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withCompany } from '@/lib/withCompany';
import { withErrorHandler } from '@/lib/withErrorHandler';
import { apiResponse } from '@/lib/apiResponse';
import { listPracticeClients, createPracticeClient } from '@/modules/accounting/services/practice/practiceClientService';
import { seedDefaultCategories } from '@/modules/accounting/services/practice/practiceJobCategoryService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const companyId = (req as NextApiRequest & { companyId: string }).companyId;

  if (req.method === 'GET') {
    const { status, search, groupId, limit, offset } = req.query;
    const result = await listPracticeClients(companyId, {
      status: status as string | undefined,
      search: search as string | undefined,
      groupId: groupId as string | undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    return apiResponse.success(res, result);
  }

  if (req.method === 'POST') {
    const { legalName, tradingName, registrationNo, taxNo, clientGroupId,
            assignedPartnerId, assignedManagerId, billingModel, status, linkCustomerId } = req.body;
    if (!legalName) return apiResponse.badRequest(res, 'legalName is required');
    if (!billingModel) return apiResponse.badRequest(res, 'billingModel is required');
    if (!status) return apiResponse.badRequest(res, 'status is required');

    const client = await createPracticeClient(companyId, {
      legalName, tradingName, registrationNo, taxNo,
      clientGroupId, assignedPartnerId, assignedManagerId,
      billingModel, status, linkCustomerId,
    });

    // On first client creation, seed default categories if none exist
    await seedDefaultCategories(companyId);

    return apiResponse.success(res, client, 201);
  }

  return apiResponse.badRequest(res, 'Method not allowed');
}

export default withCompany(withErrorHandler(handler as never));
```

- [ ] **Step 2: Write clients/[id].ts (get + update + delete)**

```typescript
// pages/api/accounting/practice/clients/[id].ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withCompany } from '@/lib/withCompany';
import { withErrorHandler } from '@/lib/withErrorHandler';
import { apiResponse } from '@/lib/apiResponse';
import {
  getPracticeClient,
  updatePracticeClient,
  deletePracticeClient,
} from '@/modules/accounting/services/practice/practiceClientService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const companyId = (req as NextApiRequest & { companyId: string }).companyId;
  const id = req.query.id as string;

  if (req.method === 'GET') {
    const client = await getPracticeClient(companyId, id);
    if (!client) return apiResponse.notFound(res, 'Client not found');
    return apiResponse.success(res, client);
  }

  if (req.method === 'PUT') {
    const client = await updatePracticeClient(companyId, id, req.body);
    return apiResponse.success(res, client);
  }

  if (req.method === 'DELETE') {
    await deletePracticeClient(companyId, id);
    return apiResponse.success(res, { ok: true });
  }

  return apiResponse.badRequest(res, 'Method not allowed');
}

export default withCompany(withErrorHandler(handler as never));
```

- [ ] **Step 3: Write client-groups.ts**

```typescript
// pages/api/accounting/practice/client-groups.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withCompany } from '@/lib/withCompany';
import { withErrorHandler } from '@/lib/withErrorHandler';
import { apiResponse } from '@/lib/apiResponse';
import { listClientGroups, createClientGroup } from '@/modules/accounting/services/practice/practiceClientService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const companyId = (req as NextApiRequest & { companyId: string }).companyId;

  if (req.method === 'GET') {
    const groups = await listClientGroups(companyId);
    return apiResponse.success(res, groups);
  }

  if (req.method === 'POST') {
    const { name, description } = req.body;
    if (!name) return apiResponse.badRequest(res, 'name is required');
    const group = await createClientGroup(companyId, { name, description });
    return apiResponse.success(res, group, 201);
  }

  return apiResponse.badRequest(res, 'Method not allowed');
}

export default withCompany(withErrorHandler(handler as never));
```

- [ ] **Step 4: Write client-contacts.ts and client-contacts/[id].ts**

```typescript
// pages/api/accounting/practice/client-contacts.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withCompany } from '@/lib/withCompany';
import { withErrorHandler } from '@/lib/withErrorHandler';
import { apiResponse } from '@/lib/apiResponse';
import { listClientContacts, createClientContact } from '@/modules/accounting/services/practice/practiceClientService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const companyId = (req as NextApiRequest & { companyId: string }).companyId;

  if (req.method === 'GET') {
    const clientId = req.query.clientId as string;
    if (!clientId) return apiResponse.badRequest(res, 'clientId query param required');
    const contacts = await listClientContacts(companyId, clientId);
    return apiResponse.success(res, contacts);
  }

  if (req.method === 'POST') {
    const { clientId, name, email, phone, role, isPrimary } = req.body;
    if (!clientId) return apiResponse.badRequest(res, 'clientId is required');
    if (!name) return apiResponse.badRequest(res, 'name is required');
    const contact = await createClientContact(companyId, clientId, { name, email, phone, role, isPrimary });
    return apiResponse.success(res, contact, 201);
  }

  return apiResponse.badRequest(res, 'Method not allowed');
}

export default withCompany(withErrorHandler(handler as never));
```

```typescript
// pages/api/accounting/practice/client-contacts/[id].ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withCompany } from '@/lib/withCompany';
import { withErrorHandler } from '@/lib/withErrorHandler';
import { apiResponse } from '@/lib/apiResponse';
import { deleteClientContact } from '@/modules/accounting/services/practice/practiceClientService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const companyId = (req as NextApiRequest & { companyId: string }).companyId;
  const id = req.query.id as string;

  if (req.method === 'DELETE') {
    await deleteClientContact(companyId, id);
    return apiResponse.success(res, { ok: true });
  }

  return apiResponse.badRequest(res, 'Method not allowed');
}

export default withCompany(withErrorHandler(handler as never));
```

- [ ] **Step 5: Type-check**

```bash
bunx tsc --noEmit 2>&1 | grep "practice/client"
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add pages/api/accounting/practice/clients.ts \
        pages/api/accounting/practice/clients/[id].ts \
        pages/api/accounting/practice/client-groups.ts \
        pages/api/accounting/practice/client-contacts.ts \
        pages/api/accounting/practice/client-contacts/[id].ts
git commit -m "feat(practice): API routes — clients, groups, contacts"
```

---

## Task 10: API Routes — Job Categories, Work Items, Staff Rates

**Files:**
- Create: `pages/api/accounting/practice/job-categories.ts`
- Create: `pages/api/accounting/practice/job-categories/[id].ts`
- Create: `pages/api/accounting/practice/work-items.ts`
- Create: `pages/api/accounting/practice/work-items/[id].ts`
- Create: `pages/api/accounting/practice/staff-rates.ts`
- Create: `pages/api/accounting/practice/staff-rates/[id].ts`
- Create: `pages/api/accounting/practice/rate-resolve.ts`

- [ ] **Step 1: Write job-categories.ts**

```typescript
// pages/api/accounting/practice/job-categories.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withCompany } from '@/lib/withCompany';
import { withErrorHandler } from '@/lib/withErrorHandler';
import { apiResponse } from '@/lib/apiResponse';
import { listJobCategories, createJobCategory } from '@/modules/accounting/services/practice/practiceJobCategoryService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const companyId = (req as NextApiRequest & { companyId: string }).companyId;

  if (req.method === 'GET') {
    const includeInactive = req.query.includeInactive === 'true';
    const categories = await listJobCategories(companyId, includeInactive);
    return apiResponse.success(res, categories);
  }

  if (req.method === 'POST') {
    const { name, sortOrder, reportingTag } = req.body;
    if (!name) return apiResponse.badRequest(res, 'name is required');
    const cat = await createJobCategory(companyId, { name, sortOrder, reportingTag });
    return apiResponse.success(res, cat, 201);
  }

  return apiResponse.badRequest(res, 'Method not allowed');
}

export default withCompany(withErrorHandler(handler as never));
```

- [ ] **Step 2: Write job-categories/[id].ts**

```typescript
// pages/api/accounting/practice/job-categories/[id].ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withCompany } from '@/lib/withCompany';
import { withErrorHandler } from '@/lib/withErrorHandler';
import { apiResponse } from '@/lib/apiResponse';
import { updateJobCategory, deleteJobCategory } from '@/modules/accounting/services/practice/practiceJobCategoryService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const companyId = (req as NextApiRequest & { companyId: string }).companyId;
  const id = req.query.id as string;

  if (req.method === 'PUT') {
    const cat = await updateJobCategory(companyId, id, req.body);
    return apiResponse.success(res, cat);
  }

  if (req.method === 'DELETE') {
    await deleteJobCategory(companyId, id);
    return apiResponse.success(res, { ok: true });
  }

  return apiResponse.badRequest(res, 'Method not allowed');
}

export default withCompany(withErrorHandler(handler as never));
```

- [ ] **Step 3: Write work-items.ts and work-items/[id].ts**

```typescript
// pages/api/accounting/practice/work-items.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withCompany } from '@/lib/withCompany';
import { withErrorHandler } from '@/lib/withErrorHandler';
import { apiResponse } from '@/lib/apiResponse';
import { listWorkItems, createWorkItem } from '@/modules/accounting/services/practice/practiceJobCategoryService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const companyId = (req as NextApiRequest & { companyId: string }).companyId;

  if (req.method === 'GET') {
    const { categoryId, includeInactive } = req.query;
    const items = await listWorkItems(
      companyId,
      categoryId as string | undefined,
      includeInactive === 'true',
    );
    return apiResponse.success(res, items);
  }

  if (req.method === 'POST') {
    const { categoryId, name, sortOrder, defaultBillable, defaultRateOverride } = req.body;
    if (!categoryId) return apiResponse.badRequest(res, 'categoryId is required');
    if (!name) return apiResponse.badRequest(res, 'name is required');
    const item = await createWorkItem(companyId, categoryId, { name, sortOrder, defaultBillable, defaultRateOverride });
    return apiResponse.success(res, item, 201);
  }

  return apiResponse.badRequest(res, 'Method not allowed');
}

export default withCompany(withErrorHandler(handler as never));
```

```typescript
// pages/api/accounting/practice/work-items/[id].ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withCompany } from '@/lib/withCompany';
import { withErrorHandler } from '@/lib/withErrorHandler';
import { apiResponse } from '@/lib/apiResponse';
import { updateWorkItem } from '@/modules/accounting/services/practice/practiceJobCategoryService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const companyId = (req as NextApiRequest & { companyId: string }).companyId;
  const id = req.query.id as string;

  if (req.method === 'PUT') {
    const item = await updateWorkItem(companyId, id, req.body);
    return apiResponse.success(res, item);
  }

  return apiResponse.badRequest(res, 'Method not allowed');
}

export default withCompany(withErrorHandler(handler as never));
```

- [ ] **Step 4: Write staff-rates.ts, staff-rates/[id].ts, rate-resolve.ts**

```typescript
// pages/api/accounting/practice/staff-rates.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withCompany } from '@/lib/withCompany';
import { withErrorHandler } from '@/lib/withErrorHandler';
import { apiResponse } from '@/lib/apiResponse';
import { listStaffRates, createStaffRate } from '@/modules/accounting/services/practice/practiceStaffRateService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const companyId = (req as NextApiRequest & { companyId: string }).companyId;

  if (req.method === 'GET') {
    const userId = req.query.userId as string;
    if (!userId) return apiResponse.badRequest(res, 'userId query param required');
    const rates = await listStaffRates(companyId, userId);
    return apiResponse.success(res, rates);
  }

  if (req.method === 'POST') {
    const { userId, rate, currency, effectiveFrom, effectiveTo } = req.body;
    if (!userId) return apiResponse.badRequest(res, 'userId is required');
    if (rate == null) return apiResponse.badRequest(res, 'rate is required');
    if (!effectiveFrom) return apiResponse.badRequest(res, 'effectiveFrom is required');
    const r = await createStaffRate(companyId, { userId, rate: Number(rate), currency, effectiveFrom, effectiveTo });
    return apiResponse.success(res, r, 201);
  }

  return apiResponse.badRequest(res, 'Method not allowed');
}

export default withCompany(withErrorHandler(handler as never));
```

```typescript
// pages/api/accounting/practice/staff-rates/[id].ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withCompany } from '@/lib/withCompany';
import { withErrorHandler } from '@/lib/withErrorHandler';
import { apiResponse } from '@/lib/apiResponse';
import { updateStaffRate } from '@/modules/accounting/services/practice/practiceStaffRateService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const companyId = (req as NextApiRequest & { companyId: string }).companyId;
  const id = req.query.id as string;

  if (req.method === 'PUT') {
    const r = await updateStaffRate(companyId, id, req.body);
    return apiResponse.success(res, r);
  }

  return apiResponse.badRequest(res, 'Method not allowed');
}

export default withCompany(withErrorHandler(handler as never));
```

```typescript
// pages/api/accounting/practice/rate-resolve.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withCompany } from '@/lib/withCompany';
import { withErrorHandler } from '@/lib/withErrorHandler';
import { apiResponse } from '@/lib/apiResponse';
import { resolveRate } from '@/modules/accounting/services/practice/practiceStaffRateService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const companyId = (req as NextApiRequest & { companyId: string }).companyId;

  if (req.method !== 'GET') return apiResponse.badRequest(res, 'Method not allowed');

  const { userId, clientId, date } = req.query;
  if (!userId || !clientId || !date) {
    return apiResponse.badRequest(res, 'userId, clientId, and date are required');
  }

  const rate = await resolveRate(companyId, userId as string, clientId as string, date as string);
  return apiResponse.success(res, { rate });
}

export default withCompany(withErrorHandler(handler as never));
```

- [ ] **Step 5: Type-check all new API routes**

```bash
bunx tsc --noEmit 2>&1 | grep "practice/"
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add pages/api/accounting/practice/
git commit -m "feat(practice): API routes — job categories, work items, staff rates, rate-resolve"
```

---

## Task 11: Practice Nav Section

**Files:**
- Create: `src/components/accounting/navSections/practice.ts`
- Modify: `src/components/accounting/accountingNavConfig.ts`

- [ ] **Step 1: Write practice.ts nav section**

```typescript
// src/components/accounting/navSections/practice.ts
import type { Tab } from './types';

export const practiceTab: Tab = {
  id: 'practice',
  label: 'Practice',
  topItems: [
    { label: 'Add a Client', href: '/accounting/practice/clients/new' },
  ],
  items: [
    {
      section: 'Clients',
      items: [
        { label: 'Client List', href: '/accounting/practice/clients' },
        { label: 'Client Groups', href: '/accounting/practice/clients?view=groups' },
      ],
    },
    {
      section: 'Time Entry',
      items: [
        { label: 'Enter Time', href: '/accounting/time-tracking' },
        { label: 'My Timesheet', href: '/accounting/timesheets' },
      ],
    },
    {
      section: 'Jobs & Tasks',
      items: [
        { label: 'Jobs', href: '/accounting/practice/jobs' },
        { label: 'Tasks', href: '/accounting/practice/tasks' },
      ],
    },
    {
      section: 'WIP & Billing',
      items: [
        { label: 'WIP Board', href: '/accounting/practice/wip' },
        { label: 'Generate Invoice', href: '/accounting/practice/wip?action=invoice' },
      ],
    },
    {
      section: 'Admin',
      items: [
        { label: 'Job Categories', href: '/accounting/practice/job-categories' },
        { label: 'Staff Rates', href: '/accounting/practice/staff-rates' },
      ],
    },
    {
      section: 'Reports',
      items: [
        { label: 'Staff Utilisation', href: '/accounting/practice/reports/utilisation' },
        { label: 'Client Profitability', href: '/accounting/practice/reports/profitability' },
        { label: 'WIP Aging', href: '/accounting/practice/reports/wip-aging' },
      ],
    },
  ],
};
```

- [ ] **Step 2: Add practiceTab to accountingNavConfig.ts**

In `src/components/accounting/accountingNavConfig.ts`, add after the existing imports:

```typescript
import { practiceTab } from './navSections/practice';
```

And in the `TABS` array, add `practiceTab` after `payrollTab`:

```typescript
export const TABS: Tab[] = [
  { id: 'dashboard', label: 'Dashboard', href: '/accounting' },
  salesTab,
  purchasesTab,
  inventoryTab,
  bankingTab,
  accountingTab,
  reportsTab,
  taxTab,
  payrollTab,
  practiceTab,
];
```

- [ ] **Step 3: Type-check**

```bash
bunx tsc --noEmit 2>&1 | grep "navSections/practice\|accountingNavConfig"
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/accounting/navSections/practice.ts \
        src/components/accounting/accountingNavConfig.ts
git commit -m "feat(practice): add Practice tab to main navigation"
```

---

## Task 12: Practice Clients UI — List Page

**Files:**
- Create: `pages/accounting/practice/clients/index.tsx`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p pages/accounting/practice/clients
mkdir -p pages/accounting/practice/job-categories
```

- [ ] **Step 2: Write the clients list page**

```tsx
// pages/accounting/practice/clients/index.tsx
import { useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import AppLayout from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { useEffect } from 'react';
import type { PracticeClient } from '@/modules/accounting/services/practice/practiceClientService';

const STATUS_LABELS: Record<string, string> = {
  prospect: 'Prospect', onboarding: 'Onboarding', active: 'Active',
  inactive: 'Inactive', archived: 'Archived',
};

const STATUS_COLOURS: Record<string, string> = {
  prospect: 'bg-blue-100 text-blue-700',
  onboarding: 'bg-yellow-100 text-yellow-700',
  active: 'bg-green-100 text-green-700',
  inactive: 'bg-gray-100 text-gray-600',
  archived: 'bg-red-100 text-red-600',
};

export default function PracticeClientsPage() {
  const router = useRouter();
  const [clients, setClients] = useState<PracticeClient[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('active');

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ status: statusFilter });
    if (search) params.set('search', search);
    apiFetch(`/api/accounting/practice/clients?${params}`)
      .then((data) => {
        setClients(data.clients ?? []);
        setTotal(data.total ?? 0);
      })
      .finally(() => setLoading(false));
  }, [search, statusFilter]);

  return (
    <AppLayout activeTab="practice">
      <div className="p-6 max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Practice Clients</h1>
            <p className="text-sm text-gray-500 mt-1">{total} client{total !== 1 ? 's' : ''}</p>
          </div>
          <Link
            href="/accounting/practice/clients/new"
            className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
          >
            + Add Client
          </Link>
        </div>

        <div className="flex gap-3 mb-4">
          <input
            type="search"
            placeholder="Search clients…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="">All Statuses</option>
            {Object.entries(STATUS_LABELS).map(([val, label]) => (
              <option key={val} value={val}>{label}</option>
            ))}
          </select>
        </div>

        {loading ? (
          <div className="text-center py-12 text-gray-400">Loading…</div>
        ) : clients.length === 0 ? (
          <div className="text-center py-12 text-gray-400">
            No clients found.{' '}
            <Link href="/accounting/practice/clients/new" className="text-indigo-600 hover:underline">
              Add your first client
            </Link>
          </div>
        ) : (
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Client</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Reg No</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Tax No</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Billing</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {clients.map((c) => (
                  <tr key={c.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => router.push(`/accounting/practice/clients/${c.id}`)}>
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">{c.legalName}</div>
                      {c.tradingName && <div className="text-xs text-gray-500">{c.tradingName}</div>}
                    </td>
                    <td className="px-4 py-3 text-gray-600">{c.registrationNo ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-600">{c.taxNo ?? '—'}</td>
                    <td className="px-4 py-3 capitalize text-gray-600">{c.billingModel}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOURS[c.status] ?? ''}`}>
                        {STATUS_LABELS[c.status] ?? c.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/accounting/practice/clients/${c.id}`}
                        className="text-indigo-600 hover:underline text-xs"
                        onClick={(e) => e.stopPropagation()}
                      >
                        View
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
```

- [ ] **Step 3: Type-check**

```bash
bunx tsc --noEmit 2>&1 | grep "practice/clients/index"
```

Expected: no errors.

---

## Task 13: Practice Clients UI — New & Detail Pages

**Files:**
- Create: `pages/accounting/practice/clients/new.tsx`
- Create: `pages/accounting/practice/clients/[id].tsx`

- [ ] **Step 1: Write new.tsx**

```tsx
// pages/accounting/practice/clients/new.tsx
import { useState } from 'react';
import { useRouter } from 'next/router';
import AppLayout from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';

export default function NewPracticeClientPage() {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    legalName: '',
    tradingName: '',
    registrationNo: '',
    taxNo: '',
    billingModel: 'hourly',
    status: 'active',
  });

  const set = (field: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.legalName.trim()) { setError('Legal name is required'); return; }
    setSaving(true);
    setError(null);
    try {
      await apiFetch('/api/accounting/practice/clients', { method: 'POST', body: JSON.stringify(form) });
      router.push('/accounting/practice/clients');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create client');
    } finally {
      setSaving(false);
    }
  }

  return (
    <AppLayout activeTab="practice">
      <div className="p-6 max-w-2xl mx-auto">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">Add Practice Client</h1>
        {error && <div className="mb-4 p-3 bg-red-50 text-red-700 text-sm rounded-lg">{error}</div>}
        <form onSubmit={handleSubmit} className="space-y-5 bg-white border border-gray-200 rounded-xl p-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Legal Name *</label>
            <input type="text" value={form.legalName} onChange={set('legalName')} required
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Trading Name</label>
            <input type="text" value={form.tradingName} onChange={set('tradingName')}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Registration No</label>
              <input type="text" value={form.registrationNo} onChange={set('registrationNo')}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Tax No</label>
              <input type="text" value={form.taxNo} onChange={set('taxNo')}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Billing Model</label>
              <select value={form.billingModel} onChange={set('billingModel')}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                <option value="hourly">Hourly</option>
                <option value="fixed">Fixed</option>
                <option value="retainer">Retainer</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
              <select value={form.status} onChange={set('status')}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                <option value="prospect">Prospect</option>
                <option value="onboarding">Onboarding</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>
          </div>
          <div className="flex gap-3 pt-2">
            <button type="submit" disabled={saving}
              className="px-5 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors">
              {saving ? 'Saving…' : 'Add Client'}
            </button>
            <button type="button" onClick={() => router.back()}
              className="px-5 py-2 text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors">
              Cancel
            </button>
          </div>
        </form>
      </div>
    </AppLayout>
  );
}
```

- [ ] **Step 2: Write [id].tsx (client detail)**

```tsx
// pages/accounting/practice/clients/[id].tsx
import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import AppLayout from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import type { PracticeClient, ClientContact } from '@/modules/accounting/services/practice/practiceClientService';

const STATUS_COLOURS: Record<string, string> = {
  prospect: 'bg-blue-100 text-blue-700', onboarding: 'bg-yellow-100 text-yellow-700',
  active: 'bg-green-100 text-green-700', inactive: 'bg-gray-100 text-gray-600',
  archived: 'bg-red-100 text-red-600',
};

export default function PracticeClientDetailPage() {
  const router = useRouter();
  const id = router.query.id as string;
  const [client, setClient] = useState<PracticeClient | null>(null);
  const [contacts, setContacts] = useState<ClientContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'details' | 'contacts'>('details');

  useEffect(() => {
    if (!id) return;
    Promise.all([
      apiFetch(`/api/accounting/practice/clients/${id}`),
      apiFetch(`/api/accounting/practice/client-contacts?clientId=${id}`),
    ]).then(([c, ctcts]) => {
      setClient(c);
      setContacts(ctcts);
    }).finally(() => setLoading(false));
  }, [id]);

  if (loading) return <AppLayout activeTab="practice"><div className="p-6 text-gray-400">Loading…</div></AppLayout>;
  if (!client) return <AppLayout activeTab="practice"><div className="p-6 text-red-500">Client not found</div></AppLayout>;

  return (
    <AppLayout activeTab="practice">
      <div className="p-6 max-w-4xl mx-auto">
        <div className="flex items-start justify-between mb-6">
          <div>
            <Link href="/accounting/practice/clients" className="text-sm text-indigo-600 hover:underline mb-2 block">← Practice Clients</Link>
            <h1 className="text-2xl font-bold text-gray-900">{client.legalName}</h1>
            {client.tradingName && <p className="text-gray-500 text-sm mt-0.5">{client.tradingName}</p>}
          </div>
          <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium capitalize ${STATUS_COLOURS[client.status] ?? ''}`}>
            {client.status}
          </span>
        </div>

        <div className="flex gap-1 mb-6 border-b border-gray-200">
          {(['details', 'contacts'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium capitalize border-b-2 -mb-px transition-colors ${tab === t ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
              {t}
            </button>
          ))}
        </div>

        {tab === 'details' && (
          <div className="bg-white border border-gray-200 rounded-xl p-6 grid grid-cols-2 gap-x-8 gap-y-4">
            <Field label="Registration No" value={client.registrationNo} />
            <Field label="Tax No" value={client.taxNo} />
            <Field label="Billing Model" value={client.billingModel} capitalize />
            <Field label="Client Group" value={client.clientGroupId} />
          </div>
        )}

        {tab === 'contacts' && (
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            {contacts.length === 0 ? (
              <div className="p-8 text-center text-gray-400 text-sm">No contacts yet</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Name</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Email</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Role</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Primary</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {contacts.map((c) => (
                    <tr key={c.id}>
                      <td className="px-4 py-3 font-medium text-gray-900">{c.name}</td>
                      <td className="px-4 py-3 text-gray-600">{c.email ?? '—'}</td>
                      <td className="px-4 py-3 text-gray-600">{c.role ?? '—'}</td>
                      <td className="px-4 py-3">{c.isPrimary ? '✓' : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </AppLayout>
  );
}

function Field({ label, value, capitalize }: { label: string; value: string | null | undefined; capitalize?: boolean }) {
  return (
    <div>
      <dt className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</dt>
      <dd className={`mt-1 text-sm text-gray-900 ${capitalize ? 'capitalize' : ''}`}>{value ?? '—'}</dd>
    </div>
  );
}
```

- [ ] **Step 3: Type-check**

```bash
bunx tsc --noEmit 2>&1 | grep "practice/clients"
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add pages/accounting/practice/clients/
git commit -m "feat(practice): Practice CRM UI — client list, new, detail pages"
```

---

## Task 14: Job Categories Admin UI

**Files:**
- Create: `pages/accounting/practice/job-categories/index.tsx`

- [ ] **Step 1: Write the job categories page**

```tsx
// pages/accounting/practice/job-categories/index.tsx
import { useState, useEffect } from 'react';
import AppLayout from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import type { JobCategory, WorkItem } from '@/modules/accounting/services/practice/practiceJobCategoryService';

export default function JobCategoriesPage() {
  const [categories, setCategories] = useState<JobCategory[]>([]);
  const [workItems, setWorkItems] = useState<Record<string, WorkItem[]>>({});
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [newCatName, setNewCatName] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiFetch('/api/accounting/practice/job-categories?includeInactive=true')
      .then((data) => setCategories(data))
      .finally(() => setLoading(false));
  }, []);

  async function toggleExpand(id: string) {
    if (expanded === id) { setExpanded(null); return; }
    setExpanded(id);
    if (!workItems[id]) {
      const items = await apiFetch(`/api/accounting/practice/work-items?categoryId=${id}&includeInactive=true`);
      setWorkItems((w) => ({ ...w, [id]: items }));
    }
  }

  async function addCategory() {
    if (!newCatName.trim()) return;
    setSaving(true);
    const cat = await apiFetch('/api/accounting/practice/job-categories', {
      method: 'POST', body: JSON.stringify({ name: newCatName, sortOrder: categories.length }),
    });
    setCategories((c) => [...c, cat]);
    setNewCatName('');
    setSaving(false);
  }

  async function toggleActive(cat: JobCategory) {
    const updated = await apiFetch(`/api/accounting/practice/job-categories/${cat.id}`, {
      method: 'PUT', body: JSON.stringify({ isActive: !cat.isActive }),
    });
    setCategories((cs) => cs.map((c) => c.id === cat.id ? updated : c));
  }

  return (
    <AppLayout activeTab="practice">
      <div className="p-6 max-w-4xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Job Categories</h1>
          <p className="text-sm text-gray-500 mt-1">Manage the two-level taxonomy used in time entries</p>
        </div>

        <div className="flex gap-2 mb-6">
          <input type="text" placeholder="New category name…" value={newCatName}
            onChange={(e) => setNewCatName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addCategory()}
            className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          <button onClick={addCategory} disabled={saving || !newCatName.trim()}
            className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors">
            Add
          </button>
        </div>

        {loading ? (
          <div className="text-center py-12 text-gray-400">Loading…</div>
        ) : (
          <div className="space-y-2">
            {categories.map((cat) => (
              <div key={cat.id} className={`border rounded-xl overflow-hidden ${cat.isActive ? 'border-gray-200' : 'border-gray-100 opacity-60'}`}>
                <div className="flex items-center justify-between px-4 py-3 bg-white cursor-pointer hover:bg-gray-50"
                  onClick={() => toggleExpand(cat.id)}>
                  <div className="flex items-center gap-3">
                    <span className="text-gray-400 text-xs">{expanded === cat.id ? '▼' : '▶'}</span>
                    <span className="font-medium text-gray-900 text-sm">{cat.name}</span>
                    {cat.reportingTag && (
                      <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded">{cat.reportingTag}</span>
                    )}
                  </div>
                  <button onClick={(e) => { e.stopPropagation(); toggleActive(cat); }}
                    className={`text-xs px-2 py-0.5 rounded-full ${cat.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                    {cat.isActive ? 'Active' : 'Inactive'}
                  </button>
                </div>
                {expanded === cat.id && (
                  <div className="border-t border-gray-100 bg-gray-50 px-4 py-3">
                    {(workItems[cat.id] ?? []).length === 0 ? (
                      <p className="text-xs text-gray-400">No work items yet</p>
                    ) : (
                      <ul className="space-y-1">
                        {(workItems[cat.id] ?? []).map((item) => (
                          <li key={item.id} className={`flex items-center justify-between text-sm py-1 ${item.isActive ? 'text-gray-700' : 'text-gray-400 line-through'}`}>
                            <span>{item.name}</span>
                            <span className="text-xs text-gray-400">{item.defaultBillable ? 'Billable' : 'Non-billable'}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
bunx tsc --noEmit 2>&1 | grep "practice/job-categories"
```

Expected: no errors.

- [ ] **Step 3: Run all practice tests**

```bash
bun run test:unit tests/unit/services/practice/
```

Expected: all tests pass.

- [ ] **Step 4: Full type check**

```bash
bunx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add pages/accounting/practice/job-categories/ \
        src/components/accounting/navSections/practice.ts
git commit -m "feat(practice): job categories admin UI + nav section"
```

---

## Task 15: Final Integration Check

- [ ] **Step 1: Run full test suite**

```bash
bun run test:unit
```

Expected: all existing tests still pass; new practice tests pass.

- [ ] **Step 2: Full type check**

```bash
bunx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Verify migration files exist**

```bash
ls scripts/migrations/sql/37*.sql
```

Expected:
```
scripts/migrations/sql/370_practice_clients.sql
scripts/migrations/sql/371_practice_job_taxonomy.sql
scripts/migrations/sql/372_practice_staff_rates.sql
scripts/migrations/sql/373_time_entries_enhance.sql
scripts/migrations/sql/374_practice_seed_categories.sql
```

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat(practice): Phase 1 complete — migrations 370-374, CRM, job taxonomy, staff rates, API, UI, nav"
```

---

## Self-Review Against Spec

| Spec requirement | Task covering it |
|---|---|
| `practice_clients` table with all columns | Task 1 |
| `practice_client_groups` | Task 1 |
| `practice_client_contacts` | Task 1 |
| `practice_job_categories` | Task 2 |
| `practice_work_items` | Task 2 |
| `practice_staff_rates` | Task 3 |
| `practice_client_rate_overrides` | Task 3 |
| ALTER `time_entries` with practice columns | Task 4 |
| Status widened: billed / not_billable / leave | Task 4 |
| Seed default SA categories | Task 5 |
| CRUD API for all foundation entities | Tasks 9–10 |
| Rate resolution (client override → staff default) | Task 8 + Task 10 |
| Duplicate detection on client create | Task 6 (service) + Task 9 (API) |
| Practice nav tab with all sections | Task 11 |
| Practice CRM list page | Task 12 |
| Practice CRM new client page | Task 13 |
| Practice CRM client detail + contacts | Task 13 |
| Job categories admin UI | Task 14 |
| TDD — tests before implementation | Tasks 6–8 |
| IF NOT EXISTS on all DDL | Tasks 1–5 |
| Migration range 370–374 | Tasks 1–5 |
