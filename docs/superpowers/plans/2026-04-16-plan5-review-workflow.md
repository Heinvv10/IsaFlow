# Plan 5 — AFS Review Workflow

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the full review lifecycle on top of the AFS document engine: section/document state machine with guarded transitions, per-section comment threads, version history with restore, and a proof-copy checklist for pre-promotion quality checks.

**Architecture:** One DB migration adds the `afs_section_comments` table. Four focused services implement the state machine (`afsReviewService`), comment CRUD (`afsSectionCommentService`), version snapshots (`afsVersionHistoryService`), and proof-copy checklist (`afsProofCopyService`). Seven new API routes plus one update to the existing document-level sign-off route wire everything to HTTP. Types are added to the existing `afsTypes.ts`.

**Tech Stack:** Next.js 14 Pages Router, TypeScript, Neon Postgres (`sql` tagged template), Vitest (unit tests), Bun (package manager), `@/lib/apiResponse`, `@/lib/auth` (`withCompany` + `CompanyApiRequest`), `@/lib/api-error-handler` (`withErrorHandler`), `@/lib/logger`.

**Depends on:** Plan 1 (Document Engine) — types, tables, and services already exist.

**What is NOT in scope:** UI pages, PDF watermarking (existing `proof-copy.ts` handles that), client annotation layer, e-signature (Plan 6), compliance checker (Plan 8).

---

## File Map

| Status | Path | Responsibility |
|--------|------|----------------|
| Create | `scripts/migrations/sql/340_afs_section_comments.sql` | `afs_section_comments` table |
| Modify | `src/modules/accounting/services/afs/afsTypes.ts` | Add review workflow types (DO NOT redefine existing types) |
| Create | `src/modules/accounting/services/afs/afsReviewService.ts` | State machine: section + document lifecycle transitions |
| Create | `src/modules/accounting/services/afs/afsSectionCommentService.ts` | Comment CRUD with threaded replies |
| Create | `src/modules/accounting/services/afs/afsVersionHistoryService.ts` | Version snapshots and restore |
| Create | `src/modules/accounting/services/afs/afsProofCopyService.ts` | Proof-copy checklist generator |
| Create | `pages/api/accounting/afs/[documentId]/submit-for-review.ts` | POST: promote draft -> in_review |
| Create | `pages/api/accounting/afs/[documentId]/proof-copy-checklist.ts` | GET: JSON checklist for pre-promotion checks |
| Create | `pages/api/accounting/afs/[documentId]/sections/[sectionId]/review.ts` | POST: mark section reviewed |
| Create | `pages/api/accounting/afs/[documentId]/sections/[sectionId]/sign-off.ts` | POST: sign off section |
| Create | `pages/api/accounting/afs/[documentId]/sections/[sectionId]/overrides.ts` | PUT: apply overrides with version snapshot |
| Create | `pages/api/accounting/afs/[documentId]/sections/[sectionId]/comments.ts` | GET + POST: comment threads |
| Create | `pages/api/accounting/afs/[documentId]/sections/[sectionId]/comments/[commentId]/resolve.ts` | POST: resolve comment |
| Create | `pages/api/accounting/afs/[documentId]/sections/[sectionId]/versions.ts` | GET + POST: version history + restore |
| Modify | `pages/api/accounting/afs/[documentId]/sign-off.ts` | Update to use `afsReviewService.signOffDocument` |
| Create | `tests/unit/services/afs/afsReviewService.test.ts` | Unit tests for review service |
| Create | `tests/unit/services/afs/afsSectionCommentService.test.ts` | Unit tests for comment service |

**Existing files NOT touched (no conflicts):**
- `pages/api/accounting/afs/[documentId]/proof-copy.ts` — stays as-is (PDF generation). New checklist uses different route.

---

## Task 1: Migration — `afs_section_comments` table

**Files:**
- Create: `scripts/migrations/sql/340_afs_section_comments.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 340_afs_section_comments.sql
-- Per-section threaded comments with resolution tracking for the review workflow.

CREATE TABLE IF NOT EXISTS afs_section_comments (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id    UUID        NOT NULL REFERENCES afs_sections(id) ON DELETE CASCADE,
  company_id    UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  author_id     TEXT        NOT NULL REFERENCES users(id),
  body          TEXT        NOT NULL,
  resolved      BOOLEAN     NOT NULL DEFAULT FALSE,
  resolved_by   TEXT        REFERENCES users(id),
  resolved_at   TIMESTAMPTZ,
  parent_id     UUID        REFERENCES afs_section_comments(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_afs_section_comments_section
  ON afs_section_comments(section_id);

CREATE INDEX IF NOT EXISTS idx_afs_section_comments_company
  ON afs_section_comments(company_id);

CREATE INDEX IF NOT EXISTS idx_afs_section_comments_parent
  ON afs_section_comments(parent_id);
```

**Notes:**
- `ON DELETE CASCADE` on `section_id` means comments are deleted when a section is deleted.
- `parent_id` is self-referential for threaded replies. `NULL` = top-level comment.
- `company_id` is denormalised onto every row so all queries remain tenant-scoped without joins.
- `author_id` and `resolved_by` are `TEXT` to match `users.id` type (same as `afs_sections.reviewed_by`).

- [ ] **Step 2: Run migration against dev DB**

```bash
psql "$DATABASE_URL" -f scripts/migrations/sql/340_afs_section_comments.sql
```

---

## Task 2: Type additions to `afsTypes.ts`

**Files:**
- Modify: `src/modules/accounting/services/afs/afsTypes.ts`

**IMPORTANT:** Do NOT redefine `SectionStatus`, `DocumentStatus`, `AfsSectionVersionEntry`, or `NoteContent` — they already exist in this file.

- [ ] **Step 1: Append review workflow types at the end of the file (before the closing API response shapes section)**

```typescript
// ── Review workflow additions ────────────────────────────────────────────────

export const SECTION_STATUS_ORDER: Record<SectionStatus, number> = {
  pending: 0,
  auto_generated: 1,
  ai_enhanced: 2,
  reviewed: 3,
  signed_off: 4,
};

export const DOCUMENT_STATUS_ORDER: Record<DocumentStatus, number> = {
  draft: 0,
  in_review: 1,
  partner_review: 2,
  signed_off: 3,
  filed: 4,
};

export interface AfsSectionComment {
  id: string;
  sectionId: string;
  companyId: string;
  authorId: string;
  body: string;
  resolved: boolean;
  resolvedBy: string | null;
  resolvedAt: Date | string | null;
  parentId: string | null;
  createdAt: Date | string;
}

export interface ProofCopyChecklistItem {
  key: string;
  label: string;
  checked: boolean;
}

export interface ProofCopyChecklist {
  documentId: string;
  generatedAt: string;
  items: ProofCopyChecklistItem[];
  allPassed: boolean;
}
```

- [ ] **Step 2: Verify no duplicate type names**

```bash
bunx tsc --noEmit
```

---

## Task 3: Service — `afsReviewService.ts`

**Files:**
- Create: `src/modules/accounting/services/afs/afsReviewService.ts`

### State machine rules

#### Section transitions

```
pending -> auto_generated -> ai_enhanced -> reviewed -> signed_off
```

| Transition | Guard |
|---|---|
| `-> auto_generated` | Generation pipeline only |
| `-> ai_enhanced` | `ai_narrative` must be non-empty |
| `-> reviewed` | Auth check only (accountant role) |
| `-> signed_off` | Zero unresolved comments on this section |

Any edit to a `signed_off` section: save a version entry, reset status to `reviewed`.

#### Document transitions

```
draft -> in_review -> partner_review -> signed_off -> filed
```

| Transition | Guard |
|---|---|
| `draft -> in_review` | ALL mandatory sections `reviewed` or `signed_off` |
| `in_review -> partner_review` | No additional guards |
| `partner_review -> signed_off` | ALL mandatory sections `signed_off` |
| `signed_off -> filed` | Plan 8 |
| Any edit on `signed_off` doc | 409 Conflict |

### Error type

```typescript
export class ReviewError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'UNRESOLVED_COMMENTS'
      | 'SECTIONS_NOT_READY'
      | 'DOCUMENT_LOCKED'
      | 'INVALID_TRANSITION'
      | 'NOT_FOUND'
  ) {
    super(message);
    this.name = 'ReviewError';
  }
}
```

- [ ] **Step 1: Create the service file**

```typescript
// src/modules/accounting/services/afs/afsReviewService.ts
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { SectionStatus, DocumentStatus } from './afsTypes';
import { SECTION_STATUS_ORDER } from './afsTypes';

// ── Error ───────────────────────────────────────────────────────────────────

export class ReviewError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'UNRESOLVED_COMMENTS'
      | 'SECTIONS_NOT_READY'
      | 'DOCUMENT_LOCKED'
      | 'INVALID_TRANSITION'
      | 'NOT_FOUND'
  ) {
    super(message);
    this.name = 'ReviewError';
  }
}

// ── Internal helpers ────────────────────────────────────────────────────────

interface SectionRow {
  id: string;
  document_id: string;
  status: SectionStatus;
}

interface DocumentRow {
  id: string;
  status: DocumentStatus;
}

async function getSectionWithDocument(
  companyId: string,
  sectionId: string
): Promise<{ section: SectionRow | null; document: DocumentRow | null }> {
  const rows = await sql`
    SELECT
      s.id            AS section_id,
      s.document_id,
      s.status        AS section_status,
      d.id            AS doc_id,
      d.status        AS doc_status
    FROM afs_sections s
    JOIN afs_documents d ON d.id = s.document_id AND d.company_id = ${companyId}
    WHERE s.id = ${sectionId}
      AND s.company_id = ${companyId}
  `;

  if (rows.length === 0) return { section: null, document: null };

  const r = rows[0];
  return {
    section: { id: r.section_id, document_id: r.document_id, status: r.section_status },
    document: { id: r.doc_id, status: r.doc_status },
  };
}

async function countUnresolvedComments(
  companyId: string,
  sectionId: string
): Promise<number> {
  const rows = await sql`
    SELECT COUNT(*)::int AS cnt
    FROM afs_section_comments
    WHERE section_id = ${sectionId}
      AND company_id = ${companyId}
      AND resolved = FALSE
  `;
  return rows[0]?.cnt ?? 0;
}

/**
 * Counts mandatory sections on a document that have status BELOW the given
 * minimum. Mandatory status comes from `note_templates.is_mandatory`.
 *
 * For primary statement sections (cover, directors_report, auditors_report,
 * statement_of_fp, income_statement, changes_in_equity, cash_flow) that have
 * no note_template row, they are always treated as mandatory.
 */
async function countMandatorySectionsBelow(
  companyId: string,
  documentId: string,
  minStatus: SectionStatus
): Promise<number> {
  const minOrder = SECTION_STATUS_ORDER[minStatus];

  // Primary statement section types are always mandatory (no template row)
  const rows = await sql`
    SELECT COUNT(*)::int AS cnt
    FROM afs_sections s
    LEFT JOIN note_templates nt
      ON nt.section_type = s.section_type
    WHERE s.document_id = ${documentId}
      AND s.company_id = ${companyId}
      AND (nt.is_mandatory = TRUE OR nt.id IS NULL)
      AND CASE s.status
            WHEN 'pending'        THEN 0
            WHEN 'auto_generated' THEN 1
            WHEN 'ai_enhanced'    THEN 2
            WHEN 'reviewed'       THEN 3
            WHEN 'signed_off'     THEN 4
          END < ${minOrder}
  `;
  return rows[0]?.cnt ?? 0;
}

async function getDocument(
  companyId: string,
  documentId: string
): Promise<DocumentRow | null> {
  const rows = await sql`
    SELECT id, status
    FROM afs_documents
    WHERE id = ${documentId}
      AND company_id = ${companyId}
  `;
  return rows.length > 0 ? rows[0] as DocumentRow : null;
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function markSectionReviewed(
  companyId: string,
  documentId: string,
  sectionId: string,
  userId: string
): Promise<{ sectionId: string; newStatus: SectionStatus }> {
  const { section, document } = await getSectionWithDocument(companyId, sectionId);

  if (!section || !document || document.id !== documentId) {
    throw new ReviewError('Section not found', 'NOT_FOUND');
  }

  if (document.status === 'signed_off' || document.status === 'filed') {
    throw new ReviewError('Document is locked — no edits allowed', 'DOCUMENT_LOCKED');
  }

  await sql`
    UPDATE afs_sections
    SET status = 'reviewed',
        reviewed_by = ${userId},
        reviewed_at = now(),
        updated_at = now()
    WHERE id = ${sectionId}
      AND document_id = ${documentId}
      AND company_id = ${companyId}
  `;

  log.info('Section marked reviewed', { sectionId, documentId, companyId, userId }, 'afsReviewService');
  return { sectionId, newStatus: 'reviewed' };
}

export async function signOffSection(
  companyId: string,
  documentId: string,
  sectionId: string,
  userId: string
): Promise<{ sectionId: string; newStatus: SectionStatus }> {
  const { section, document } = await getSectionWithDocument(companyId, sectionId);

  if (!section || !document || document.id !== documentId) {
    throw new ReviewError('Section not found', 'NOT_FOUND');
  }

  if (document.status === 'signed_off' || document.status === 'filed') {
    throw new ReviewError('Document is locked — no edits allowed', 'DOCUMENT_LOCKED');
  }

  const unresolvedCount = await countUnresolvedComments(companyId, sectionId);
  if (unresolvedCount > 0) {
    throw new ReviewError(
      `Cannot sign off: ${unresolvedCount} unresolved comment(s) on this section`,
      'UNRESOLVED_COMMENTS'
    );
  }

  await sql`
    UPDATE afs_sections
    SET status = 'signed_off',
        signed_off_by = ${userId},
        signed_off_at = now(),
        updated_at = now()
    WHERE id = ${sectionId}
      AND document_id = ${documentId}
      AND company_id = ${companyId}
  `;

  log.info('Section signed off', { sectionId, documentId, companyId, userId }, 'afsReviewService');
  return { sectionId, newStatus: 'signed_off' };
}

export async function submitDocumentForReview(
  companyId: string,
  documentId: string,
  userId: string
): Promise<{ documentId: string; newStatus: DocumentStatus }> {
  const doc = await getDocument(companyId, documentId);
  if (!doc) throw new ReviewError('Document not found', 'NOT_FOUND');

  if (doc.status !== 'draft') {
    throw new ReviewError(
      `Cannot submit: document status is '${doc.status}', expected 'draft'`,
      'INVALID_TRANSITION'
    );
  }

  const belowCount = await countMandatorySectionsBelow(companyId, documentId, 'reviewed');
  if (belowCount > 0) {
    throw new ReviewError(
      `Cannot submit: ${belowCount} mandatory section(s) not yet reviewed`,
      'SECTIONS_NOT_READY'
    );
  }

  await sql`
    UPDATE afs_documents
    SET status = 'in_review',
        updated_at = now()
    WHERE id = ${documentId}
      AND company_id = ${companyId}
  `;

  log.info('Document submitted for review', { documentId, companyId, userId }, 'afsReviewService');
  return { documentId, newStatus: 'in_review' };
}

export async function signOffDocument(
  companyId: string,
  documentId: string,
  userId: string
): Promise<{ documentId: string; newStatus: DocumentStatus }> {
  const doc = await getDocument(companyId, documentId);
  if (!doc) throw new ReviewError('Document not found', 'NOT_FOUND');

  if (doc.status !== 'partner_review' && doc.status !== 'in_review') {
    throw new ReviewError(
      `Cannot sign off: document status is '${doc.status}', expected 'in_review' or 'partner_review'`,
      'INVALID_TRANSITION'
    );
  }

  const belowCount = await countMandatorySectionsBelow(companyId, documentId, 'signed_off');
  if (belowCount > 0) {
    throw new ReviewError(
      `Cannot sign off: ${belowCount} mandatory section(s) not yet signed off`,
      'SECTIONS_NOT_READY'
    );
  }

  await sql`
    UPDATE afs_documents
    SET status = 'signed_off',
        locked_at = now(),
        locked_by = ${userId},
        updated_at = now()
    WHERE id = ${documentId}
      AND company_id = ${companyId}
  `;

  log.info('Document signed off', { documentId, companyId, userId }, 'afsReviewService');
  return { documentId, newStatus: 'signed_off' };
}

export async function promoteToPartnerReview(
  companyId: string,
  documentId: string,
  userId: string
): Promise<{ documentId: string; newStatus: DocumentStatus }> {
  const doc = await getDocument(companyId, documentId);
  if (!doc) throw new ReviewError('Document not found', 'NOT_FOUND');

  if (doc.status !== 'in_review') {
    throw new ReviewError(
      `Cannot promote: document status is '${doc.status}', expected 'in_review'`,
      'INVALID_TRANSITION'
    );
  }

  await sql`
    UPDATE afs_documents
    SET status = 'partner_review',
        updated_at = now()
    WHERE id = ${documentId}
      AND company_id = ${companyId}
  `;

  log.info('Document promoted to partner review', { documentId, companyId, userId }, 'afsReviewService');
  return { documentId, newStatus: 'partner_review' };
}

export async function assertDocumentEditable(
  companyId: string,
  documentId: string
): Promise<void> {
  const doc = await getDocument(companyId, documentId);
  if (!doc) throw new ReviewError('Document not found', 'NOT_FOUND');

  if (doc.status === 'signed_off' || doc.status === 'filed') {
    throw new ReviewError('Document is locked — no edits allowed', 'DOCUMENT_LOCKED');
  }
}
```

- [ ] **Step 2: Verify types compile**

```bash
bunx tsc --noEmit
```

---

## Task 4: Service — `afsSectionCommentService.ts`

**Files:**
- Create: `src/modules/accounting/services/afs/afsSectionCommentService.ts`

- [ ] **Step 1: Create the service file**

```typescript
// src/modules/accounting/services/afs/afsSectionCommentService.ts
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { AfsSectionComment } from './afsTypes';

// ── Error ───────────────────────────────────────────────────────────────────

export class CommentError extends Error {
  constructor(
    message: string,
    public readonly code: 'NOT_FOUND' | 'FORBIDDEN'
  ) {
    super(message);
    this.name = 'CommentError';
  }
}

// ── Internal helpers ────────────────────────────────────────────────────────

function mapRow(row: Record<string, unknown>): AfsSectionComment {
  return {
    id: row.id as string,
    sectionId: row.section_id as string,
    companyId: row.company_id as string,
    authorId: row.author_id as string,
    body: row.body as string,
    resolved: row.resolved as boolean,
    resolvedBy: (row.resolved_by as string) ?? null,
    resolvedAt: (row.resolved_at as Date) ?? null,
    parentId: (row.parent_id as string) ?? null,
    createdAt: row.created_at as Date,
  };
}

async function verifySectionBelongsToCompany(
  companyId: string,
  sectionId: string
): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM afs_sections
    WHERE id = ${sectionId}
      AND company_id = ${companyId}
    LIMIT 1
  `;
  return rows.length > 0;
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function listComments(
  companyId: string,
  sectionId: string
): Promise<AfsSectionComment[]> {
  const rows = await sql`
    SELECT c.*
    FROM afs_section_comments c
    JOIN afs_sections s ON s.id = c.section_id AND s.company_id = ${companyId}
    WHERE c.section_id = ${sectionId}
      AND c.company_id = ${companyId}
    ORDER BY c.created_at ASC
  `;
  return rows.map(mapRow);
}

export async function addComment(
  companyId: string,
  sectionId: string,
  authorId: string,
  body: string,
  parentId?: string
): Promise<AfsSectionComment> {
  const sectionExists = await verifySectionBelongsToCompany(companyId, sectionId);
  if (!sectionExists) {
    throw new CommentError('Section not found', 'NOT_FOUND');
  }

  if (parentId) {
    const parentRows = await sql`
      SELECT 1 FROM afs_section_comments
      WHERE id = ${parentId}
        AND section_id = ${sectionId}
        AND company_id = ${companyId}
      LIMIT 1
    `;
    if (parentRows.length === 0) {
      throw new CommentError('Parent comment not found on this section', 'NOT_FOUND');
    }
  }

  const rows = await sql`
    INSERT INTO afs_section_comments (section_id, company_id, author_id, body, parent_id)
    VALUES (${sectionId}, ${companyId}, ${authorId}, ${body}, ${parentId ?? null})
    RETURNING *
  `;

  log.info('Comment added', { sectionId, companyId, authorId, parentId }, 'afsSectionCommentService');
  return mapRow(rows[0]);
}

export async function resolveComment(
  companyId: string,
  commentId: string,
  resolvedBy: string
): Promise<AfsSectionComment> {
  const rows = await sql`
    UPDATE afs_section_comments
    SET resolved = TRUE,
        resolved_by = ${resolvedBy},
        resolved_at = now()
    WHERE id = ${commentId}
      AND company_id = ${companyId}
    RETURNING *
  `;

  if (rows.length === 0) {
    throw new CommentError('Comment not found', 'NOT_FOUND');
  }

  log.info('Comment resolved', { commentId, companyId, resolvedBy }, 'afsSectionCommentService');
  return mapRow(rows[0]);
}

export async function deleteComment(
  companyId: string,
  commentId: string,
  requesterId: string
): Promise<void> {
  const rows = await sql`
    SELECT author_id FROM afs_section_comments
    WHERE id = ${commentId}
      AND company_id = ${companyId}
  `;

  if (rows.length === 0) {
    throw new CommentError('Comment not found', 'NOT_FOUND');
  }

  if (rows[0].author_id !== requesterId) {
    throw new CommentError('Only the comment author can delete this comment', 'FORBIDDEN');
  }

  await sql`
    DELETE FROM afs_section_comments
    WHERE id = ${commentId}
      AND company_id = ${companyId}
  `;

  log.info('Comment deleted', { commentId, companyId, requesterId }, 'afsSectionCommentService');
}
```

- [ ] **Step 2: Verify types compile**

```bash
bunx tsc --noEmit
```

---

## Task 5: Service — `afsVersionHistoryService.ts`

**Files:**
- Create: `src/modules/accounting/services/afs/afsVersionHistoryService.ts`

- [ ] **Step 1: Create the service file**

```typescript
// src/modules/accounting/services/afs/afsVersionHistoryService.ts
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { AfsSectionVersionEntry, NoteContent } from './afsTypes';

// ── Internal helpers ────────────────────────────────────────────────────────

interface SectionContentRow {
  id: string;
  content: NoteContent | null;
  version_history: AfsSectionVersionEntry[];
  status: string;
}

async function getSectionContent(
  companyId: string,
  sectionId: string
): Promise<SectionContentRow | null> {
  const rows = await sql`
    SELECT id, content, version_history, status
    FROM afs_sections
    WHERE id = ${sectionId}
      AND company_id = ${companyId}
  `;
  return rows.length > 0 ? (rows[0] as unknown as SectionContentRow) : null;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Snapshots the current section content into version_history (prepended).
 * If the section is currently `signed_off`, resets status to `reviewed`.
 * Called by the overrides PUT handler BEFORE applying new overrides.
 */
export async function saveVersion(
  companyId: string,
  sectionId: string,
  userId: string
): Promise<AfsSectionVersionEntry> {
  const section = await getSectionContent(companyId, sectionId);
  if (!section) {
    throw new Error(`Section ${sectionId} not found for company ${companyId}`);
  }

  const currentHistory = Array.isArray(section.version_history) ? section.version_history : [];

  const newVersion: AfsSectionVersionEntry = {
    version: currentHistory.length + 1,
    savedAt: new Date().toISOString(),
    savedBy: userId,
    content: section.content ?? { title: '', blocks: [] },
  };

  await sql`
    UPDATE afs_sections
    SET version_history = jsonb_build_array(${JSON.stringify(newVersion)}::jsonb)
                          || COALESCE(version_history, '[]'::jsonb),
        status = CASE WHEN status = 'signed_off' THEN 'reviewed' ELSE status END,
        updated_at = now()
    WHERE id = ${sectionId}
      AND company_id = ${companyId}
  `;

  log.info('Version saved', { sectionId, companyId, userId, version: newVersion.version }, 'afsVersionHistoryService');
  return newVersion;
}

/**
 * Returns the version_history array from the section row.
 */
export async function listVersions(
  companyId: string,
  sectionId: string
): Promise<AfsSectionVersionEntry[]> {
  const section = await getSectionContent(companyId, sectionId);
  if (!section) {
    throw new Error(`Section ${sectionId} not found for company ${companyId}`);
  }
  return Array.isArray(section.version_history) ? section.version_history : [];
}

/**
 * Restores a previous version:
 * 1. Saves current state as a new version (restore is reversible)
 * 2. Sets section.content = target version's content snapshot
 * 3. Clears section.overrides
 * 4. Resets status to 'reviewed'
 */
export async function restoreVersion(
  companyId: string,
  sectionId: string,
  version: number,
  userId: string
): Promise<AfsSectionVersionEntry> {
  const section = await getSectionContent(companyId, sectionId);
  if (!section) {
    throw new Error(`Section ${sectionId} not found for company ${companyId}`);
  }

  const history = Array.isArray(section.version_history) ? section.version_history : [];
  const target = history.find((v) => v.version === version);
  if (!target) {
    throw new Error(`Version ${version} not found for section ${sectionId}`);
  }

  // Save current state as a new version first (so restore is reversible)
  const saveEntry = await saveVersion(companyId, sectionId, userId);

  // Now apply the target version's content
  await sql`
    UPDATE afs_sections
    SET content = ${JSON.stringify(target.content)}::jsonb,
        overrides = NULL,
        status = 'reviewed',
        updated_at = now()
    WHERE id = ${sectionId}
      AND company_id = ${companyId}
  `;

  log.info('Version restored', {
    sectionId, companyId, userId,
    restoredVersion: version,
    newVersionEntry: saveEntry.version,
  }, 'afsVersionHistoryService');

  return saveEntry;
}
```

- [ ] **Step 2: Verify types compile**

```bash
bunx tsc --noEmit
```

---

## Task 6: Service — `afsProofCopyService.ts`

**Files:**
- Create: `src/modules/accounting/services/afs/afsProofCopyService.ts`

### Checklist items

| Key | Label | Passes when |
|---|---|---|
| `all_mandatory_sections_reviewed` | All mandatory sections reviewed or signed off | Count of mandatory sections below `reviewed` = 0 |
| `no_unresolved_comments` | No unresolved comments on any section | Sum of unresolved comments across all document sections = 0 |
| `directors_report_reviewed` | Director's report section reviewed | Director's Report section is `reviewed` or above |
| `comparative_figures_present` | Comparative figures present | Prior year `data_snapshot` is non-empty on balance sheet section |
| `registration_number_present` | Company registration number correct | `companies.registration_number` is non-empty |
| `auditors_report_reviewed` | Auditor's report section reviewed | Auditor's Report section is `reviewed` or above |
| `note_cross_references_accurate` | Note cross-references accurate | Manual — defaults `false` |
| `page_numbers_sequential` | Page numbers sequential | Manual — defaults `false` |
| `toc_page_numbers_match` | Table of contents page numbers match | Manual — defaults `false` |

- [ ] **Step 1: Create the service file**

```typescript
// src/modules/accounting/services/afs/afsProofCopyService.ts
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { ProofCopyChecklist, ProofCopyChecklistItem } from './afsTypes';
import { SECTION_STATUS_ORDER } from './afsTypes';

// ── Internal helpers ────────────────────────────────────────────────────────

async function countMandatorySectionsBelowReviewed(
  companyId: string,
  documentId: string
): Promise<number> {
  const minOrder = SECTION_STATUS_ORDER.reviewed;
  const rows = await sql`
    SELECT COUNT(*)::int AS cnt
    FROM afs_sections s
    LEFT JOIN note_templates nt ON nt.section_type = s.section_type
    WHERE s.document_id = ${documentId}
      AND s.company_id = ${companyId}
      AND (nt.is_mandatory = TRUE OR nt.id IS NULL)
      AND CASE s.status
            WHEN 'pending'        THEN 0
            WHEN 'auto_generated' THEN 1
            WHEN 'ai_enhanced'    THEN 2
            WHEN 'reviewed'       THEN 3
            WHEN 'signed_off'     THEN 4
          END < ${minOrder}
  `;
  return rows[0]?.cnt ?? 0;
}

async function countUnresolvedCommentsForDocument(
  companyId: string,
  documentId: string
): Promise<number> {
  const rows = await sql`
    SELECT COUNT(*)::int AS cnt
    FROM afs_section_comments c
    JOIN afs_sections s ON s.id = c.section_id
    WHERE s.document_id = ${documentId}
      AND c.company_id = ${companyId}
      AND c.resolved = FALSE
  `;
  return rows[0]?.cnt ?? 0;
}

async function getSectionStatusByType(
  companyId: string,
  documentId: string,
  sectionType: string
): Promise<string | null> {
  const rows = await sql`
    SELECT status FROM afs_sections
    WHERE document_id = ${documentId}
      AND company_id = ${companyId}
      AND section_type = ${sectionType}
    LIMIT 1
  `;
  return rows.length > 0 ? (rows[0].status as string) : null;
}

async function hasComparativeFigures(
  companyId: string,
  documentId: string
): Promise<boolean> {
  const rows = await sql`
    SELECT data_snapshot FROM afs_sections
    WHERE document_id = ${documentId}
      AND company_id = ${companyId}
      AND section_type = 'statement_of_fp'
    LIMIT 1
  `;
  if (rows.length === 0) return false;
  const snapshot = rows[0].data_snapshot;
  return snapshot !== null && typeof snapshot === 'object' && Object.keys(snapshot).length > 0;
}

async function hasRegistrationNumber(companyId: string): Promise<boolean> {
  const rows = await sql`
    SELECT registration_number FROM companies
    WHERE id = ${companyId}
  `;
  if (rows.length === 0) return false;
  const regNum = rows[0].registration_number;
  return typeof regNum === 'string' && regNum.trim().length > 0;
}

function isReviewedOrAbove(status: string | null): boolean {
  if (!status) return false;
  return SECTION_STATUS_ORDER[status as keyof typeof SECTION_STATUS_ORDER] >= SECTION_STATUS_ORDER.reviewed;
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function getProofCopyChecklist(
  companyId: string,
  documentId: string
): Promise<ProofCopyChecklist> {
  // Verify document exists
  const docRows = await sql`
    SELECT id FROM afs_documents
    WHERE id = ${documentId} AND company_id = ${companyId}
  `;
  if (docRows.length === 0) {
    throw new Error(`AFS document ${documentId} not found`);
  }

  // Run automated checks in parallel
  const [
    mandatoryBelowCount,
    unresolvedCount,
    directorsStatus,
    auditorsStatus,
    hasComparatives,
    hasRegNum,
  ] = await Promise.all([
    countMandatorySectionsBelowReviewed(companyId, documentId),
    countUnresolvedCommentsForDocument(companyId, documentId),
    getSectionStatusByType(companyId, documentId, 'directors_report'),
    getSectionStatusByType(companyId, documentId, 'auditors_report'),
    hasComparativeFigures(companyId, documentId),
    hasRegistrationNumber(companyId),
  ]);

  const items: ProofCopyChecklistItem[] = [
    {
      key: 'all_mandatory_sections_reviewed',
      label: 'All mandatory sections reviewed or signed off',
      checked: mandatoryBelowCount === 0,
    },
    {
      key: 'no_unresolved_comments',
      label: 'No unresolved comments on any section',
      checked: unresolvedCount === 0,
    },
    {
      key: 'directors_report_reviewed',
      label: "Director's report section reviewed",
      checked: isReviewedOrAbove(directorsStatus),
    },
    {
      key: 'comparative_figures_present',
      label: 'Comparative figures present',
      checked: hasComparatives,
    },
    {
      key: 'registration_number_present',
      label: 'Company registration number correct',
      checked: hasRegNum,
    },
    {
      key: 'auditors_report_reviewed',
      label: "Auditor's report section reviewed",
      checked: isReviewedOrAbove(auditorsStatus),
    },
    // Manual items — always false, accountant must verify
    {
      key: 'note_cross_references_accurate',
      label: 'Note cross-references accurate',
      checked: false,
    },
    {
      key: 'page_numbers_sequential',
      label: 'Page numbers sequential',
      checked: false,
    },
    {
      key: 'toc_page_numbers_match',
      label: 'Table of contents page numbers match',
      checked: false,
    },
  ];

  const checklist: ProofCopyChecklist = {
    documentId,
    generatedAt: new Date().toISOString(),
    items,
    allPassed: items.every((i) => i.checked),
  };

  log.info('Proof copy checklist generated', {
    documentId, companyId, allPassed: checklist.allPassed,
  }, 'afsProofCopyService');

  return checklist;
}
```

- [ ] **Step 2: Verify types compile**

```bash
bunx tsc --noEmit
```

---

## Task 7: API Routes

All routes follow this pattern:

```typescript
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';

// handler function...

export default withCompany(withErrorHandler(handler as never));
```

`ReviewError` and `CommentError` map to HTTP status codes at the handler level:

| Error code | HTTP |
|---|---|
| `DOCUMENT_LOCKED` | 409 Conflict |
| `UNRESOLVED_COMMENTS` | 409 Conflict |
| `SECTIONS_NOT_READY` | 409 Conflict |
| `INVALID_TRANSITION` | 409 Conflict |
| `NOT_FOUND` | 404 |
| `FORBIDDEN` | 403 |

---

### 7.1 `pages/api/accounting/afs/[documentId]/submit-for-review.ts`

- [ ] **Step 1: Create route file**

```typescript
// pages/api/accounting/afs/[documentId]/submit-for-review.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  submitDocumentForReview,
  ReviewError,
} from '@/modules/accounting/services/afs/afsReviewService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const companyReq = req as CompanyApiRequest;
  const { companyId } = companyReq;
  const userId = companyReq.user.id;
  const documentId = req.query.documentId as string;

  log.info('Submit for review requested', { companyId, documentId, userId }, 'afs-submit-review-api');

  try {
    const result = await submitDocumentForReview(companyId, documentId, userId);
    return apiResponse.success(res, result, 'Document submitted for review');
  } catch (err) {
    if (err instanceof ReviewError) {
      if (err.code === 'NOT_FOUND') return apiResponse.notFound(res, 'AFS document', documentId);
      return apiResponse.error(res, ErrorCode.CONFLICT, err.message);
    }
    throw err;
  }
}

export default withCompany(withErrorHandler(handler as never));
```

---

### 7.2 `pages/api/accounting/afs/[documentId]/proof-copy-checklist.ts`

- [ ] **Step 1: Create route file**

```typescript
// pages/api/accounting/afs/[documentId]/proof-copy-checklist.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getProofCopyChecklist } from '@/modules/accounting/services/afs/afsProofCopyService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyApiRequest;
  const documentId = req.query.documentId as string;

  log.info('Proof copy checklist requested', { companyId, documentId }, 'afs-proof-checklist-api');

  const checklist = await getProofCopyChecklist(companyId, documentId);
  return apiResponse.success(res, checklist);
}

export default withCompany(withErrorHandler(handler as never));
```

---

### 7.3 `pages/api/accounting/afs/[documentId]/sections/[sectionId]/review.ts`

- [ ] **Step 1: Create route file**

```typescript
// pages/api/accounting/afs/[documentId]/sections/[sectionId]/review.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  markSectionReviewed,
  ReviewError,
} from '@/modules/accounting/services/afs/afsReviewService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const companyReq = req as CompanyApiRequest;
  const { companyId } = companyReq;
  const userId = companyReq.user.id;
  const documentId = req.query.documentId as string;
  const sectionId = req.query.sectionId as string;

  log.info('Section review requested', { companyId, documentId, sectionId, userId }, 'afs-section-review-api');

  try {
    const result = await markSectionReviewed(companyId, documentId, sectionId, userId);
    return apiResponse.success(res, result, 'Section marked as reviewed');
  } catch (err) {
    if (err instanceof ReviewError) {
      if (err.code === 'NOT_FOUND') return apiResponse.notFound(res, 'AFS section', sectionId);
      return apiResponse.error(res, ErrorCode.CONFLICT, err.message);
    }
    throw err;
  }
}

export default withCompany(withErrorHandler(handler as never));
```

---

### 7.4 `pages/api/accounting/afs/[documentId]/sections/[sectionId]/sign-off.ts`

- [ ] **Step 1: Create route file**

```typescript
// pages/api/accounting/afs/[documentId]/sections/[sectionId]/sign-off.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  signOffSection,
  ReviewError,
} from '@/modules/accounting/services/afs/afsReviewService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const companyReq = req as CompanyApiRequest;
  const { companyId } = companyReq;
  const userId = companyReq.user.id;
  const documentId = req.query.documentId as string;
  const sectionId = req.query.sectionId as string;

  log.info('Section sign-off requested', { companyId, documentId, sectionId, userId }, 'afs-section-signoff-api');

  try {
    const result = await signOffSection(companyId, documentId, sectionId, userId);
    return apiResponse.success(res, result, 'Section signed off');
  } catch (err) {
    if (err instanceof ReviewError) {
      if (err.code === 'NOT_FOUND') return apiResponse.notFound(res, 'AFS section', sectionId);
      return apiResponse.error(res, ErrorCode.CONFLICT, err.message);
    }
    throw err;
  }
}

export default withCompany(withErrorHandler(handler as never));
```

---

### 7.5 `pages/api/accounting/afs/[documentId]/sections/[sectionId]/overrides.ts`

- [ ] **Step 1: Create route file**

```typescript
// pages/api/accounting/afs/[documentId]/sections/[sectionId]/overrides.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import {
  assertDocumentEditable,
  ReviewError,
} from '@/modules/accounting/services/afs/afsReviewService';
import { saveVersion } from '@/modules/accounting/services/afs/afsVersionHistoryService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'PUT') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['PUT']);
  }

  const companyReq = req as CompanyApiRequest;
  const { companyId } = companyReq;
  const userId = companyReq.user.id;
  const documentId = req.query.documentId as string;
  const sectionId = req.query.sectionId as string;
  const { overrides } = req.body ?? {};

  if (!overrides || typeof overrides !== 'object') {
    return apiResponse.badRequest(res, 'Request body must include an "overrides" object');
  }

  log.info('Section overrides update', { companyId, documentId, sectionId, userId }, 'afs-overrides-api');

  try {
    await assertDocumentEditable(companyId, documentId);
  } catch (err) {
    if (err instanceof ReviewError) {
      if (err.code === 'NOT_FOUND') return apiResponse.notFound(res, 'AFS document', documentId);
      return apiResponse.error(res, ErrorCode.CONFLICT, err.message);
    }
    throw err;
  }

  // Save version snapshot BEFORE applying overrides
  const versionEntry = await saveVersion(companyId, sectionId, userId);

  // Apply new overrides
  await sql`
    UPDATE afs_sections
    SET overrides = ${JSON.stringify(overrides)}::jsonb,
        updated_at = now()
    WHERE id = ${sectionId}
      AND document_id = ${documentId}
      AND company_id = ${companyId}
  `;

  return apiResponse.success(res, { sectionId, version: versionEntry }, 'Overrides applied');
}

export default withCompany(withErrorHandler(handler as never));
```

---

### 7.6 `pages/api/accounting/afs/[documentId]/sections/[sectionId]/comments.ts`

- [ ] **Step 1: Create route file**

```typescript
// pages/api/accounting/afs/[documentId]/sections/[sectionId]/comments.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  listComments,
  addComment,
  CommentError,
} from '@/modules/accounting/services/afs/afsSectionCommentService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const companyReq = req as CompanyApiRequest;
  const { companyId } = companyReq;
  const sectionId = req.query.sectionId as string;

  if (req.method === 'GET') {
    const items = await listComments(companyId, sectionId);
    return apiResponse.success(res, { items });
  }

  if (req.method === 'POST') {
    const userId = companyReq.user.id;
    const { body, parentId } = req.body ?? {};

    if (!body || typeof body !== 'string' || body.trim().length === 0) {
      return apiResponse.badRequest(res, 'Comment body is required');
    }

    log.info('Adding comment', { companyId, sectionId, userId, parentId }, 'afs-comments-api');

    try {
      const comment = await addComment(companyId, sectionId, userId, body.trim(), parentId);
      return apiResponse.created(res, comment, 'Comment added');
    } catch (err) {
      if (err instanceof CommentError && err.code === 'NOT_FOUND') {
        return apiResponse.notFound(res, 'AFS section or parent comment', sectionId);
      }
      throw err;
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withCompany(withErrorHandler(handler as never));
```

---

### 7.7 `pages/api/accounting/afs/[documentId]/sections/[sectionId]/comments/[commentId]/resolve.ts`

- [ ] **Step 1: Create route file**

```typescript
// pages/api/accounting/afs/[documentId]/sections/[sectionId]/comments/[commentId]/resolve.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  resolveComment,
  CommentError,
} from '@/modules/accounting/services/afs/afsSectionCommentService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const companyReq = req as CompanyApiRequest;
  const { companyId } = companyReq;
  const userId = companyReq.user.id;
  const commentId = req.query.commentId as string;

  log.info('Resolving comment', { companyId, commentId, userId }, 'afs-comment-resolve-api');

  try {
    const comment = await resolveComment(companyId, commentId, userId);
    return apiResponse.success(res, comment, 'Comment resolved');
  } catch (err) {
    if (err instanceof CommentError) {
      if (err.code === 'NOT_FOUND') return apiResponse.notFound(res, 'Comment', commentId);
      return apiResponse.error(res, ErrorCode.FORBIDDEN, err.message);
    }
    throw err;
  }
}

export default withCompany(withErrorHandler(handler as never));
```

---

### 7.8 `pages/api/accounting/afs/[documentId]/sections/[sectionId]/versions.ts`

- [ ] **Step 1: Create route file**

```typescript
// pages/api/accounting/afs/[documentId]/sections/[sectionId]/versions.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  assertDocumentEditable,
  ReviewError,
} from '@/modules/accounting/services/afs/afsReviewService';
import {
  listVersions,
  restoreVersion,
} from '@/modules/accounting/services/afs/afsVersionHistoryService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const companyReq = req as CompanyApiRequest;
  const { companyId } = companyReq;
  const documentId = req.query.documentId as string;
  const sectionId = req.query.sectionId as string;

  if (req.method === 'GET') {
    const items = await listVersions(companyId, sectionId);
    return apiResponse.success(res, { items });
  }

  if (req.method === 'POST') {
    const userId = companyReq.user.id;
    const { version } = req.body ?? {};

    if (typeof version !== 'number' || version < 1) {
      return apiResponse.badRequest(res, '"version" must be a positive integer');
    }

    log.info('Version restore requested', { companyId, documentId, sectionId, version, userId }, 'afs-versions-api');

    try {
      await assertDocumentEditable(companyId, documentId);
    } catch (err) {
      if (err instanceof ReviewError) {
        if (err.code === 'NOT_FOUND') return apiResponse.notFound(res, 'AFS document', documentId);
        return apiResponse.error(res, ErrorCode.CONFLICT, err.message);
      }
      throw err;
    }

    const newVersionEntry = await restoreVersion(companyId, sectionId, version, userId);
    return apiResponse.success(res, {
      sectionId,
      restoredVersion: version,
      newVersionEntry,
    }, 'Version restored');
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withCompany(withErrorHandler(handler as never));
```

---

### 7.9 Update existing `pages/api/accounting/afs/[documentId]/sign-off.ts`

The existing route calls `lockAfsDocument` directly. Update it to use `afsReviewService.signOffDocument` which enforces the full state machine (all mandatory sections must be signed off).

- [ ] **Step 1: Update the existing route**

Replace the entire handler body with:

```typescript
// pages/api/accounting/afs/[documentId]/sign-off.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  signOffDocument,
  ReviewError,
} from '@/modules/accounting/services/afs/afsReviewService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const companyReq = req as CompanyApiRequest;
  const { companyId } = companyReq;
  const userId = companyReq.user.id;
  const documentId = req.query.documentId as string;

  log.info('Document sign-off requested', { companyId, documentId, userId }, 'afs-sign-off-api');

  try {
    const result = await signOffDocument(companyId, documentId, userId);
    return apiResponse.success(res, result, 'Document signed off successfully');
  } catch (err) {
    if (err instanceof ReviewError) {
      if (err.code === 'NOT_FOUND') return apiResponse.notFound(res, 'AFS document', documentId);
      return apiResponse.error(res, ErrorCode.CONFLICT, err.message);
    }
    throw err;
  }
}

export default withCompany(withErrorHandler(handler as never));
```

---

## Task 8: Tests — `afsReviewService.test.ts`

**Files:**
- Create: `tests/unit/services/afs/afsReviewService.test.ts`

- [ ] **Step 1: Create the test file**

```typescript
// tests/unit/services/afs/afsReviewService.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
import {
  ReviewError,
  markSectionReviewed,
  signOffSection,
  submitDocumentForReview,
  signOffDocument,
  assertDocumentEditable,
} from '@/modules/accounting/services/afs/afsReviewService';

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
const CID = 'company-1';
const DOC = 'doc-1';
const SEC = 'sec-1';
const USER = 'user-1';

beforeEach(() => {
  vi.clearAllMocks();
});

// ── signOffSection ──────────────────────────────────────────────────────────

describe('signOffSection', () => {
  it('succeeds when zero unresolved comments and doc is editable', async () => {
    // getSectionWithDocument
    mockSql.mockResolvedValueOnce([{
      section_id: SEC, document_id: DOC, section_status: 'reviewed',
      doc_id: DOC, doc_status: 'in_review',
    }]);
    // countUnresolvedComments
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);
    // UPDATE
    mockSql.mockResolvedValueOnce([]);

    const result = await signOffSection(CID, DOC, SEC, USER);
    expect(result).toEqual({ sectionId: SEC, newStatus: 'signed_off' });
    expect(mockSql).toHaveBeenCalledTimes(3);
  });

  it('blocks when unresolved comments exist', async () => {
    mockSql.mockResolvedValueOnce([{
      section_id: SEC, document_id: DOC, section_status: 'reviewed',
      doc_id: DOC, doc_status: 'in_review',
    }]);
    mockSql.mockResolvedValueOnce([{ cnt: 2 }]);

    await expect(signOffSection(CID, DOC, SEC, USER))
      .rejects.toThrow(ReviewError);
    await expect(signOffSection(CID, DOC, SEC, USER).catch((e: ReviewError) => e.code))
      .resolves.toBe(undefined); // already thrown above, test code below

    // Re-test cleanly
    mockSql.mockResolvedValueOnce([{
      section_id: SEC, document_id: DOC, section_status: 'reviewed',
      doc_id: DOC, doc_status: 'in_review',
    }]);
    mockSql.mockResolvedValueOnce([{ cnt: 2 }]);

    try {
      await signOffSection(CID, DOC, SEC, USER);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewError);
      expect((err as ReviewError).code).toBe('UNRESOLVED_COMMENTS');
    }
  });

  it('blocks when document is signed_off', async () => {
    mockSql.mockResolvedValueOnce([{
      section_id: SEC, document_id: DOC, section_status: 'reviewed',
      doc_id: DOC, doc_status: 'signed_off',
    }]);

    try {
      await signOffSection(CID, DOC, SEC, USER);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewError);
      expect((err as ReviewError).code).toBe('DOCUMENT_LOCKED');
    }
  });

  it('blocks when document is filed', async () => {
    mockSql.mockResolvedValueOnce([{
      section_id: SEC, document_id: DOC, section_status: 'reviewed',
      doc_id: DOC, doc_status: 'filed',
    }]);

    try {
      await signOffSection(CID, DOC, SEC, USER);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewError);
      expect((err as ReviewError).code).toBe('DOCUMENT_LOCKED');
    }
  });

  it('throws NOT_FOUND when section does not exist', async () => {
    mockSql.mockResolvedValueOnce([]);

    try {
      await signOffSection(CID, DOC, SEC, USER);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewError);
      expect((err as ReviewError).code).toBe('NOT_FOUND');
    }
  });
});

// ── submitDocumentForReview ─────────────────────────────────────────────────

describe('submitDocumentForReview', () => {
  it('succeeds when all mandatory sections are reviewed', async () => {
    // getDocument
    mockSql.mockResolvedValueOnce([{ id: DOC, status: 'draft' }]);
    // countMandatorySectionsBelow
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);
    // UPDATE
    mockSql.mockResolvedValueOnce([]);

    const result = await submitDocumentForReview(CID, DOC, USER);
    expect(result).toEqual({ documentId: DOC, newStatus: 'in_review' });
  });

  it('blocks when mandatory sections are not ready', async () => {
    mockSql.mockResolvedValueOnce([{ id: DOC, status: 'draft' }]);
    mockSql.mockResolvedValueOnce([{ cnt: 3 }]);

    try {
      await submitDocumentForReview(CID, DOC, USER);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewError);
      expect((err as ReviewError).code).toBe('SECTIONS_NOT_READY');
    }
  });

  it('throws NOT_FOUND when document does not exist', async () => {
    mockSql.mockResolvedValueOnce([]);

    try {
      await submitDocumentForReview(CID, DOC, USER);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewError);
      expect((err as ReviewError).code).toBe('NOT_FOUND');
    }
  });

  it('throws INVALID_TRANSITION when document is not draft', async () => {
    mockSql.mockResolvedValueOnce([{ id: DOC, status: 'in_review' }]);

    try {
      await submitDocumentForReview(CID, DOC, USER);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewError);
      expect((err as ReviewError).code).toBe('INVALID_TRANSITION');
    }
  });
});

// ── assertDocumentEditable ──────────────────────────────────────────────────

describe('assertDocumentEditable', () => {
  it('passes for draft', async () => {
    mockSql.mockResolvedValueOnce([{ id: DOC, status: 'draft' }]);
    await expect(assertDocumentEditable(CID, DOC)).resolves.toBeUndefined();
  });

  it('passes for in_review', async () => {
    mockSql.mockResolvedValueOnce([{ id: DOC, status: 'in_review' }]);
    await expect(assertDocumentEditable(CID, DOC)).resolves.toBeUndefined();
  });

  it('throws DOCUMENT_LOCKED for signed_off', async () => {
    mockSql.mockResolvedValueOnce([{ id: DOC, status: 'signed_off' }]);

    try {
      await assertDocumentEditable(CID, DOC);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewError);
      expect((err as ReviewError).code).toBe('DOCUMENT_LOCKED');
    }
  });

  it('throws DOCUMENT_LOCKED for filed', async () => {
    mockSql.mockResolvedValueOnce([{ id: DOC, status: 'filed' }]);

    try {
      await assertDocumentEditable(CID, DOC);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewError);
      expect((err as ReviewError).code).toBe('DOCUMENT_LOCKED');
    }
  });

  it('throws NOT_FOUND when document does not exist', async () => {
    mockSql.mockResolvedValueOnce([]);

    try {
      await assertDocumentEditable(CID, DOC);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewError);
      expect((err as ReviewError).code).toBe('NOT_FOUND');
    }
  });
});
```

---

## Task 9: Tests — `afsSectionCommentService.test.ts`

**Files:**
- Create: `tests/unit/services/afs/afsSectionCommentService.test.ts`

- [ ] **Step 1: Create the test file**

```typescript
// tests/unit/services/afs/afsSectionCommentService.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
import {
  CommentError,
  listComments,
  addComment,
  resolveComment,
  deleteComment,
} from '@/modules/accounting/services/afs/afsSectionCommentService';

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
const CID = 'company-1';
const SEC = 'sec-1';
const USER = 'user-1';
const COMMENT = 'comment-1';

beforeEach(() => {
  vi.clearAllMocks();
});

// ── addComment ──────────────────────────────────────────────────────────────

describe('addComment', () => {
  const commentRow = {
    id: COMMENT, section_id: SEC, company_id: CID,
    author_id: USER, body: 'Test comment', resolved: false,
    resolved_by: null, resolved_at: null, parent_id: null,
    created_at: new Date(),
  };

  it('creates a top-level comment', async () => {
    // verifySectionBelongsToCompany
    mockSql.mockResolvedValueOnce([{ '?column?': 1 }]);
    // INSERT RETURNING
    mockSql.mockResolvedValueOnce([commentRow]);

    const result = await addComment(CID, SEC, USER, 'Test comment');
    expect(result.id).toBe(COMMENT);
    expect(result.parentId).toBeNull();
  });

  it('creates a reply when parentId is valid', async () => {
    // verifySectionBelongsToCompany
    mockSql.mockResolvedValueOnce([{ '?column?': 1 }]);
    // parent validation
    mockSql.mockResolvedValueOnce([{ '?column?': 1 }]);
    // INSERT RETURNING
    mockSql.mockResolvedValueOnce([{ ...commentRow, parent_id: 'parent-1' }]);

    const result = await addComment(CID, SEC, USER, 'Reply', 'parent-1');
    expect(result.parentId).toBe('parent-1');
  });

  it('rejects invalid parentId', async () => {
    mockSql.mockResolvedValueOnce([{ '?column?': 1 }]);
    mockSql.mockResolvedValueOnce([]);

    try {
      await addComment(CID, SEC, USER, 'Reply', 'bad-parent');
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CommentError);
      expect((err as CommentError).code).toBe('NOT_FOUND');
    }
  });

  it('rejects when section not found', async () => {
    mockSql.mockResolvedValueOnce([]);

    try {
      await addComment(CID, SEC, USER, 'Test');
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CommentError);
      expect((err as CommentError).code).toBe('NOT_FOUND');
    }
  });
});

// ── resolveComment ──────────────────────────────────────────────────────────

describe('resolveComment', () => {
  it('resolves an existing comment', async () => {
    mockSql.mockResolvedValueOnce([{
      id: COMMENT, section_id: SEC, company_id: CID,
      author_id: USER, body: 'Test', resolved: true,
      resolved_by: USER, resolved_at: new Date(), parent_id: null,
      created_at: new Date(),
    }]);

    const result = await resolveComment(CID, COMMENT, USER);
    expect(result.resolved).toBe(true);
    expect(result.resolvedBy).toBe(USER);
  });

  it('throws NOT_FOUND when comment not found', async () => {
    mockSql.mockResolvedValueOnce([]);

    try {
      await resolveComment(CID, COMMENT, USER);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CommentError);
      expect((err as CommentError).code).toBe('NOT_FOUND');
    }
  });
});

// ── deleteComment ───────────────────────────────────────────────────────────

describe('deleteComment', () => {
  it('deletes when requester is the author', async () => {
    mockSql.mockResolvedValueOnce([{ author_id: USER }]);
    mockSql.mockResolvedValueOnce([]);

    await expect(deleteComment(CID, COMMENT, USER)).resolves.toBeUndefined();
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('throws FORBIDDEN when requester is not the author', async () => {
    mockSql.mockResolvedValueOnce([{ author_id: 'other-user' }]);

    try {
      await deleteComment(CID, COMMENT, USER);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CommentError);
      expect((err as CommentError).code).toBe('FORBIDDEN');
    }
  });

  it('throws NOT_FOUND when comment not found', async () => {
    mockSql.mockResolvedValueOnce([]);

    try {
      await deleteComment(CID, COMMENT, USER);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CommentError);
      expect((err as CommentError).code).toBe('NOT_FOUND');
    }
  });
});

// ── listComments ────────────────────────────────────────────────────────────

describe('listComments', () => {
  it('returns mapped comments ordered by created_at', async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: 'c1', section_id: SEC, company_id: CID, author_id: USER,
        body: 'First', resolved: false, resolved_by: null,
        resolved_at: null, parent_id: null, created_at: new Date('2026-01-01'),
      },
      {
        id: 'c2', section_id: SEC, company_id: CID, author_id: USER,
        body: 'Second', resolved: false, resolved_by: null,
        resolved_at: null, parent_id: 'c1', created_at: new Date('2026-01-02'),
      },
    ]);

    const result = await listComments(CID, SEC);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('c1');
    expect(result[1].parentId).toBe('c1');
  });

  it('returns empty array when no comments', async () => {
    mockSql.mockResolvedValueOnce([]);
    const result = await listComments(CID, SEC);
    expect(result).toEqual([]);
  });
});
```

---

## Notification Trigger Points

All notifications use the existing notification infrastructure (exact function signatures TBD). Calls are fire-and-forget (`.catch(err => log.warn(...))`).

| Event | Where triggered | Who to notify |
|---|---|---|
| Generation complete | Plan 1 generation job completion | Accountant who triggered generation |
| `submit-for-review` (doc -> in_review) | `submit-for-review.ts` route | All seniors on the file (query `company_users` for `senior_accountant` + `partner` roles) |
| Document `signed_off` | `signOffDocument` in `afsReviewService.ts` | Client via portal + accountant |
| Comment added | `comments.ts` POST route | Section assignee + all prior comment authors on the thread |

Filing deadline reminders (30/14/7 days) are handled by the compliance layer in Plan 8.

---

## Implementation Order

Execute in this order -- each step is independently testable:

1. **Migration** -- run `340_afs_section_comments.sql` against dev DB
2. **Types** -- add review workflow additions to `afsTypes.ts` (Task 2)
3. **`afsReviewService.ts`** -- state machine (Task 3)
4. **`afsSectionCommentService.ts`** -- CRUD (Task 4)
5. **`afsVersionHistoryService.ts`** -- depends on review service for status reset (Task 5)
6. **`afsProofCopyService.ts`** -- depends on all above (Task 6)
7. **API routes** -- one route per endpoint (Task 7)
8. **Update existing sign-off route** -- Task 7.9
9. **Tests** -- `afsReviewService.test.ts` then `afsSectionCommentService.test.ts` (Tasks 8-9)

---

## Error Handling Conventions

- `ReviewError` and `CommentError` are domain errors -- they bubble up to the route handler.
- Route handlers use `try/catch` to map domain error codes to HTTP status codes.
- `withErrorHandler` catches any unhandled `Error` and returns 500.
- No empty catch blocks.
- All errors logged with `log.error` or `log.warn` before returning error response.

---

## Multi-Tenant Safety Checklist

Every DB query in every service must include:

- `AND company_id = ${companyId}` on `afs_section_comments` queries
- `AND company_id = ${companyId}` on `afs_sections` queries
- `AND company_id = ${companyId}` on `afs_documents` queries
- Cross-entity validation: when fetching a section by `sectionId`, always confirm the section's `document_id` matches the route's `documentId` parameter
- Parent comment validation: when `parentId` provided, confirm parent's `section_id = sectionId AND company_id = companyId`

---

## File Size Budget

All files must stay under 300 lines. Projected line counts:

| File | Estimated lines |
|---|---|
| `340_afs_section_comments.sql` | ~25 |
| `afsTypes.ts` additions | ~40 (appended to existing ~215 lines) |
| `afsReviewService.ts` | ~260 |
| `afsSectionCommentService.ts` | ~150 |
| `afsVersionHistoryService.ts` | ~120 |
| `afsProofCopyService.ts` | ~160 |
| `submit-for-review.ts` (route) | ~40 |
| `proof-copy-checklist.ts` (route) | ~30 |
| `review.ts` (route) | ~45 |
| `sections/[sectionId]/sign-off.ts` (route) | ~45 |
| `overrides.ts` (route) | ~60 |
| `comments.ts` (route) | ~55 |
| `comments/[commentId]/resolve.ts` (route) | ~40 |
| `versions.ts` (route) | ~60 |
| `sign-off.ts` (updated existing) | ~35 |
| `afsReviewService.test.ts` | ~220 |
| `afsSectionCommentService.test.ts` | ~180 |

---

*Plan 5 written: 2026-04-16 | Depends on: Plan 1 (Document Engine) | Next: Plan 6 (Client Portal + Signum)*
