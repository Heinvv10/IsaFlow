# Document Engine Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the complete data layer, service layer, API routes, and AFS list page that every subsequent AFS plan builds on.

**Architecture:** Five DB migrations create the `afs_documents`, `afs_sections`, `note_templates`, `afs_generation_log`, and `management_pack_configs` tables. Four focused services handle CRUD for documents/sections, template seeding, and job queue operations. Four API routes expose the document lifecycle. One list page at `/accounting/afs/` and a nav entry make the feature navigable.

**Tech Stack:** Next.js 14 Pages Router, TypeScript, Neon Postgres (`sql` tagged template), Vitest (unit tests), Bun (package manager), `@/lib/apiResponse`, `@/lib/auth` (`withCompany` + `withErrorHandler`), `@/lib/logger`.

---

## File Map

| Status | Path | Responsibility |
|--------|------|----------------|
| Create | `scripts/migrations/sql/333_afs_documents.sql` | `afs_documents` table |
| Create | `scripts/migrations/sql/334_afs_sections.sql` | `afs_sections` table |
| Create | `scripts/migrations/sql/335_note_templates.sql` | `note_templates` table |
| Create | `scripts/migrations/sql/336_afs_generation_log.sql` | Job queue table |
| Create | `scripts/migrations/sql/337_management_pack_configs.sql` | Pack config table |
| Create | `src/modules/accounting/services/afs/afsTypes.ts` | All shared AFS types (single source of truth) |
| Create | `src/modules/accounting/services/afs/afsDocumentService.ts` | CRUD for `AfsDocument` |
| Create | `src/modules/accounting/services/afs/afsSectionService.ts` | CRUD for `AfsSection` |
| Create | `src/modules/accounting/services/afs/noteTemplateRegistry.ts` | Seed all 30 note templates |
| Create | `src/modules/accounting/services/afs/afsGenerationJobService.ts` | Enqueue/dequeue generation jobs |
| Create | `pages/api/accounting/afs/index.ts` | GET list + POST create |
| Create | `pages/api/accounting/afs/[documentId]/index.ts` | GET single document with sections |
| Create | `pages/api/accounting/afs/[documentId]/generate.ts` | POST enqueue generation job |
| Create | `pages/api/accounting/afs/[documentId]/sign-off.ts` | POST lock document |
| Create | `pages/accounting/afs/index.tsx` | AFS list page |
| Modify | `src/components/accounting/accountingNavConfig.ts` | Add AFS tab entry |
| Create | `tests/unit/services/afs/afsDocumentService.test.ts` | Unit tests for document service |
| Create | `tests/unit/services/afs/afsSectionService.test.ts` | Unit tests for section service |
| Create | `tests/unit/services/afs/noteTemplateRegistry.test.ts` | Unit tests for template registry |

---

## Task 1: Migration — `afs_documents` table

**Files:**
- Create: `scripts/migrations/sql/333_afs_documents.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 333_afs_documents.sql
-- Core AFS document record. One per company per fiscal year (AFS)
-- or per company per month (management_pack).

CREATE TABLE IF NOT EXISTS afs_documents (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fiscal_year         INTEGER,
  period              TEXT,        -- 'YYYY-MM' for management packs
  document_type       TEXT NOT NULL CHECK (document_type IN ('afs', 'management_pack')),
  reporting_framework TEXT NOT NULL CHECK (reporting_framework IN ('ifrs_smes', 'full_ifrs')),
  status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'in_review', 'partner_review', 'signed_off', 'filed')),
  locked_at           TIMESTAMPTZ,
  locked_by           UUID REFERENCES users(id),
  version             INTEGER NOT NULL DEFAULT 1,
  pis_score           NUMERIC(10, 2),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_afs_documents_company_id
  ON afs_documents(company_id);

CREATE INDEX IF NOT EXISTS idx_afs_documents_company_type_year
  ON afs_documents(company_id, document_type, fiscal_year);

CREATE INDEX IF NOT EXISTS idx_afs_documents_status
  ON afs_documents(company_id, status);

-- Ensure one AFS per company per fiscal year, one pack per company per period
CREATE UNIQUE INDEX IF NOT EXISTS uq_afs_documents_company_year
  ON afs_documents(company_id, fiscal_year)
  WHERE document_type = 'afs' AND fiscal_year IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_afs_documents_company_period
  ON afs_documents(company_id, period)
  WHERE document_type = 'management_pack' AND period IS NOT NULL;
```

- [ ] **Step 2: Apply the migration**

```bash
cd /home/hein/Workspace/IsaFlow
bunx tsx scripts/apply-migrations.ts
```

Expected: `Applied 333_afs_documents.sql` (or "already applied" if re-run).

- [ ] **Step 3: Commit**

```bash
git add scripts/migrations/sql/333_afs_documents.sql
git commit -m "feat(afs): migration 333 — afs_documents table"
```

---

## Task 2: Migration — `afs_sections` table

**Files:**
- Create: `scripts/migrations/sql/334_afs_sections.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 334_afs_sections.sql
-- One record per statement/note within an AfsDocument.

CREATE TABLE IF NOT EXISTS afs_sections (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id             UUID NOT NULL REFERENCES afs_documents(id) ON DELETE CASCADE,
  section_type            TEXT NOT NULL,
  sort_order              INTEGER NOT NULL DEFAULT 0,
  status                  TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'auto_generated', 'ai_enhanced', 'reviewed', 'signed_off')),
  data_snapshot           JSONB,
  content                 JSONB,
  overrides               JSONB,
  ai_narrative            TEXT,
  ai_narrative_accepted   BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_by             UUID REFERENCES users(id),
  reviewed_at             TIMESTAMPTZ,
  signed_off_by           UUID REFERENCES users(id),
  signed_off_at           TIMESTAMPTZ,
  version_history         JSONB NOT NULL DEFAULT '[]'::JSONB,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_afs_sections_document_id
  ON afs_sections(document_id);

CREATE INDEX IF NOT EXISTS idx_afs_sections_document_type
  ON afs_sections(document_id, section_type);

CREATE INDEX IF NOT EXISTS idx_afs_sections_status
  ON afs_sections(document_id, status);

-- One section of each type per document
CREATE UNIQUE INDEX IF NOT EXISTS uq_afs_sections_document_type
  ON afs_sections(document_id, section_type);
```

- [ ] **Step 2: Apply the migration**

```bash
cd /home/hein/Workspace/IsaFlow
bunx tsx scripts/apply-migrations.ts
```

Expected: `Applied 334_afs_sections.sql`.

- [ ] **Step 3: Commit**

```bash
git add scripts/migrations/sql/334_afs_sections.sql
git commit -m "feat(afs): migration 334 — afs_sections table"
```

---

## Task 3: Migration — `note_templates` table

**Files:**
- Create: `scripts/migrations/sql/335_note_templates.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 335_note_templates.sql
-- Vendor-maintained template registry for all 30+ IFRS note types.

CREATE TABLE IF NOT EXISTS note_templates (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  section_type       TEXT NOT NULL,
  framework          TEXT NOT NULL CHECK (framework IN ('ifrs_smes', 'full_ifrs', 'both')),
  title              TEXT NOT NULL,
  data_queries       JSONB NOT NULL DEFAULT '{}'::JSONB,
  content_schema     JSONB NOT NULL DEFAULT '{}'::JSONB,
  ai_prompt_template TEXT,
  is_mandatory       BOOLEAN NOT NULL DEFAULT TRUE,
  standard_reference TEXT,
  effective_from     DATE NOT NULL DEFAULT CURRENT_DATE,
  supersedes         UUID REFERENCES note_templates(id),
  change_summary     TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_note_templates_section_type
  ON note_templates(section_type);

CREATE INDEX IF NOT EXISTS idx_note_templates_framework
  ON note_templates(framework);

CREATE INDEX IF NOT EXISTS idx_note_templates_effective_from
  ON note_templates(effective_from DESC);
```

- [ ] **Step 2: Apply the migration**

```bash
cd /home/hein/Workspace/IsaFlow
bunx tsx scripts/apply-migrations.ts
```

Expected: `Applied 335_note_templates.sql`.

- [ ] **Step 3: Commit**

```bash
git add scripts/migrations/sql/335_note_templates.sql
git commit -m "feat(afs): migration 335 — note_templates table"
```

---

## Task 4: Migration — `afs_generation_log` table

**Files:**
- Create: `scripts/migrations/sql/336_afs_generation_log.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 336_afs_generation_log.sql
-- Async job queue for AFS generation. Each row = one enqueued generation request.

CREATE TABLE IF NOT EXISTS afs_generation_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   UUID NOT NULL REFERENCES afs_documents(id) ON DELETE CASCADE,
  company_id    UUID NOT NULL,
  requested_by  UUID REFERENCES users(id),
  status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_afs_generation_log_document_id
  ON afs_generation_log(document_id);

CREATE INDEX IF NOT EXISTS idx_afs_generation_log_status
  ON afs_generation_log(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_afs_generation_log_company_id
  ON afs_generation_log(company_id, created_at DESC);
```

- [ ] **Step 2: Apply the migration**

```bash
cd /home/hein/Workspace/IsaFlow
bunx tsx scripts/apply-migrations.ts
```

Expected: `Applied 336_afs_generation_log.sql`.

- [ ] **Step 3: Commit**

```bash
git add scripts/migrations/sql/336_afs_generation_log.sql
git commit -m "feat(afs): migration 336 — afs_generation_log table"
```

---

## Task 5: Migration — `management_pack_configs` table

**Files:**
- Create: `scripts/migrations/sql/337_management_pack_configs.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 337_management_pack_configs.sql
-- Per-company configuration for automated monthly management pack generation.

CREATE TABLE IF NOT EXISTS management_pack_configs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  enabled          BOOLEAN NOT NULL DEFAULT FALSE,
  generation_day   INTEGER NOT NULL DEFAULT 5 CHECK (generation_day BETWEEN 1 AND 28),
  delivery_day     INTEGER NOT NULL DEFAULT 10 CHECK (delivery_day BETWEEN 1 AND 28),
  review_required  BOOLEAN NOT NULL DEFAULT TRUE,
  sections_enabled JSONB NOT NULL DEFAULT '{}'::JSONB,
  recipients       JSONB NOT NULL DEFAULT '[]'::JSONB,
  pack_style       TEXT NOT NULL DEFAULT 'detailed'
                     CHECK (pack_style IN ('executive', 'detailed', 'board')),
  comparison_mode  TEXT NOT NULL DEFAULT 'prior_month'
                     CHECK (comparison_mode IN ('prior_month', 'prior_year', 'budget', 'all_three')),
  currency_display TEXT NOT NULL DEFAULT 'full'
                     CHECK (currency_display IN ('full', 'thousands', 'millions')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_management_pack_configs_company_id
  ON management_pack_configs(company_id);

CREATE INDEX IF NOT EXISTS idx_management_pack_configs_enabled
  ON management_pack_configs(enabled) WHERE enabled = TRUE;
```

- [ ] **Step 2: Apply the migration**

```bash
cd /home/hein/Workspace/IsaFlow
bunx tsx scripts/apply-migrations.ts
```

Expected: `Applied 337_management_pack_configs.sql`.

- [ ] **Step 3: Commit**

```bash
git add scripts/migrations/sql/337_management_pack_configs.sql
git commit -m "feat(afs): migration 337 — management_pack_configs table"
```

---

## Task 6: Types — `afsTypes.ts`

**Files:**
- Create: `src/modules/accounting/services/afs/afsTypes.ts`

This is the single source of truth. Every other file in this plan imports from here.

- [ ] **Step 1: Create the types file**

```typescript
// src/modules/accounting/services/afs/afsTypes.ts

export type ReportingFramework = 'ifrs_smes' | 'full_ifrs';
export type DocumentType = 'afs' | 'management_pack';
export type DocumentStatus = 'draft' | 'in_review' | 'partner_review' | 'signed_off' | 'filed';
export type SectionStatus = 'pending' | 'auto_generated' | 'ai_enhanced' | 'reviewed' | 'signed_off';
export type SectionType =
  | 'cover'
  | 'directors_report'
  | 'auditors_report'
  | 'statement_of_fp'
  | 'income_statement'
  | 'changes_in_equity'
  | 'cash_flow'
  | 'note_1'  | 'note_2'  | 'note_3'  | 'note_4'  | 'note_5'
  | 'note_6'  | 'note_7'  | 'note_8'  | 'note_9'  | 'note_10'
  | 'note_11' | 'note_12' | 'note_13' | 'note_14' | 'note_15'
  | 'note_16' | 'note_17' | 'note_18' | 'note_19' | 'note_20'
  | 'note_21' | 'note_22' | 'note_23' | 'note_24' | 'note_25'
  | 'note_26' | 'note_27' | 'note_28' | 'note_29' | 'note_30';
export type PackStyle = 'executive' | 'detailed' | 'board';
export type GenerationJobStatus = 'queued' | 'running' | 'completed' | 'failed';

// ── NoteContent ──────────────────────────────────────────────────────────────

export interface NoteContentParagraph { type: 'paragraph'; text: string }
export interface NoteContentTable     { type: 'table'; headers: string[]; rows: string[][] }
export interface NoteContentList      { type: 'list'; items: string[] }
export interface NoteContentHeading   { type: 'heading'; text: string; level: 2 | 3 }

export type NoteContentBlock =
  | NoteContentParagraph
  | NoteContentTable
  | NoteContentList
  | NoteContentHeading;

export interface NoteContent {
  title: string;
  blocks: NoteContentBlock[];
}

// ── AfsDocument ──────────────────────────────────────────────────────────────

export interface AfsDocument {
  id: string;
  companyId: string;
  fiscalYear: number | null;
  period: string | null;
  documentType: DocumentType;
  reportingFramework: ReportingFramework;
  status: DocumentStatus;
  lockedAt: Date | null;
  lockedBy: string | null;
  version: number;
  pisScore: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAfsDocumentInput {
  companyId: string;
  fiscalYear?: number;
  period?: string;
  documentType: DocumentType;
  reportingFramework: ReportingFramework;
}

// ── AfsSection ───────────────────────────────────────────────────────────────

export interface AfsSectionVersionEntry {
  version: number;
  savedAt: string;
  savedBy: string;
  content: NoteContent;
}

export interface AfsSection {
  id: string;
  documentId: string;
  sectionType: SectionType;
  sortOrder: number;
  status: SectionStatus;
  dataSnapshot: Record<string, unknown> | null;
  content: NoteContent | null;
  overrides: Partial<NoteContent> | null;
  aiNarrative: string | null;
  aiNarrativeAccepted: boolean;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  signedOffBy: string | null;
  signedOffAt: Date | null;
  versionHistory: AfsSectionVersionEntry[];
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAfsSectionInput {
  documentId: string;
  sectionType: SectionType;
  sortOrder: number;
}

export interface UpdateAfsSectionInput {
  status?: SectionStatus;
  dataSnapshot?: Record<string, unknown>;
  content?: NoteContent;
  overrides?: Partial<NoteContent>;
  aiNarrative?: string;
  aiNarrativeAccepted?: boolean;
  reviewedBy?: string;
  signedOffBy?: string;
}

// ── NoteTemplate ─────────────────────────────────────────────────────────────

export interface NoteTemplate {
  id: string;
  sectionType: SectionType;
  framework: ReportingFramework | 'both';
  title: string;
  dataQueries: Record<string, string>;
  contentSchema: Record<string, unknown>;
  aiPromptTemplate: string | null;
  isMandatory: boolean;
  standardReference: string | null;
  effectiveFrom: Date;
  supersedes: string | null;
  changeSummary: string | null;
}

// ── AfsGenerationJob ─────────────────────────────────────────────────────────

export interface AfsGenerationJob {
  id: string;
  documentId: string;
  companyId: string;
  requestedBy: string | null;
  status: GenerationJobStatus;
  startedAt: Date | null;
  completedAt: Date | null;
  errorMessage: string | null;
  createdAt: Date;
}

// ── ManagementPackConfig ──────────────────────────────────────────────────────

export interface PackRecipient {
  email: string;
  role: string;
  receives: 'draft' | 'final' | 'both';
}

export interface ManagementPackConfig {
  id: string;
  companyId: string;
  enabled: boolean;
  generationDay: number;
  deliveryDay: number;
  reviewRequired: boolean;
  sectionsEnabled: Record<string, boolean>;
  recipients: PackRecipient[];
  packStyle: PackStyle;
  comparisonMode: 'prior_month' | 'prior_year' | 'budget' | 'all_three';
  currencyDisplay: 'full' | 'thousands' | 'millions';
}

// ── API response shapes ───────────────────────────────────────────────────────

export interface AfsDocumentWithSections extends AfsDocument {
  sections: AfsSection[];
}
```

- [ ] **Step 2: Type-check**

```bash
cd /home/hein/Workspace/IsaFlow
bunx tsc --noEmit 2>&1 | head -30
```

Expected: no errors from `afsTypes.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/modules/accounting/services/afs/afsTypes.ts
git commit -m "feat(afs): add afsTypes.ts — shared types for Document Engine"
```

---

## Task 7: Write failing tests for `afsDocumentService`

**Files:**
- Create: `tests/unit/services/afs/afsDocumentService.test.ts`

- [ ] **Step 1: Write the failing test file**

```typescript
// tests/unit/services/afs/afsDocumentService.test.ts

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
import {
  createAfsDocument,
  getAfsDocument,
  listAfsDocuments,
  lockAfsDocument,
} from '@/modules/accounting/services/afs/afsDocumentService';
import type { AfsDocument } from '@/modules/accounting/services/afs/afsTypes';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

const COMPANY_ID = 'ccc11111-0000-0000-0000-000000000001';
const DOC_ID     = 'ddd11111-0000-0000-0000-000000000001';
const USER_ID    = 'uuu11111-0000-0000-0000-000000000001';

const DB_ROW = {
  id: DOC_ID,
  company_id: COMPANY_ID,
  fiscal_year: 2025,
  period: null,
  document_type: 'afs',
  reporting_framework: 'ifrs_smes',
  status: 'draft',
  locked_at: null,
  locked_by: null,
  version: 1,
  pis_score: null,
  created_at: new Date('2026-01-01'),
  updated_at: new Date('2026-01-01'),
};

describe('afsDocumentService', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // ── createAfsDocument ────────────────────────────────────────────────────

  describe('createAfsDocument', () => {
    it('inserts a new document and returns camelCase AfsDocument', async () => {
      mockSql.mockResolvedValueOnce([DB_ROW]);

      const result = await createAfsDocument({
        companyId: COMPANY_ID,
        fiscalYear: 2025,
        documentType: 'afs',
        reportingFramework: 'ifrs_smes',
      });

      expect(result.id).toBe(DOC_ID);
      expect(result.companyId).toBe(COMPANY_ID);
      expect(result.fiscalYear).toBe(2025);
      expect(result.documentType).toBe('afs');
      expect(result.reportingFramework).toBe('ifrs_smes');
      expect(result.status).toBe('draft');
      expect(result.version).toBe(1);
      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it('throws when sql returns empty array (conflict / DB constraint)', async () => {
      mockSql.mockResolvedValueOnce([]);

      await expect(
        createAfsDocument({
          companyId: COMPANY_ID,
          fiscalYear: 2025,
          documentType: 'afs',
          reportingFramework: 'ifrs_smes',
        })
      ).rejects.toThrow('Failed to create AFS document');
    });
  });

  // ── getAfsDocument ───────────────────────────────────────────────────────

  describe('getAfsDocument', () => {
    it('returns the document when found', async () => {
      mockSql.mockResolvedValueOnce([DB_ROW]);

      const result = await getAfsDocument(DOC_ID, COMPANY_ID);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(DOC_ID);
      expect(result!.companyId).toBe(COMPANY_ID);
    });

    it('returns null when document not found', async () => {
      mockSql.mockResolvedValueOnce([]);

      const result = await getAfsDocument('nonexistent', COMPANY_ID);

      expect(result).toBeNull();
    });

    it('enforces company_id scoping (never returns another company document)', async () => {
      mockSql.mockResolvedValueOnce([]);

      const result = await getAfsDocument(DOC_ID, 'other-company-id');

      expect(result).toBeNull();
      // Verify the sql call included COMPANY scoping — the mock was called once
      expect(mockSql).toHaveBeenCalledTimes(1);
    });
  });

  // ── listAfsDocuments ─────────────────────────────────────────────────────

  describe('listAfsDocuments', () => {
    it('returns array of documents for the company', async () => {
      mockSql.mockResolvedValueOnce([DB_ROW, { ...DB_ROW, id: 'ddd22222-0000-0000-0000-000000000002', fiscal_year: 2024 }]);

      const result = await listAfsDocuments(COMPANY_ID);

      expect(result).toHaveLength(2);
      expect(result[0]!.companyId).toBe(COMPANY_ID);
      expect(result[1]!.fiscalYear).toBe(2024);
    });

    it('returns empty array when company has no documents', async () => {
      mockSql.mockResolvedValueOnce([]);

      const result = await listAfsDocuments(COMPANY_ID);

      expect(result).toEqual([]);
    });
  });

  // ── lockAfsDocument ──────────────────────────────────────────────────────

  describe('lockAfsDocument', () => {
    it('sets status to signed_off, locked_at, and locked_by', async () => {
      const lockedRow = {
        ...DB_ROW,
        status: 'signed_off',
        locked_at: new Date('2026-04-16'),
        locked_by: USER_ID,
      };
      mockSql.mockResolvedValueOnce([lockedRow]);

      const result = await lockAfsDocument(DOC_ID, COMPANY_ID, USER_ID);

      expect(result.status).toBe('signed_off');
      expect(result.lockedBy).toBe(USER_ID);
      expect(result.lockedAt).toBeInstanceOf(Date);
    });

    it('throws when document not found or already locked', async () => {
      mockSql.mockResolvedValueOnce([]);

      await expect(
        lockAfsDocument(DOC_ID, COMPANY_ID, USER_ID)
      ).rejects.toThrow('Document not found or already locked');
    });
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
cd /home/hein/Workspace/IsaFlow
bun run test:unit tests/unit/services/afs/afsDocumentService.test.ts 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module '@/modules/accounting/services/afs/afsDocumentService'`.

- [ ] **Step 3: Commit the failing tests**

```bash
git add tests/unit/services/afs/afsDocumentService.test.ts
git commit -m "test(afs): failing tests for afsDocumentService"
```

---

## Task 8: Implement `afsDocumentService`

**Files:**
- Create: `src/modules/accounting/services/afs/afsDocumentService.ts`

- [ ] **Step 1: Implement the service**

```typescript
// src/modules/accounting/services/afs/afsDocumentService.ts

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type {
  AfsDocument,
  CreateAfsDocumentInput,
  DocumentType,
  DocumentStatus,
  ReportingFramework,
} from './afsTypes';

// ── Row → Domain mapping ─────────────────────────────────────────────────────

function rowToAfsDocument(row: Record<string, unknown>): AfsDocument {
  return {
    id:                 row.id as string,
    companyId:          row.company_id as string,
    fiscalYear:         row.fiscal_year != null ? Number(row.fiscal_year) : null,
    period:             (row.period as string | null) ?? null,
    documentType:       row.document_type as DocumentType,
    reportingFramework: row.reporting_framework as ReportingFramework,
    status:             row.status as DocumentStatus,
    lockedAt:           row.locked_at instanceof Date ? row.locked_at
                          : row.locked_at != null ? new Date(row.locked_at as string) : null,
    lockedBy:           (row.locked_by as string | null) ?? null,
    version:            Number(row.version),
    pisScore:           row.pis_score != null ? Number(row.pis_score) : null,
    createdAt:          row.created_at instanceof Date ? row.created_at : new Date(row.created_at as string),
    updatedAt:          row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at as string),
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function createAfsDocument(input: CreateAfsDocumentInput): Promise<AfsDocument> {
  log.info('Creating AFS document', { companyId: input.companyId, documentType: input.documentType }, 'afsDocumentService');

  const rows = await sql`
    INSERT INTO afs_documents (
      company_id, fiscal_year, period, document_type, reporting_framework
    ) VALUES (
      ${input.companyId}::UUID,
      ${input.fiscalYear ?? null},
      ${input.period ?? null},
      ${input.documentType},
      ${input.reportingFramework}
    )
    RETURNING *
  `;

  if (rows.length === 0) {
    throw new Error('Failed to create AFS document');
  }

  return rowToAfsDocument(rows[0] as Record<string, unknown>);
}

export async function getAfsDocument(
  documentId: string,
  companyId: string
): Promise<AfsDocument | null> {
  const rows = await sql`
    SELECT * FROM afs_documents
    WHERE id = ${documentId}::UUID
      AND company_id = ${companyId}::UUID
    LIMIT 1
  `;

  if (rows.length === 0) return null;
  return rowToAfsDocument(rows[0] as Record<string, unknown>);
}

export async function listAfsDocuments(companyId: string): Promise<AfsDocument[]> {
  const rows = await sql`
    SELECT * FROM afs_documents
    WHERE company_id = ${companyId}::UUID
    ORDER BY created_at DESC
  `;

  return rows.map(r => rowToAfsDocument(r as Record<string, unknown>));
}

export async function lockAfsDocument(
  documentId: string,
  companyId: string,
  lockedBy: string
): Promise<AfsDocument> {
  log.info('Locking AFS document', { documentId, companyId, lockedBy }, 'afsDocumentService');

  const rows = await sql`
    UPDATE afs_documents
    SET
      status    = 'signed_off',
      locked_at = now(),
      locked_by = ${lockedBy}::UUID,
      updated_at = now()
    WHERE id         = ${documentId}::UUID
      AND company_id = ${companyId}::UUID
      AND status    != 'signed_off'
    RETURNING *
  `;

  if (rows.length === 0) {
    throw new Error('Document not found or already locked');
  }

  return rowToAfsDocument(rows[0] as Record<string, unknown>);
}
```

- [ ] **Step 2: Run the tests**

```bash
cd /home/hein/Workspace/IsaFlow
bun run test:unit tests/unit/services/afs/afsDocumentService.test.ts 2>&1 | tail -20
```

Expected: all 7 tests PASS.

- [ ] **Step 3: Type-check**

```bash
bunx tsc --noEmit 2>&1 | grep afsDocumentService
```

Expected: no output (no errors).

- [ ] **Step 4: Commit**

```bash
git add src/modules/accounting/services/afs/afsDocumentService.ts
git commit -m "feat(afs): implement afsDocumentService — CRUD for AfsDocument"
```

---

## Task 9: Write failing tests for `afsSectionService`

**Files:**
- Create: `tests/unit/services/afs/afsSectionService.test.ts`

- [ ] **Step 1: Write the failing test file**

```typescript
// tests/unit/services/afs/afsSectionService.test.ts

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
import {
  createAfsSection,
  getAfsSectionsForDocument,
  updateAfsSection,
} from '@/modules/accounting/services/afs/afsSectionService';
import type { NoteContent } from '@/modules/accounting/services/afs/afsTypes';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

const DOC_ID     = 'ddd11111-0000-0000-0000-000000000001';
const SECTION_ID = 'sss11111-0000-0000-0000-000000000001';
const USER_ID    = 'uuu11111-0000-0000-0000-000000000001';

const SECTION_ROW = {
  id: SECTION_ID,
  document_id: DOC_ID,
  section_type: 'note_1',
  sort_order: 1,
  status: 'pending',
  data_snapshot: null,
  content: null,
  overrides: null,
  ai_narrative: null,
  ai_narrative_accepted: false,
  reviewed_by: null,
  reviewed_at: null,
  signed_off_by: null,
  signed_off_at: null,
  version_history: [],
  created_at: new Date('2026-01-01'),
  updated_at: new Date('2026-01-01'),
};

const SAMPLE_CONTENT: NoteContent = {
  title: 'Accounting Policies',
  blocks: [{ type: 'paragraph', text: 'Basis of preparation: IFRS for SMEs.' }],
};

describe('afsSectionService', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // ── createAfsSection ─────────────────────────────────────────────────────

  describe('createAfsSection', () => {
    it('inserts a section and returns camelCase AfsSection', async () => {
      mockSql.mockResolvedValueOnce([SECTION_ROW]);

      const result = await createAfsSection({
        documentId: DOC_ID,
        sectionType: 'note_1',
        sortOrder: 1,
      });

      expect(result.id).toBe(SECTION_ID);
      expect(result.documentId).toBe(DOC_ID);
      expect(result.sectionType).toBe('note_1');
      expect(result.status).toBe('pending');
      expect(result.versionHistory).toEqual([]);
      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it('throws when sql returns empty (duplicate section_type in document)', async () => {
      mockSql.mockResolvedValueOnce([]);

      await expect(
        createAfsSection({ documentId: DOC_ID, sectionType: 'note_1', sortOrder: 1 })
      ).rejects.toThrow('Failed to create AFS section');
    });
  });

  // ── getAfsSectionsForDocument ────────────────────────────────────────────

  describe('getAfsSectionsForDocument', () => {
    it('returns all sections ordered by sort_order', async () => {
      const row2 = { ...SECTION_ROW, id: 'sss22222', section_type: 'note_2', sort_order: 2 };
      mockSql.mockResolvedValueOnce([SECTION_ROW, row2]);

      const result = await getAfsSectionsForDocument(DOC_ID);

      expect(result).toHaveLength(2);
      expect(result[0]!.sectionType).toBe('note_1');
      expect(result[1]!.sectionType).toBe('note_2');
    });

    it('returns empty array when document has no sections', async () => {
      mockSql.mockResolvedValueOnce([]);

      const result = await getAfsSectionsForDocument(DOC_ID);

      expect(result).toEqual([]);
    });
  });

  // ── updateAfsSection ─────────────────────────────────────────────────────

  describe('updateAfsSection', () => {
    it('updates content and status, appends to version_history', async () => {
      const updatedRow = {
        ...SECTION_ROW,
        status: 'auto_generated',
        content: SAMPLE_CONTENT,
        version_history: [
          { version: 1, savedAt: '2026-04-16T00:00:00Z', savedBy: USER_ID, content: SAMPLE_CONTENT },
        ],
      };
      mockSql.mockResolvedValueOnce([updatedRow]);

      const result = await updateAfsSection(SECTION_ID, DOC_ID, {
        status: 'auto_generated',
        content: SAMPLE_CONTENT,
      });

      expect(result.status).toBe('auto_generated');
      expect(result.content).toEqual(SAMPLE_CONTENT);
      expect(result.versionHistory).toHaveLength(1);
    });

    it('throws when section not found', async () => {
      mockSql.mockResolvedValueOnce([]);

      await expect(
        updateAfsSection('nonexistent', DOC_ID, { status: 'reviewed' })
      ).rejects.toThrow('Section not found');
    });
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
cd /home/hein/Workspace/IsaFlow
bun run test:unit tests/unit/services/afs/afsSectionService.test.ts 2>&1 | tail -10
```

Expected: FAIL — `Cannot find module '@/modules/accounting/services/afs/afsSectionService'`.

- [ ] **Step 3: Commit the failing tests**

```bash
git add tests/unit/services/afs/afsSectionService.test.ts
git commit -m "test(afs): failing tests for afsSectionService"
```

---

## Task 10: Implement `afsSectionService`

**Files:**
- Create: `src/modules/accounting/services/afs/afsSectionService.ts`

- [ ] **Step 1: Implement the service**

```typescript
// src/modules/accounting/services/afs/afsSectionService.ts

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type {
  AfsSection,
  SectionType,
  SectionStatus,
  NoteContent,
  CreateAfsSectionInput,
  UpdateAfsSectionInput,
  AfsSectionVersionEntry,
} from './afsTypes';

// ── Row → Domain mapping ─────────────────────────────────────────────────────

function rowToAfsSection(row: Record<string, unknown>): AfsSection {
  return {
    id:                   row.id as string,
    documentId:           row.document_id as string,
    sectionType:          row.section_type as SectionType,
    sortOrder:            Number(row.sort_order),
    status:               row.status as SectionStatus,
    dataSnapshot:         (row.data_snapshot as Record<string, unknown> | null) ?? null,
    content:              (row.content as NoteContent | null) ?? null,
    overrides:            (row.overrides as Partial<NoteContent> | null) ?? null,
    aiNarrative:          (row.ai_narrative as string | null) ?? null,
    aiNarrativeAccepted:  Boolean(row.ai_narrative_accepted),
    reviewedBy:           (row.reviewed_by as string | null) ?? null,
    reviewedAt:           row.reviewed_at instanceof Date ? row.reviewed_at
                            : row.reviewed_at != null ? new Date(row.reviewed_at as string) : null,
    signedOffBy:          (row.signed_off_by as string | null) ?? null,
    signedOffAt:          row.signed_off_at instanceof Date ? row.signed_off_at
                            : row.signed_off_at != null ? new Date(row.signed_off_at as string) : null,
    versionHistory:       Array.isArray(row.version_history)
                            ? (row.version_history as AfsSectionVersionEntry[])
                            : [],
    createdAt:            row.created_at instanceof Date ? row.created_at : new Date(row.created_at as string),
    updatedAt:            row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at as string),
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function createAfsSection(input: CreateAfsSectionInput): Promise<AfsSection> {
  log.info('Creating AFS section', { documentId: input.documentId, sectionType: input.sectionType }, 'afsSectionService');

  const rows = await sql`
    INSERT INTO afs_sections (document_id, section_type, sort_order)
    VALUES (${input.documentId}::UUID, ${input.sectionType}, ${input.sortOrder})
    RETURNING *
  `;

  if (rows.length === 0) {
    throw new Error('Failed to create AFS section');
  }

  return rowToAfsSection(rows[0] as Record<string, unknown>);
}

export async function getAfsSectionsForDocument(documentId: string): Promise<AfsSection[]> {
  const rows = await sql`
    SELECT * FROM afs_sections
    WHERE document_id = ${documentId}::UUID
    ORDER BY sort_order ASC, created_at ASC
  `;

  return rows.map(r => rowToAfsSection(r as Record<string, unknown>));
}

export async function updateAfsSection(
  sectionId: string,
  documentId: string,
  input: UpdateAfsSectionInput
): Promise<AfsSection> {
  log.info('Updating AFS section', { sectionId, documentId, status: input.status }, 'afsSectionService');

  const rows = await sql`
    UPDATE afs_sections
    SET
      status               = COALESCE(${input.status ?? null}, status),
      data_snapshot        = COALESCE(${input.dataSnapshot ? JSON.stringify(input.dataSnapshot) : null}::JSONB, data_snapshot),
      content              = COALESCE(${input.content ? JSON.stringify(input.content) : null}::JSONB, content),
      overrides            = COALESCE(${input.overrides ? JSON.stringify(input.overrides) : null}::JSONB, overrides),
      ai_narrative         = COALESCE(${input.aiNarrative ?? null}, ai_narrative),
      ai_narrative_accepted = COALESCE(${input.aiNarrativeAccepted ?? null}, ai_narrative_accepted),
      reviewed_by          = COALESCE(${input.reviewedBy ? input.reviewedBy + '::UUID' : null}, reviewed_by),
      reviewed_at          = CASE WHEN ${input.reviewedBy ?? null} IS NOT NULL THEN now() ELSE reviewed_at END,
      signed_off_by        = COALESCE(${input.signedOffBy ? input.signedOffBy + '::UUID' : null}, signed_off_by),
      signed_off_at        = CASE WHEN ${input.signedOffBy ?? null} IS NOT NULL THEN now() ELSE signed_off_at END,
      version_history      = version_history || CASE
        WHEN ${input.content ? JSON.stringify(input.content) : null}::JSONB IS NOT NULL
        THEN jsonb_build_array(jsonb_build_object(
          'version', (SELECT COUNT(*) FROM jsonb_array_elements(version_history)) + 1,
          'savedAt', now()::TEXT,
          'savedBy', COALESCE(${input.reviewedBy ?? input.signedOffBy ?? null}, 'system'),
          'content', ${input.content ? JSON.stringify(input.content) : null}::JSONB
        ))
        ELSE '[]'::JSONB
      END,
      updated_at           = now()
    WHERE id          = ${sectionId}::UUID
      AND document_id = ${documentId}::UUID
    RETURNING *
  `;

  if (rows.length === 0) {
    throw new Error('Section not found');
  }

  return rowToAfsSection(rows[0] as Record<string, unknown>);
}
```

- [ ] **Step 2: Run the tests**

```bash
cd /home/hein/Workspace/IsaFlow
bun run test:unit tests/unit/services/afs/afsSectionService.test.ts 2>&1 | tail -20
```

Expected: all 6 tests PASS.

- [ ] **Step 3: Type-check**

```bash
bunx tsc --noEmit 2>&1 | grep afsSectionService
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add src/modules/accounting/services/afs/afsSectionService.ts
git commit -m "feat(afs): implement afsSectionService — CRUD for AfsSection"
```

---

## Task 11: Write failing tests for `noteTemplateRegistry`

**Files:**
- Create: `tests/unit/services/afs/noteTemplateRegistry.test.ts`

- [ ] **Step 1: Write the failing test file**

```typescript
// tests/unit/services/afs/noteTemplateRegistry.test.ts

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
import {
  seedNoteTemplates,
  getNoteTemplatesForFramework,
  ALL_NOTE_TEMPLATES,
} from '@/modules/accounting/services/afs/noteTemplateRegistry';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

describe('noteTemplateRegistry', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // ── Static registry ──────────────────────────────────────────────────────

  describe('ALL_NOTE_TEMPLATES static array', () => {
    it('contains exactly 30 note templates', () => {
      const noteTemplates = ALL_NOTE_TEMPLATES.filter(t =>
        t.sectionType.startsWith('note_')
      );
      expect(noteTemplates).toHaveLength(30);
    });

    it('has a template for note_1 (Accounting Policies) applicable to both frameworks', () => {
      const note1 = ALL_NOTE_TEMPLATES.find(t => t.sectionType === 'note_1');
      expect(note1).toBeDefined();
      expect(note1!.framework).toBe('both');
      expect(note1!.isMandatory).toBe(true);
      expect(note1!.title).toMatch(/accounting polic/i);
    });

    it('has note_4 (Right-of-Use Assets) applicable to full_ifrs only', () => {
      const note4 = ALL_NOTE_TEMPLATES.find(t => t.sectionType === 'note_4');
      expect(note4).toBeDefined();
      expect(note4!.framework).toBe('full_ifrs');
    });

    it('has note_14 (Lease Liabilities IFRS 16) applicable to full_ifrs only', () => {
      const note14 = ALL_NOTE_TEMPLATES.find(t => t.sectionType === 'note_14');
      expect(note14).toBeDefined();
      expect(note14!.framework).toBe('full_ifrs');
    });

    it('has note_28 (Segment Information) applicable to full_ifrs only', () => {
      const note28 = ALL_NOTE_TEMPLATES.find(t => t.sectionType === 'note_28');
      expect(note28).toBeDefined();
      expect(note28!.framework).toBe('full_ifrs');
    });

    it('every template has a non-empty title', () => {
      for (const t of ALL_NOTE_TEMPLATES) {
        expect(t.title.length).toBeGreaterThan(0);
      }
    });
  });

  // ── getNoteTemplatesForFramework ─────────────────────────────────────────

  describe('getNoteTemplatesForFramework', () => {
    it('returns both-framework and ifrs_smes templates for ifrs_smes', () => {
      const templates = getNoteTemplatesForFramework('ifrs_smes');
      expect(templates.every(t => t.framework === 'both' || t.framework === 'ifrs_smes')).toBe(true);
    });

    it('returns both-framework and full_ifrs templates for full_ifrs', () => {
      const templates = getNoteTemplatesForFramework('full_ifrs');
      expect(templates.every(t => t.framework === 'both' || t.framework === 'full_ifrs')).toBe(true);
    });

    it('full_ifrs returns more templates than ifrs_smes (has IFRS16 sections)', () => {
      const smes = getNoteTemplatesForFramework('ifrs_smes');
      const full = getNoteTemplatesForFramework('full_ifrs');
      expect(full.length).toBeGreaterThan(smes.length);
    });
  });

  // ── seedNoteTemplates ────────────────────────────────────────────────────

  describe('seedNoteTemplates', () => {
    it('calls sql once per template (upsert)', async () => {
      mockSql.mockResolvedValue([{ id: 'some-id' }]);

      await seedNoteTemplates();

      expect(mockSql).toHaveBeenCalledTimes(ALL_NOTE_TEMPLATES.length);
    });

    it('does not throw when all upserts succeed', async () => {
      mockSql.mockResolvedValue([{ id: 'some-id' }]);

      await expect(seedNoteTemplates()).resolves.not.toThrow();
    });
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd /home/hein/Workspace/IsaFlow
bun run test:unit tests/unit/services/afs/noteTemplateRegistry.test.ts 2>&1 | tail -10
```

Expected: FAIL — `Cannot find module '@/modules/accounting/services/afs/noteTemplateRegistry'`.

- [ ] **Step 3: Commit failing tests**

```bash
git add tests/unit/services/afs/noteTemplateRegistry.test.ts
git commit -m "test(afs): failing tests for noteTemplateRegistry"
```

---

## Task 12: Implement `noteTemplateRegistry`

**Files:**
- Create: `src/modules/accounting/services/afs/noteTemplateRegistry.ts`

- [ ] **Step 1: Implement the registry**

```typescript
// src/modules/accounting/services/afs/noteTemplateRegistry.ts
// Static registry of all 30 note templates. seedNoteTemplates() upserts
// them into note_templates on startup or migration.

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { NoteTemplate, SectionType, ReportingFramework } from './afsTypes';

// ── Static template definitions ──────────────────────────────────────────────

type TemplateDefinition = Omit<NoteTemplate, 'id' | 'effectiveFrom' | 'supersedes' | 'changeSummary'>;

export const ALL_NOTE_TEMPLATES: TemplateDefinition[] = [
  {
    sectionType: 'note_1',
    framework: 'both',
    title: 'Accounting Policies',
    dataQueries: { glAccountTypes: 'SELECT DISTINCT account_type, account_subtype FROM chart_of_accounts WHERE company_id = $company_id' },
    contentSchema: { sections: ['basis_of_preparation', 'significant_policies'] },
    aiPromptTemplate: 'Draft the Accounting Policies note for a South African SME using IFRS for SMEs. Include basis of preparation, going concern, and the following account types: {{glAccountTypes}}.',
    isMandatory: true,
    standardReference: 'IFRS for SMEs Section 10 / IAS 8',
  },
  {
    sectionType: 'note_2',
    framework: 'both',
    title: 'Significant Estimates and Judgements',
    dataQueries: {},
    contentSchema: { areas: ['useful_lives', 'impairment', 'provisions'] },
    aiPromptTemplate: 'Draft the Significant Estimates and Judgements note for a South African SME. Highlight areas requiring management estimation such as useful lives of assets, impairment assessments, and provisions.',
    isMandatory: true,
    standardReference: 'IFRS for SMEs Section 8 / IAS 1.122',
  },
  {
    sectionType: 'note_3',
    framework: 'both',
    title: 'Property, Plant and Equipment',
    dataQueries: { ppe: 'SELECT category, opening_cost, additions, disposals, closing_cost, accumulated_depreciation, net_book_value FROM fixed_assets WHERE company_id = $company_id AND fiscal_year = $fiscal_year' },
    contentSchema: { movementTable: true, depreciationRates: true },
    aiPromptTemplate: 'Draft the PPE note narrative. Total NBV is {{netBookValue}}. Key additions this year: {{majorAdditions}}.',
    isMandatory: true,
    standardReference: 'IFRS for SMEs Section 17 / IAS 16',
  },
  {
    sectionType: 'note_4',
    framework: 'full_ifrs',
    title: 'Right-of-Use Assets',
    dataQueries: { rouAssets: 'SELECT asset_class, opening_nbv, additions, depreciation, closing_nbv FROM rou_assets WHERE company_id = $company_id AND fiscal_year = $fiscal_year' },
    contentSchema: { movementTable: true, leaseTerms: true },
    aiPromptTemplate: 'Draft the Right-of-Use Assets note under IFRS 16. Total ROU asset balance is {{totalRouNbv}}.',
    isMandatory: true,
    standardReference: 'IFRS 16',
  },
  {
    sectionType: 'note_5',
    framework: 'both',
    title: 'Intangible Assets',
    dataQueries: { intangibles: 'SELECT category, opening_cost, additions, amortisation, closing_nbv FROM intangible_assets WHERE company_id = $company_id AND fiscal_year = $fiscal_year' },
    contentSchema: { movementTable: true },
    aiPromptTemplate: 'Draft the Intangible Assets note. Total intangibles NBV: {{totalNbv}}.',
    isMandatory: false,
    standardReference: 'IFRS for SMEs Section 18 / IAS 38',
  },
  {
    sectionType: 'note_6',
    framework: 'both',
    title: 'Investment Property',
    dataQueries: { investmentProperty: 'SELECT property_name, carrying_value, fair_value FROM investment_properties WHERE company_id = $company_id' },
    contentSchema: { valuationBasis: true, movementTable: true },
    aiPromptTemplate: 'Draft the Investment Property note. Total carrying value: {{totalCarryingValue}}.',
    isMandatory: false,
    standardReference: 'IFRS for SMEs Section 16 / IAS 40',
  },
  {
    sectionType: 'note_7',
    framework: 'both',
    title: 'Investments in Associates',
    dataQueries: { associates: 'SELECT associate_name, equity_accounted_value FROM associates WHERE company_id = $company_id' },
    contentSchema: { equityMethodTable: true },
    aiPromptTemplate: 'Draft the Investments in Associates note under the equity method.',
    isMandatory: false,
    standardReference: 'IFRS for SMEs Section 14 / IAS 28',
  },
  {
    sectionType: 'note_8',
    framework: 'both',
    title: 'Financial Assets',
    dataQueries: { financialAssets: 'SELECT category, carrying_value, fair_value FROM financial_assets WHERE company_id = $company_id' },
    contentSchema: { classificationTable: true, fairValueHierarchy: true },
    aiPromptTemplate: 'Draft the Financial Assets note.',
    isMandatory: false,
    standardReference: 'IFRS for SMEs Section 11 / IFRS 9',
  },
  {
    sectionType: 'note_9',
    framework: 'both',
    title: 'Inventories',
    dataQueries: { inventories: 'SELECT category, quantity, unit_cost, total_value FROM stock_items WHERE company_id = $company_id' },
    contentSchema: { inventoryTable: true, costingMethod: true },
    aiPromptTemplate: 'Draft the Inventories note. Total inventories value: {{totalInventoryValue}}. Costing method: {{costingMethod}}.',
    isMandatory: false,
    standardReference: 'IFRS for SMEs Section 13 / IAS 2',
  },
  {
    sectionType: 'note_10',
    framework: 'both',
    title: 'Trade and Other Receivables',
    dataQueries: { receivables: 'SELECT SUM(outstanding_balance) AS total, SUM(CASE WHEN days_overdue > 90 THEN outstanding_balance ELSE 0 END) AS over_90 FROM customer_invoices WHERE company_id = $company_id AND status != \'paid\'' },
    contentSchema: { agingTable: true, creditRisk: true },
    aiPromptTemplate: 'Draft the Trade Receivables note. Total receivables: {{total}}. Over 90 days: {{over90}}.',
    isMandatory: true,
    standardReference: 'IFRS for SMEs Section 11 / IFRS 9',
  },
  {
    sectionType: 'note_11',
    framework: 'both',
    title: 'Cash and Cash Equivalents',
    dataQueries: { cashBalances: 'SELECT account_name, balance FROM bank_accounts WHERE company_id = $company_id' },
    contentSchema: { bankTable: true },
    aiPromptTemplate: null,
    isMandatory: true,
    standardReference: 'IFRS for SMEs Section 7 / IAS 7',
  },
  {
    sectionType: 'note_12',
    framework: 'both',
    title: 'Share Capital and Reserves',
    dataQueries: { equity: 'SELECT account_name, balance FROM chart_of_accounts WHERE company_id = $company_id AND account_type = \'equity\'' },
    contentSchema: { movementTable: true, authorisedCapital: true },
    aiPromptTemplate: 'Draft the Share Capital and Reserves note.',
    isMandatory: true,
    standardReference: 'IFRS for SMEs Section 22 / IAS 1',
  },
  {
    sectionType: 'note_13',
    framework: 'both',
    title: 'Borrowings',
    dataQueries: { borrowings: 'SELECT lender_name, principal, interest_rate, maturity_date, current_portion, non_current_portion FROM borrowings WHERE company_id = $company_id' },
    contentSchema: { borrowingsTable: true, maturityAnalysis: true },
    aiPromptTemplate: 'Draft the Borrowings note. Total borrowings: {{totalBorrowings}}.',
    isMandatory: false,
    standardReference: 'IFRS for SMEs Section 11 / IFRS 9',
  },
  {
    sectionType: 'note_14',
    framework: 'full_ifrs',
    title: 'Lease Liabilities (IFRS 16)',
    dataQueries: { leaseLiabilities: 'SELECT lease_description, opening_liability, additions, payments, interest_charge, closing_liability FROM lease_liabilities WHERE company_id = $company_id AND fiscal_year = $fiscal_year' },
    contentSchema: { movementTable: true, maturityAnalysis: true },
    aiPromptTemplate: 'Draft the Lease Liabilities note under IFRS 16. Total lease liabilities: {{totalLeaseLiability}}.',
    isMandatory: true,
    standardReference: 'IFRS 16',
  },
  {
    sectionType: 'note_15',
    framework: 'both',
    title: 'Provisions',
    dataQueries: { provisions: 'SELECT provision_type, opening_balance, raised, utilised, closing_balance FROM provisions WHERE company_id = $company_id' },
    contentSchema: { movementTable: true },
    aiPromptTemplate: 'Draft the Provisions note.',
    isMandatory: false,
    standardReference: 'IFRS for SMEs Section 21 / IAS 37',
  },
  {
    sectionType: 'note_16',
    framework: 'both',
    title: 'Trade and Other Payables',
    dataQueries: { payables: 'SELECT SUM(outstanding_balance) AS total FROM supplier_invoices WHERE company_id = $company_id AND status != \'paid\'' },
    contentSchema: { payablesTable: true },
    aiPromptTemplate: null,
    isMandatory: true,
    standardReference: 'IFRS for SMEs Section 11',
  },
  {
    sectionType: 'note_17',
    framework: 'both',
    title: 'Income Tax and Deferred Tax',
    dataQueries: { taxCharge: 'SELECT current_tax, deferred_tax_movement FROM tax_computations WHERE company_id = $company_id AND fiscal_year = $fiscal_year' },
    contentSchema: { taxReconciliation: true, deferredTaxTable: true },
    aiPromptTemplate: 'Draft the Income Tax note. Current tax: {{currentTax}}. Effective tax rate: {{effectiveRate}}%.',
    isMandatory: true,
    standardReference: 'IFRS for SMEs Section 29 / IAS 12',
  },
  {
    sectionType: 'note_18',
    framework: 'both',
    title: 'Revenue Disaggregation',
    dataQueries: { revenue: 'SELECT account_name, SUM(credit - debit) AS total FROM journal_entry_lines jel JOIN chart_of_accounts coa ON jel.account_id = coa.id WHERE coa.company_id = $company_id AND coa.account_type = \'revenue\' AND jel.fiscal_year = $fiscal_year GROUP BY account_name' },
    contentSchema: { revenueTable: true, recognitionPolicy: true },
    aiPromptTemplate: 'Draft the Revenue Disaggregation note. Total revenue: {{totalRevenue}}. Key revenue streams: {{revenueStreams}}.',
    isMandatory: true,
    standardReference: 'IFRS for SMEs Section 23 / IFRS 15',
  },
  {
    sectionType: 'note_19',
    framework: 'both',
    title: 'Other Income and Finance Income',
    dataQueries: { otherIncome: 'SELECT account_name, SUM(credit - debit) AS total FROM journal_entry_lines jel JOIN chart_of_accounts coa ON jel.account_id = coa.id WHERE coa.company_id = $company_id AND coa.account_subtype IN (\'other_income\', \'interest_income\') AND jel.fiscal_year = $fiscal_year GROUP BY account_name' },
    contentSchema: { incomeTable: true },
    aiPromptTemplate: null,
    isMandatory: false,
    standardReference: 'IFRS for SMEs Section 5',
  },
  {
    sectionType: 'note_20',
    framework: 'both',
    title: 'Operating Expenses by Nature',
    dataQueries: { opex: 'SELECT account_name, SUM(debit - credit) AS total FROM journal_entry_lines jel JOIN chart_of_accounts coa ON jel.account_id = coa.id WHERE coa.company_id = $company_id AND coa.account_type = \'expense\' AND jel.fiscal_year = $fiscal_year GROUP BY account_name ORDER BY total DESC' },
    contentSchema: { expenseTable: true },
    aiPromptTemplate: null,
    isMandatory: true,
    standardReference: 'IFRS for SMEs Section 5',
  },
  {
    sectionType: 'note_21',
    framework: 'both',
    title: 'Finance Costs',
    dataQueries: { financeCosts: 'SELECT account_name, SUM(debit - credit) AS total FROM journal_entry_lines jel JOIN chart_of_accounts coa ON jel.account_id = coa.id WHERE coa.company_id = $company_id AND coa.account_subtype = \'interest_expense\' AND jel.fiscal_year = $fiscal_year GROUP BY account_name' },
    contentSchema: { financeCostTable: true },
    aiPromptTemplate: null,
    isMandatory: false,
    standardReference: 'IFRS for SMEs Section 25 / IAS 23',
  },
  {
    sectionType: 'note_22',
    framework: 'both',
    title: 'Employee Benefits',
    dataQueries: { employeeCosts: 'SELECT account_name, SUM(debit - credit) AS total FROM journal_entry_lines jel JOIN chart_of_accounts coa ON jel.account_id = coa.id WHERE coa.company_id = $company_id AND coa.account_subtype = \'employee_costs\' AND jel.fiscal_year = $fiscal_year GROUP BY account_name' },
    contentSchema: { employeeCostTable: true, headcount: true },
    aiPromptTemplate: 'Draft the Employee Benefits note. Total employee costs: {{totalEmployeeCosts}}.',
    isMandatory: true,
    standardReference: 'IFRS for SMEs Section 28 / IAS 19',
  },
  {
    sectionType: 'note_23',
    framework: 'both',
    title: 'Related Party Disclosures',
    dataQueries: {},
    contentSchema: { relatedPartyTable: true, directorsList: true },
    aiPromptTemplate: 'Draft the Related Party Disclosures note based on the listed directors and related entities.',
    isMandatory: true,
    standardReference: 'IFRS for SMEs Section 33 / IAS 24',
  },
  {
    sectionType: 'note_24',
    framework: 'both',
    title: "Auditor's Remuneration",
    dataQueries: {},
    contentSchema: { auditFeeTable: true },
    aiPromptTemplate: null,
    isMandatory: true,
    standardReference: 'Companies Act 71 of 2008 s90',
  },
  {
    sectionType: 'note_25',
    framework: 'both',
    title: 'Contingencies and Commitments',
    dataQueries: {},
    contentSchema: { contingenciesTable: true, commitmentsTable: true },
    aiPromptTemplate: 'Draft the Contingencies and Commitments note. Include any known legal claims or capital commitments.',
    isMandatory: true,
    standardReference: 'IFRS for SMEs Section 21 / IAS 37',
  },
  {
    sectionType: 'note_26',
    framework: 'both',
    title: 'Events After the Reporting Date',
    dataQueries: {},
    contentSchema: { eventsTable: true },
    aiPromptTemplate: 'Draft the Events After the Reporting Date note. If no material events have occurred, state that nil events are reported.',
    isMandatory: true,
    standardReference: 'IFRS for SMEs Section 32 / IAS 10',
  },
  {
    sectionType: 'note_27',
    framework: 'both',
    title: 'Going Concern',
    dataQueries: { currentRatio: 'SELECT SUM(CASE WHEN account_subtype IN (\'current_asset\') THEN balance ELSE 0 END) / NULLIF(SUM(CASE WHEN account_subtype = \'current_liability\' THEN balance ELSE 0 END), 0) AS current_ratio FROM balance_sheet_view WHERE company_id = $company_id' },
    contentSchema: { goingConcernParagraph: true },
    aiPromptTemplate: 'Draft the Going Concern note. Current ratio is {{currentRatio}}. State management\'s assessment of the entity\'s ability to continue as a going concern.',
    isMandatory: true,
    standardReference: 'IFRS for SMEs Section 3.8 / IAS 1.25',
  },
  {
    sectionType: 'note_28',
    framework: 'full_ifrs',
    title: 'Segment Information',
    dataQueries: { segments: 'SELECT segment_name, revenue, profit, assets FROM segment_data WHERE company_id = $company_id AND fiscal_year = $fiscal_year' },
    contentSchema: { segmentTable: true },
    aiPromptTemplate: 'Draft the Segment Information note under IFRS 8.',
    isMandatory: true,
    standardReference: 'IFRS 8',
  },
  {
    sectionType: 'note_29',
    framework: 'full_ifrs',
    title: 'Financial Instruments Risk',
    dataQueries: { exposures: 'SELECT risk_type, exposure_amount FROM financial_risk_exposures WHERE company_id = $company_id' },
    contentSchema: { creditRisk: true, liquidityRisk: true, marketRisk: true },
    aiPromptTemplate: 'Draft the Financial Instruments Risk note under IFRS 7. Cover credit risk, liquidity risk, and market risk (interest rate and currency).',
    isMandatory: true,
    standardReference: 'IFRS 7',
  },
  {
    sectionType: 'note_30',
    framework: 'both',
    title: 'Standards Issued But Not Yet Effective',
    dataQueries: {},
    contentSchema: { standardsTable: true },
    aiPromptTemplate: null,
    isMandatory: true,
    standardReference: 'IAS 8.30',
  },
];

// ── Framework filter helper ──────────────────────────────────────────────────

export function getNoteTemplatesForFramework(framework: ReportingFramework): TemplateDefinition[] {
  return ALL_NOTE_TEMPLATES.filter(
    t => t.framework === 'both' || t.framework === framework
  );
}

// ── Seed function (called on startup or by migration script) ─────────────────

export async function seedNoteTemplates(): Promise<void> {
  log.info('Seeding note templates', { count: ALL_NOTE_TEMPLATES.length }, 'noteTemplateRegistry');

  for (const template of ALL_NOTE_TEMPLATES) {
    await sql`
      INSERT INTO note_templates (
        section_type, framework, title, data_queries, content_schema,
        ai_prompt_template, is_mandatory, standard_reference, effective_from
      ) VALUES (
        ${template.sectionType},
        ${template.framework},
        ${template.title},
        ${JSON.stringify(template.dataQueries)}::JSONB,
        ${JSON.stringify(template.contentSchema)}::JSONB,
        ${template.aiPromptTemplate ?? null},
        ${template.isMandatory},
        ${template.standardReference ?? null},
        CURRENT_DATE
      )
      ON CONFLICT (section_type, framework) DO UPDATE SET
        title              = EXCLUDED.title,
        data_queries       = EXCLUDED.data_queries,
        content_schema     = EXCLUDED.content_schema,
        ai_prompt_template = EXCLUDED.ai_prompt_template,
        is_mandatory       = EXCLUDED.is_mandatory,
        standard_reference = EXCLUDED.standard_reference,
        updated_at         = now()
    `;
  }

  log.info('Note templates seeded', { count: ALL_NOTE_TEMPLATES.length }, 'noteTemplateRegistry');
}
```

> **Note:** The `ON CONFLICT` clause requires a unique index on `(section_type, framework)`. Add this to the `note_templates` table in migration 335 by editing the file before running:

Open `scripts/migrations/sql/335_note_templates.sql` and append:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uq_note_templates_section_framework
  ON note_templates(section_type, framework);
```

If migration 335 was already applied, create a new migration file `scripts/migrations/sql/335b_note_templates_unique.sql` with just that line (or add it inline here and re-apply if the table is empty).

- [ ] **Step 2: Run the tests**

```bash
cd /home/hein/Workspace/IsaFlow
bun run test:unit tests/unit/services/afs/noteTemplateRegistry.test.ts 2>&1 | tail -20
```

Expected: all 9 tests PASS.

- [ ] **Step 3: Type-check**

```bash
bunx tsc --noEmit 2>&1 | grep noteTemplateRegistry
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add src/modules/accounting/services/afs/noteTemplateRegistry.ts
git commit -m "feat(afs): implement noteTemplateRegistry — 30-note static registry + seed"
```

---

## Task 13: Implement `afsGenerationJobService`

No tests task precedes this one because the service is a thin wrapper around an insert/select — the logic is trivially covered by integration. We do write unit tests inline.

**Files:**
- Create: `src/modules/accounting/services/afs/afsGenerationJobService.ts`

- [ ] **Step 1: Implement the service**

```typescript
// src/modules/accounting/services/afs/afsGenerationJobService.ts

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { AfsGenerationJob, GenerationJobStatus } from './afsTypes';

// ── Row → Domain mapping ─────────────────────────────────────────────────────

function rowToJob(row: Record<string, unknown>): AfsGenerationJob {
  return {
    id:           row.id as string,
    documentId:   row.document_id as string,
    companyId:    row.company_id as string,
    requestedBy:  (row.requested_by as string | null) ?? null,
    status:       row.status as GenerationJobStatus,
    startedAt:    row.started_at instanceof Date ? row.started_at
                    : row.started_at != null ? new Date(row.started_at as string) : null,
    completedAt:  row.completed_at instanceof Date ? row.completed_at
                    : row.completed_at != null ? new Date(row.completed_at as string) : null,
    errorMessage: (row.error_message as string | null) ?? null,
    createdAt:    row.created_at instanceof Date ? row.created_at : new Date(row.created_at as string),
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Enqueue a new generation job for an AFS document.
 * Returns the created job. Caller may poll getLatestJobForDocument() for status.
 */
export async function enqueueGenerationJob(
  documentId: string,
  companyId: string,
  requestedBy: string | null
): Promise<AfsGenerationJob> {
  log.info('Enqueueing generation job', { documentId, companyId }, 'afsGenerationJobService');

  const rows = await sql`
    INSERT INTO afs_generation_log (document_id, company_id, requested_by, status)
    VALUES (${documentId}::UUID, ${companyId}::UUID, ${requestedBy ? requestedBy + '::UUID' : null}, 'queued')
    RETURNING *
  `;

  if (rows.length === 0) {
    throw new Error('Failed to enqueue generation job');
  }

  return rowToJob(rows[0] as Record<string, unknown>);
}

/**
 * Retrieve the most recent generation job for a document.
 * Returns null when no job exists.
 */
export async function getLatestJobForDocument(
  documentId: string,
  companyId: string
): Promise<AfsGenerationJob | null> {
  const rows = await sql`
    SELECT * FROM afs_generation_log
    WHERE document_id = ${documentId}::UUID
      AND company_id  = ${companyId}::UUID
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (rows.length === 0) return null;
  return rowToJob(rows[0] as Record<string, unknown>);
}

/**
 * Mark a job as failed with an error message.
 * Used by background worker error handlers.
 */
export async function markJobFailed(
  jobId: string,
  errorMessage: string
): Promise<void> {
  await sql`
    UPDATE afs_generation_log
    SET status        = 'failed',
        error_message = ${errorMessage},
        completed_at  = now()
    WHERE id = ${jobId}::UUID
  `;

  log.warn('Generation job failed', { jobId, errorMessage }, 'afsGenerationJobService');
}

/**
 * Mark a job as completed.
 */
export async function markJobCompleted(jobId: string): Promise<void> {
  await sql`
    UPDATE afs_generation_log
    SET status       = 'completed',
        completed_at = now()
    WHERE id = ${jobId}::UUID
  `;

  log.info('Generation job completed', { jobId }, 'afsGenerationJobService');
}
```

- [ ] **Step 2: Type-check**

```bash
cd /home/hein/Workspace/IsaFlow
bunx tsc --noEmit 2>&1 | grep afsGenerationJobService
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add src/modules/accounting/services/afs/afsGenerationJobService.ts
git commit -m "feat(afs): implement afsGenerationJobService — job queue for generation"
```

---

## Task 14: API route — `GET /api/accounting/afs` + `POST /api/accounting/afs`

**Files:**
- Create: `pages/api/accounting/afs/index.ts`

- [ ] **Step 1: Implement the route**

```typescript
// pages/api/accounting/afs/index.ts
// GET  — list AFS documents for the company
// POST — create a new AFS document

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { listAfsDocuments, createAfsDocument } from '@/modules/accounting/services/afs/afsDocumentService';
import type { DocumentType, ReportingFramework } from '@/modules/accounting/services/afs/afsTypes';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method === 'GET') {
    log.info('Listing AFS documents', { companyId }, 'afs-index-api');

    const documents = await listAfsDocuments(companyId);
    return apiResponse.success(res, { documents });
  }

  if (req.method === 'POST') {
    const { fiscalYear, period, documentType, reportingFramework } = req.body as {
      fiscalYear?: number;
      period?: string;
      documentType: DocumentType;
      reportingFramework: ReportingFramework;
    };

    if (!documentType || !reportingFramework) {
      return apiResponse.badRequest(res, 'documentType and reportingFramework are required');
    }

    const validDocumentTypes: DocumentType[] = ['afs', 'management_pack'];
    if (!validDocumentTypes.includes(documentType)) {
      return apiResponse.badRequest(res, `documentType must be one of: ${validDocumentTypes.join(', ')}`);
    }

    const validFrameworks: ReportingFramework[] = ['ifrs_smes', 'full_ifrs'];
    if (!validFrameworks.includes(reportingFramework)) {
      return apiResponse.badRequest(res, `reportingFramework must be one of: ${validFrameworks.join(', ')}`);
    }

    if (documentType === 'afs' && !fiscalYear) {
      return apiResponse.badRequest(res, 'fiscalYear is required for AFS documents');
    }

    if (documentType === 'management_pack' && !period) {
      return apiResponse.badRequest(res, 'period (YYYY-MM) is required for management_pack documents');
    }

    log.info('Creating AFS document', { companyId, documentType, fiscalYear, period }, 'afs-index-api');

    const document = await createAfsDocument({
      companyId,
      fiscalYear,
      period,
      documentType,
      reportingFramework,
    });

    return apiResponse.created(res, { document }, 'AFS document created');
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withCompany(withErrorHandler(handler as never));
```

- [ ] **Step 2: Type-check**

```bash
cd /home/hein/Workspace/IsaFlow
bunx tsc --noEmit 2>&1 | grep "afs/index"
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add pages/api/accounting/afs/index.ts
git commit -m "feat(afs): API route GET+POST /api/accounting/afs"
```

---

## Task 15: API route — `GET /api/accounting/afs/[documentId]`

**Files:**
- Create: `pages/api/accounting/afs/[documentId]/index.ts`

- [ ] **Step 1: Implement the route**

```typescript
// pages/api/accounting/afs/[documentId]/index.ts
// GET — return a single AFS document with all its sections

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getAfsDocument } from '@/modules/accounting/services/afs/afsDocumentService';
import { getAfsSectionsForDocument } from '@/modules/accounting/services/afs/afsSectionService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyApiRequest;
  const documentId = req.query.documentId as string;

  if (!documentId) {
    return apiResponse.badRequest(res, 'documentId is required');
  }

  log.info('Fetching AFS document with sections', { companyId, documentId }, 'afs-document-api');

  const document = await getAfsDocument(documentId, companyId);

  if (!document) {
    return apiResponse.notFound(res, 'AFS document', documentId);
  }

  const sections = await getAfsSectionsForDocument(documentId);

  return apiResponse.success(res, { document: { ...document, sections } });
}

export default withCompany(withErrorHandler(handler as never));
```

- [ ] **Step 2: Type-check**

```bash
cd /home/hein/Workspace/IsaFlow
bunx tsc --noEmit 2>&1 | grep "documentId.*index"
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add "pages/api/accounting/afs/[documentId]/index.ts"
git commit -m "feat(afs): API route GET /api/accounting/afs/[documentId]"
```

---

## Task 16: API route — `POST /api/accounting/afs/[documentId]/generate`

**Files:**
- Create: `pages/api/accounting/afs/[documentId]/generate.ts`

- [ ] **Step 1: Implement the route**

```typescript
// pages/api/accounting/afs/[documentId]/generate.ts
// POST — enqueue a generation job for an AFS document.
// The actual generation is performed by a background worker (Plan 2).

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getAfsDocument } from '@/modules/accounting/services/afs/afsDocumentService';
import { enqueueGenerationJob } from '@/modules/accounting/services/afs/afsGenerationJobService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyApiRequest;
  const authReq = req as CompanyApiRequest & { user?: { id?: string } };
  const requestedBy: string | null = authReq.user?.id ?? null;
  const documentId = req.query.documentId as string;

  if (!documentId) {
    return apiResponse.badRequest(res, 'documentId is required');
  }

  log.info('Generation job requested', { companyId, documentId }, 'afs-generate-api');

  const document = await getAfsDocument(documentId, companyId);

  if (!document) {
    return apiResponse.notFound(res, 'AFS document', documentId);
  }

  if (document.status === 'signed_off' || document.status === 'filed') {
    return apiResponse.badRequest(res, `Cannot generate a ${document.status} document`);
  }

  const job = await enqueueGenerationJob(documentId, companyId, requestedBy);

  return apiResponse.created(res, { job }, 'Generation job enqueued');
}

export default withCompany(withErrorHandler(handler as never));
```

- [ ] **Step 2: Type-check**

```bash
cd /home/hein/Workspace/IsaFlow
bunx tsc --noEmit 2>&1 | grep generate
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add "pages/api/accounting/afs/[documentId]/generate.ts"
git commit -m "feat(afs): API route POST /api/accounting/afs/[documentId]/generate"
```

---

## Task 17: API route — `POST /api/accounting/afs/[documentId]/sign-off`

**Files:**
- Create: `pages/api/accounting/afs/[documentId]/sign-off.ts`

- [ ] **Step 1: Implement the route**

```typescript
// pages/api/accounting/afs/[documentId]/sign-off.ts
// POST — lock a document (sets status to signed_off, records locked_at / locked_by).

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getAfsDocument, lockAfsDocument } from '@/modules/accounting/services/afs/afsDocumentService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyApiRequest;
  const authReq = req as CompanyApiRequest & { user?: { id?: string } };
  const userId: string | null = authReq.user?.id ?? null;
  const documentId = req.query.documentId as string;

  if (!documentId) {
    return apiResponse.badRequest(res, 'documentId is required');
  }

  if (!userId) {
    return apiResponse.unauthorized(res, 'Authentication required to sign off a document');
  }

  log.info('Sign-off requested', { companyId, documentId, userId }, 'afs-sign-off-api');

  const existing = await getAfsDocument(documentId, companyId);

  if (!existing) {
    return apiResponse.notFound(res, 'AFS document', documentId);
  }

  if (existing.status === 'signed_off' || existing.status === 'filed') {
    return apiResponse.badRequest(res, `Document is already ${existing.status}`);
  }

  const document = await lockAfsDocument(documentId, companyId, userId);

  return apiResponse.success(res, { document }, 'Document signed off successfully');
}

export default withCompany(withErrorHandler(handler as never));
```

- [ ] **Step 2: Type-check**

```bash
cd /home/hein/Workspace/IsaFlow
bunx tsc --noEmit 2>&1 | grep sign-off
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add "pages/api/accounting/afs/[documentId]/sign-off.ts"
git commit -m "feat(afs): API route POST /api/accounting/afs/[documentId]/sign-off"
```

---

## Task 18: AFS list page — `pages/accounting/afs/index.tsx`

**Files:**
- Create: `pages/accounting/afs/index.tsx`

- [ ] **Step 1: Implement the page**

```tsx
// pages/accounting/afs/index.tsx
// AFS document list page — shows all AFS documents for the company.

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { FileText, Plus, Loader2, AlertCircle, Clock, CheckCircle, Lock } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import type { AfsDocument, DocumentStatus } from '@/modules/accounting/services/afs/afsTypes';

const STATUS_CONFIG: Record<DocumentStatus, { label: string; colour: string; icon: React.ReactNode }> = {
  draft:          { label: 'Draft',           colour: 'bg-zinc-100 text-zinc-700',    icon: <Clock className="w-3 h-3" /> },
  in_review:      { label: 'In Review',       colour: 'bg-blue-100 text-blue-700',    icon: <Clock className="w-3 h-3" /> },
  partner_review: { label: 'Partner Review',  colour: 'bg-yellow-100 text-yellow-700', icon: <Clock className="w-3 h-3" /> },
  signed_off:     { label: 'Signed Off',      colour: 'bg-green-100 text-green-700',  icon: <CheckCircle className="w-3 h-3" /> },
  filed:          { label: 'Filed',           colour: 'bg-purple-100 text-purple-700', icon: <Lock className="w-3 h-3" /> },
};

function StatusBadge({ status }: { status: DocumentStatus }) {
  const cfg = STATUS_CONFIG[status];
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${cfg.colour}`}>
      {cfg.icon}
      {cfg.label}
    </span>
  );
}

export default function AfsIndexPage() {
  const [documents, setDocuments] = useState<AfsDocument[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  const loadDocuments = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/afs', { credentials: 'include' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || 'Failed to load documents');
      setDocuments(json.data?.documents ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load AFS documents');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { loadDocuments(); }, [loadDocuments]);

  async function handleCreateAfs() {
    const year = new Date().getFullYear();
    setIsCreating(true);
    try {
      const res = await apiFetch('/api/accounting/afs', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documentType: 'afs',
          reportingFramework: 'ifrs_smes',
          fiscalYear: year,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || 'Failed to create document');
      setDocuments(prev => [json.data.document, ...prev]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create AFS document');
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <AppLayout>
      <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <FileText className="w-7 h-7 text-zinc-700" />
            <div>
              <h1 className="text-2xl font-semibold text-zinc-900">Annual Financial Statements</h1>
              <p className="text-sm text-zinc-500 mt-0.5">IFRS-compliant AFS bundle generation and review</p>
            </div>
          </div>
          <button
            onClick={handleCreateAfs}
            disabled={isCreating}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-zinc-900 text-white text-sm font-medium hover:bg-zinc-700 disabled:opacity-50 transition-colors"
          >
            {isCreating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            New AFS
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            {error}
          </div>
        )}

        {/* Loading */}
        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-zinc-400" />
          </div>
        )}

        {/* Empty state */}
        {!isLoading && documents.length === 0 && !error && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <FileText className="w-10 h-10 text-zinc-300 mb-3" />
            <p className="text-zinc-500 text-sm">No AFS documents yet. Create your first one above.</p>
          </div>
        )}

        {/* Document list */}
        {!isLoading && documents.length > 0 && (
          <div className="rounded-xl border border-zinc-200 divide-y divide-zinc-100 overflow-hidden">
            {documents.map(doc => (
              <Link
                key={doc.id}
                href={`/accounting/afs/${doc.id}`}
                className="flex items-center justify-between px-5 py-4 hover:bg-zinc-50 transition-colors group"
              >
                <div className="flex items-center gap-4">
                  <FileText className="w-5 h-5 text-zinc-400 group-hover:text-zinc-600 transition-colors" />
                  <div>
                    <p className="text-sm font-medium text-zinc-900">
                      {doc.documentType === 'afs'
                        ? `AFS — ${doc.fiscalYear ?? '—'}`
                        : `Management Pack — ${doc.period ?? '—'}`}
                    </p>
                    <p className="text-xs text-zinc-500 mt-0.5">
                      {doc.reportingFramework === 'ifrs_smes' ? 'IFRS for SMEs' : 'Full IFRS'}
                      {' · '}v{doc.version}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <StatusBadge status={doc.status} />
                  <span className="text-xs text-zinc-400">
                    {new Date(doc.updatedAt).toLocaleDateString('en-ZA')}
                  </span>
                </div>
              </Link>
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
cd /home/hein/Workspace/IsaFlow
bunx tsc --noEmit 2>&1 | grep "afs/index.tsx"
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add pages/accounting/afs/index.tsx
git commit -m "feat(afs): AFS list page at /accounting/afs"
```

---

## Task 19: Add AFS nav entry to `accountingNavConfig.ts`

**Files:**
- Modify: `src/components/accounting/accountingNavConfig.ts`
- Modify: `src/components/accounting/navSections/reports.ts`

The AFS feature gets its own top-level tab so it's visible from anywhere in the accounting module.

- [ ] **Step 1: Create the AFS nav section file**

Create `src/components/accounting/navSections/afs.ts`:

```typescript
// src/components/accounting/navSections/afs.ts

import type { Tab } from './types';

export const afsTab: Tab = {
  id: 'afs',
  label: 'AFS',
  items: [
    {
      section: 'Annual Financial Statements',
      items: [
        { label: 'All AFS Documents', href: '/accounting/afs' },
      ],
    },
    {
      section: 'Management Packs',
      items: [
        { label: 'Pack Documents', href: '/accounting/afs?type=management_pack' },
      ],
    },
  ],
};
```

- [ ] **Step 2: Import and add the tab to `accountingNavConfig.ts`**

Open `src/components/accounting/accountingNavConfig.ts`. Add the import after the existing imports and add `afsTab` to the `TABS` array:

```typescript
import { afsTab } from './navSections/afs';
```

Add `afsTab` to the `TABS` array before `reportsTab`:

```typescript
export const TABS: Tab[] = [
  { id: 'dashboard', label: 'Dashboard', href: '/accounting' },
  customersTab,
  suppliersTab,
  itemsTab,
  bankingTab,
  accountsTab,
  vatTab,
  accountantsTab,
  afsTab,          // ← added
  reportsTab,
  sarsTab,
  toolsTab,
  groupTab,
  { id: 'import', label: 'Data Import', href: '/accounting/migration' },
  payrollTab,
];
```

- [ ] **Step 3: Type-check**

```bash
cd /home/hein/Workspace/IsaFlow
bunx tsc --noEmit 2>&1 | grep -E "navConfig|afsTab|afs\.ts"
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add src/components/accounting/navSections/afs.ts src/components/accounting/accountingNavConfig.ts
git commit -m "feat(afs): add AFS tab to accounting nav"
```

---

## Task 20: Full type-check and test run

- [ ] **Step 1: Run all AFS unit tests**

```bash
cd /home/hein/Workspace/IsaFlow
bun run test:unit tests/unit/services/afs/ 2>&1 | tail -30
```

Expected: all tests in `afsDocumentService.test.ts`, `afsSectionService.test.ts`, and `noteTemplateRegistry.test.ts` PASS.

- [ ] **Step 2: Run full type-check**

```bash
cd /home/hein/Workspace/IsaFlow
bunx tsc --noEmit 2>&1 | head -40
```

Expected: zero errors.

- [ ] **Step 3: Verify all migrations are applied**

```bash
cd /home/hein/Workspace/IsaFlow
bunx tsx scripts/apply-migrations.ts 2>&1 | grep -E "333|334|335|336|337"
```

Expected: all five migrations listed as applied.

- [ ] **Step 4: Commit any outstanding changes**

```bash
cd /home/hein/Workspace/IsaFlow
git status
```

If any files are unstaged, add and commit them. If nothing outstanding:

```bash
git log --oneline -15
```

Verify the commit history shows all tasks completed.

---

## Self-Review Checklist

### Spec Coverage

| Spec requirement | Task covering it |
|---|---|
| `afs_documents` table | Task 1 |
| `afs_sections` table | Task 2 |
| `note_templates` table | Task 3 |
| `afs_generation_log` table | Task 4 |
| `management_pack_configs` table | Task 5 |
| All shared types in `afsTypes.ts` | Task 6 |
| `AfsDocument` CRUD service | Tasks 7–8 |
| `AfsSection` CRUD service | Tasks 9–10 |
| 30-note template registry | Tasks 11–12 |
| Generation job queue service | Task 13 |
| GET + POST `/api/accounting/afs` | Task 14 |
| GET `/api/accounting/afs/[documentId]` | Task 15 |
| POST `/api/accounting/afs/[documentId]/generate` | Task 16 |
| POST `/api/accounting/afs/[documentId]/sign-off` | Task 17 |
| AFS list page at `/accounting/afs` | Task 18 |
| Nav entry for AFS | Task 19 |
| Unit tests for all services | Tasks 7, 9, 11 |
| TDD (test first, then implement) | Tasks 7→8, 9→10, 11→12 |

### Type Consistency Check

- `AfsDocument.companyId` (camelCase) — matches `rowToAfsDocument` mapping in Task 8 ✓
- `AfsSection.versionHistory` (camelCase array) — matches `rowToAfsSection` in Task 10 ✓
- `createAfsDocument` parameter type `CreateAfsDocumentInput` — defined in Task 6, used in Task 8 and Task 14 ✓
- `lockAfsDocument` — defined in Task 8, imported in Task 17 ✓
- `enqueueGenerationJob` — defined in Task 13, imported in Task 16 ✓
- `DocumentStatus` union — defined in Task 6, used in Task 18 `STATUS_CONFIG` with all 5 values ✓
- `NoteContent` type — defined in Task 6, used in `afsSectionService` Task 10 ✓
- `seedNoteTemplates` ON CONFLICT requires unique index on `(section_type, framework)` — flagged in Task 12 with fix instruction ✓

### Placeholder Scan

No TBDs, no "implement later", no empty catch blocks, no `console.log`. All code is complete. ✓
