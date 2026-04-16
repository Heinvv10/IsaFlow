# Plan 5 — AFS Review Workflow
**Date:** 2026-04-16  
**Status:** Ready for implementation  
**Depends on:** Plan 1 (Document Engine) — types at `@/modules/accounting/services/afs/afsTypes.ts`  
**Scope:** Section/document lifecycle state machine, comment threads, version history, proof copy checklist

---

## Overview

Plan 5 adds the full review workflow on top of the AFS document engine built in Plan 1. It implements:

- A section and document lifecycle state machine with guarded transitions
- Per-section comment threads with threaded replies and resolution tracking
- Version history — every override save snapshots the prior state, one-click restore
- Proof copy checklist generation for pre-promotion quality checks
- Notification trigger points at key lifecycle events

**What is NOT in scope:** UI pages, PDF watermarking, client annotation layer, e-signature (Plan 6), compliance checker (Plan 8).

---

## 1. Migration

### `scripts/migrations/sql/338_afs_section_comments.sql`

```sql
-- Migration 338: AFS section comment threads
-- Provides per-section threaded comments with resolution tracking for the review workflow.

CREATE TABLE IF NOT EXISTS afs_section_comments (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id    uuid        NOT NULL REFERENCES afs_sections(id) ON DELETE CASCADE,
  company_id    uuid        NOT NULL,
  author_id     uuid        NOT NULL,
  body          text        NOT NULL,
  resolved      boolean     NOT NULL DEFAULT false,
  resolved_by   uuid,
  resolved_at   timestamptz,
  parent_id     uuid        REFERENCES afs_section_comments(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_afs_section_comments_section_id
  ON afs_section_comments(section_id);

CREATE INDEX IF NOT EXISTS idx_afs_section_comments_company_id
  ON afs_section_comments(company_id);

CREATE INDEX IF NOT EXISTS idx_afs_section_comments_parent_id
  ON afs_section_comments(parent_id);
```

**Notes:**
- `ON DELETE CASCADE` on `section_id` means comments are deleted when a section is deleted.
- `parent_id` is self-referential for threaded replies. `NULL` = top-level comment.
- `company_id` is denormalised onto every row so all queries remain tenant-scoped without joins.

---

## 2. Type Definitions (additions to afsTypes.ts)

These extend the types already defined in Plan 1. Add to `src/modules/accounting/services/afs/afsTypes.ts`:

```typescript
// ── Review workflow additions ────────────────────────────────────────────────

export type SectionStatus =
  | 'pending'
  | 'auto_generated'
  | 'ai_enhanced'
  | 'reviewed'
  | 'signed_off';

export type DocumentStatus =
  | 'draft'
  | 'in_review'
  | 'partner_review'
  | 'signed_off'
  | 'filed';

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

export interface AfsVersionEntry {
  version: number;
  savedAt: string;          // ISO 8601
  savedBy: string;          // userId
  content: unknown;         // NoteContent snapshot BEFORE this override was applied
}

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

---

## 3. Service — `afsReviewService.ts`

**Path:** `src/modules/accounting/services/afs/afsReviewService.ts`

### Responsibilities

- Guard and execute all section and document status transitions
- Enforce invariants before every transition
- Notify relevant users at key transition points

### State machine rules (enforced in every transition function)

#### Section transitions

```
pending → auto_generated → ai_enhanced → reviewed → signed_off
```

| Transition | Guard conditions |
|---|---|
| `→ auto_generated` | Called by generation pipeline only |
| `→ ai_enhanced` | ai_narrative must be non-empty |
| `→ reviewed` | No guard beyond auth (accountant role) |
| `→ signed_off` | Zero unresolved comments on this section |

- Any edit to a `signed_off` section: save a version entry, reset status to `reviewed` (NOT `signed_off`).
- Never allow backward movement except via explicit reset described above.

#### Document transitions

```
draft → in_review → partner_review → signed_off → filed
```

| Transition | Guard conditions |
|---|---|
| `draft → in_review` | ALL mandatory sections have status `reviewed` or `signed_off` |
| `in_review → partner_review` | No additional guards (manual partner assignment) |
| `partner_review → signed_off` | ALL mandatory sections have status `signed_off` |
| `signed_off → filed` | Manual filing record (Plan 8) |
| Any edit on `signed_off` document | Return 409 Conflict — no edits allowed |

### Public API

```typescript
export async function markSectionReviewed(
  companyId: string,
  documentId: string,
  sectionId: string,
  userId: string
): Promise<{ sectionId: string; newStatus: SectionStatus }>

export async function signOffSection(
  companyId: string,
  documentId: string,
  sectionId: string,
  userId: string
): Promise<{ sectionId: string; newStatus: SectionStatus }>

export async function submitDocumentForReview(
  companyId: string,
  documentId: string,
  userId: string
): Promise<{ documentId: string; newStatus: DocumentStatus }>

export async function signOffDocument(
  companyId: string,
  documentId: string,
  userId: string
): Promise<{ documentId: string; newStatus: DocumentStatus }>

export async function assertDocumentEditable(
  companyId: string,
  documentId: string
): Promise<void>  // throws ReviewError with code 'DOCUMENT_LOCKED' if signed_off
```

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

### Implementation sketch

```typescript
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { SectionStatus, DocumentStatus } from './afsTypes';

// Internal helpers:
// getSectionWithDocument(companyId, sectionId) → { section, document }
// countUnresolvedComments(companyId, sectionId) → number
// countMandatorySectionsBelow(companyId, documentId, minStatus) → number

export async function signOffSection(
  companyId: string,
  documentId: string,
  sectionId: string,
  userId: string
): Promise<{ sectionId: string; newStatus: SectionStatus }> {
  const { section, document } = await getSectionWithDocument(companyId, sectionId);

  if (!section) throw new ReviewError('Section not found', 'NOT_FOUND');
  if (document.id !== documentId) throw new ReviewError('Section not found', 'NOT_FOUND');

  // Signed-off doc: no changes
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
```

---

## 4. Service — `afsSectionCommentService.ts`

**Path:** `src/modules/accounting/services/afs/afsSectionCommentService.ts`

### Public API

```typescript
export async function listComments(
  companyId: string,
  sectionId: string
): Promise<AfsSectionComment[]>
// Returns all comments (top-level + replies) ordered by created_at ASC.
// Caller builds tree client-side from parentId.

export async function addComment(
  companyId: string,
  sectionId: string,
  authorId: string,
  body: string,
  parentId?: string
): Promise<AfsSectionComment>
// Validates parentId belongs to same section + company if provided.

export async function resolveComment(
  companyId: string,
  commentId: string,
  resolvedBy: string
): Promise<AfsSectionComment>
// Sets resolved=true, resolved_by, resolved_at.
// Throws CommentError('NOT_FOUND') if not found or wrong company.
// Does NOT cascade-resolve replies (each resolved individually).

export async function deleteComment(
  companyId: string,
  commentId: string,
  requesterId: string
): Promise<void>
// Only author or company admin can delete.
// Throws CommentError('FORBIDDEN') if requester is not the author.
```

### Error type

```typescript
export class CommentError extends Error {
  constructor(message: string, public readonly code: 'NOT_FOUND' | 'FORBIDDEN') {
    super(message);
    this.name = 'CommentError';
  }
}
```

### Key implementation notes

- Every query includes `AND company_id = ${companyId}` — tenant safety.
- `listComments` queries `afs_section_comments` joined to `afs_sections` to verify the section belongs to the company.
- `addComment` validates that the target `sectionId` exists and belongs to `companyId` before inserting.
- When `parentId` is supplied, validate it references a comment on the same `sectionId` with the same `companyId`.

---

## 5. Service — `afsVersionHistoryService.ts`

**Path:** `src/modules/accounting/services/afs/afsVersionHistoryService.ts`

### When to call `saveVersion`

The overrides route (`PUT .../overrides`) calls `saveVersion` BEFORE writing new overrides. This captures the state that existed before the incoming changes.

### Version entry format

```typescript
const newVersion: AfsVersionEntry = {
  version: (section.versionHistory as AfsVersionEntry[]).length + 1,
  savedAt: new Date().toISOString(),
  savedBy: userId,
  content: section.content, // snapshot BEFORE applying new overrides
};
```

The version is prepended to the JSONB array (most recent first). Prepend, not append, so UI shows newest first without reversing.

### Public API

```typescript
export async function saveVersion(
  companyId: string,
  sectionId: string,
  userId: string
): Promise<AfsVersionEntry>
// Reads current section content, builds AfsVersionEntry, prepends to version_history JSONB array.
// Also resets section status from 'signed_off' → 'reviewed' if necessary.
// Used inside the overrides PUT handler BEFORE applying new overrides.

export async function listVersions(
  companyId: string,
  sectionId: string
): Promise<AfsVersionEntry[]>
// Returns version_history array from the section row.

export async function restoreVersion(
  companyId: string,
  sectionId: string,
  version: number,
  userId: string
): Promise<AfsVersionEntry>
// Finds the entry with matching version number.
// Saves the CURRENT state as a new version (so restore is reversible).
// Sets section.overrides = null (clears overrides so content from that version shows).
// Sets section.content = that version's content snapshot.
// Resets status to 'reviewed'.
// Returns the newly created version entry.
```

### SQL pattern for prepend

```typescript
await sql`
  UPDATE afs_sections
  SET version_history = jsonb_build_array(${JSON.stringify(newVersion)}::jsonb)
                        || COALESCE(version_history, '[]'::jsonb),
      status = CASE WHEN status = 'signed_off' THEN 'reviewed' ELSE status END,
      updated_at = now()
  WHERE id = ${sectionId}
    AND company_id = ${companyId}
`;
```

---

## 6. Service — `afsProofCopyService.ts`

**Path:** `src/modules/accounting/services/afs/afsProofCopyService.ts`

### Purpose

Returns a checklist of items an accountant must verify before promoting the document from `draft` to `in_review`. The checklist is data-driven — each item is evaluated against live document/section state.

### Checklist items

| Key | Label | Passes when |
|---|---|---|
| `cover_page_correct` | Cover page details correct | Director's Report section is `reviewed` or above |
| `director_names_correct` | Director names/designations correct | Director's Report section is `reviewed` or above |
| `comparative_figures_present` | Comparative figures present | Prior year data_snapshot is non-empty on balance sheet section |
| `note_cross_references_accurate` | Note cross-references accurate | Manual — defaults `false`, accountant must check |
| `page_numbers_sequential` | Page numbers sequential | Manual — defaults `false` |
| `toc_page_numbers_match` | Table of contents page numbers match | Manual — defaults `false` |
| `auditor_report_uploaded` | Auditor's report uploaded and legible | `afs_documents.auditor_report_url` is non-null |
| `registration_number_present` | Company registration number correct | `company_details.registration_number` is non-empty |
| `all_mandatory_sections_reviewed` | All mandatory sections reviewed or signed off | Count of mandatory sections below `reviewed` status = 0 |
| `no_unresolved_comments` | No unresolved comments on any section | Sum of unresolved comments across all document sections = 0 |

### Public API

```typescript
export async function getProofCopyChecklist(
  companyId: string,
  documentId: string
): Promise<ProofCopyChecklist>
```

### Implementation notes

- Automated items are computed from DB queries.
- Manual items (`note_cross_references_accurate`, `page_numbers_sequential`, `toc_page_numbers_match`) always return `checked: false` — they are rendered as checkboxes in the UI for the accountant to tick.
- `allPassed` is `true` only when every item has `checked: true`. Because manual items start as `false`, the checklist cannot auto-pass — accountant interaction is always required.
- Future: store manual checkbox state in `afs_documents.proof_copy_state` JSONB (Plan 4 or later).

---

## 7. API Routes

All routes follow the standard pattern:

```typescript
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
// ...
export default withCompany(withErrorHandler(handler as any));
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

### 7.1 `pages/api/accounting/afs/[documentId]/submit-for-review.ts`

```
POST /api/accounting/afs/[documentId]/submit-for-review
```

**Body:** none  
**Response:** `{ documentId, newStatus: 'in_review' }`  
**Logic:**
1. Call `afsReviewService.submitDocumentForReview(companyId, documentId, userId)`
2. On `ReviewError('SECTIONS_NOT_READY')` → return 409 with message
3. Trigger notification: notify all seniors on the file (notification infrastructure call — see §9)

**Error handling:**
```typescript
try {
  const result = await submitDocumentForReview(companyId, documentId, userId);
  return apiResponse.success(res, result);
} catch (err) {
  if (err instanceof ReviewError) {
    if (err.code === 'NOT_FOUND') return apiResponse.notFound(res, 'AFS document', documentId);
    return apiResponse.error(res, ErrorCode.CONFLICT, err.message);
  }
  throw err; // withErrorHandler catches and returns 500
}
```

---

### 7.2 `pages/api/accounting/afs/[documentId]/sections/[sectionId]/review.ts`

```
POST /api/accounting/afs/[documentId]/sections/[sectionId]/review
```

**Body:** none  
**Response:** `{ sectionId, newStatus: 'reviewed' }`  
**Logic:** Call `afsReviewService.markSectionReviewed(companyId, documentId, sectionId, userId)`

---

### 7.3 `pages/api/accounting/afs/[documentId]/sections/[sectionId]/sign-off.ts`

```
POST /api/accounting/afs/[documentId]/sections/[sectionId]/sign-off
```

**Body:** none  
**Response:** `{ sectionId, newStatus: 'signed_off' }`  
**Logic:**
1. Call `afsReviewService.signOffSection(companyId, documentId, sectionId, userId)`
2. On `ReviewError('UNRESOLVED_COMMENTS')` → 409 with message listing count

---

### 7.4 `pages/api/accounting/afs/[documentId]/sections/[sectionId]/overrides.ts`

```
PUT /api/accounting/afs/[documentId]/sections/[sectionId]/overrides
```

**Body:** `{ overrides: unknown }` (NoteContent partial)  
**Response:** `{ sectionId, version: AfsVersionEntry }`  
**Logic:**
1. Call `afsReviewService.assertDocumentEditable(companyId, documentId)` → 409 if locked
2. Call `afsVersionHistoryService.saveVersion(companyId, sectionId, userId)` — saves snapshot BEFORE applying
3. Apply new overrides:
   ```sql
   UPDATE afs_sections
   SET overrides = ${JSON.stringify(overrides)},
       updated_at = now()
   WHERE id = ${sectionId} AND document_id = ${documentId} AND company_id = ${companyId}
   ```
4. Return the version entry created in step 2

---

### 7.5 `pages/api/accounting/afs/[documentId]/sections/[sectionId]/comments.ts`

```
GET  /api/accounting/afs/[documentId]/sections/[sectionId]/comments
POST /api/accounting/afs/[documentId]/sections/[sectionId]/comments
```

**GET response:** `{ items: AfsSectionComment[] }`  
**POST body:** `{ body: string, parentId?: string }`  
**POST response:** the newly created `AfsSectionComment`

**Logic (GET):** `afsSectionCommentService.listComments(companyId, sectionId)`  
**Logic (POST):**
1. Validate `body` is non-empty
2. Call `afsSectionCommentService.addComment(companyId, sectionId, userId, body, parentId)`
3. Trigger notification: notify section assignee + thread participants (§9)

---

### 7.6 `pages/api/accounting/afs/[documentId]/sections/[sectionId]/comments/[commentId]/resolve.ts`

```
POST .../comments/[commentId]/resolve
```

**Body:** none  
**Response:** the updated `AfsSectionComment`  
**Logic:** `afsSectionCommentService.resolveComment(companyId, commentId, userId)`

---

### 7.7 `pages/api/accounting/afs/[documentId]/sections/[sectionId]/versions.ts`

```
GET  .../versions          — list version history
POST .../versions          — restore a version
```

**GET response:** `{ items: AfsVersionEntry[] }`  
**POST body:** `{ version: number }` (version number to restore)  
**POST response:** `{ sectionId, restoredVersion: number, newVersionEntry: AfsVersionEntry }`

**Logic (POST):**
1. Call `afsReviewService.assertDocumentEditable(companyId, documentId)` → 409 if locked
2. Call `afsVersionHistoryService.restoreVersion(companyId, sectionId, version, userId)`

---

### 7.8 `pages/api/accounting/afs/[documentId]/proof-copy.ts`

```
GET /api/accounting/afs/[documentId]/proof-copy
```

**Response:** `ProofCopyChecklist`  
**Logic:** `afsProofCopyService.getProofCopyChecklist(companyId, documentId)`

---

## 8. Tests

### 8.1 `tests/unit/services/afs/afsReviewService.test.ts`

**Mock setup (mirrors balanceSheetService pattern):**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/modules/accounting/services/afs/afsSectionCommentService');

import { sql } from '@/lib/neon';
import { ReviewError, markSectionReviewed, signOffSection, submitDocumentForReview, assertDocumentEditable } from '@/modules/accounting/services/afs/afsReviewService';
import * as commentService from '@/modules/accounting/services/afs/afsSectionCommentService';
```

**Test cases — `signOffSection`:**

| Test | Setup | Expected |
|---|---|---|
| success | 0 unresolved comments, section status `reviewed`, doc not locked | returns `{ newStatus: 'signed_off' }`, sql UPDATE called |
| blocks on unresolved comments | 2 unresolved comments | throws `ReviewError` with code `UNRESOLVED_COMMENTS` |
| blocks on locked document | document status `signed_off` | throws `ReviewError` with code `DOCUMENT_LOCKED` |
| blocks on filed document | document status `filed` | throws `ReviewError` with code `DOCUMENT_LOCKED` |
| section not found | sql returns empty | throws `ReviewError` with code `NOT_FOUND` |

**Test cases — `submitDocumentForReview`:**

| Test | Setup | Expected |
|---|---|---|
| success | all mandatory sections are `reviewed` | returns `{ newStatus: 'in_review' }` |
| blocks when mandatory sections not ready | 2 mandatory sections still `pending` | throws `ReviewError` with code `SECTIONS_NOT_READY` |
| document not found | sql returns empty | throws `ReviewError` with code `NOT_FOUND` |

**Test cases — `assertDocumentEditable`:**

| Test | Setup | Expected |
|---|---|---|
| passes for draft | document status `draft` | resolves without throwing |
| passes for in_review | document status `in_review` | resolves without throwing |
| throws for signed_off | document status `signed_off` | throws `ReviewError` code `DOCUMENT_LOCKED` |

---

### 8.2 `tests/unit/services/afs/afsSectionCommentService.test.ts`

**Mock setup:**

```typescript
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
import { CommentError, listComments, addComment, resolveComment, deleteComment } from '@/modules/accounting/services/afs/afsSectionCommentService';
```

**Test cases — `addComment`:**

| Test | Setup | Expected |
|---|---|---|
| success, top-level | sectionId belongs to company | returns new AfsSectionComment with parentId null |
| success, reply | parentId belongs to same section+company | returns new comment with parentId set |
| rejects invalid parentId | parentId belongs to different section | throws `CommentError` code `NOT_FOUND` |

**Test cases — `resolveComment`:**

| Test | Setup | Expected |
|---|---|---|
| success | comment exists, right company | returns updated comment with resolved=true |
| not found | sql returns empty | throws `CommentError` code `NOT_FOUND` |
| wrong company | sql returns empty (company_id filter) | throws `CommentError` code `NOT_FOUND` |

**Test cases — `deleteComment`:**

| Test | Setup | Expected |
|---|---|---|
| success | requester is author | sql DELETE called |
| forbidden | requester is not author | throws `CommentError` code `FORBIDDEN` |

---

## 9. Notification Trigger Points

All notifications use the existing notification infrastructure (exact function signatures TBD — use whatever `notificationService` or `emailService` is available). The calls are fire-and-forget (`.catch(err => log.warn(...))`).

| Event | Where triggered | Who to notify |
|---|---|---|
| Generation complete | Plan 1 generation job completion | Accountant who triggered generation |
| `submit-for-review` (doc → in_review) | `submit-for-review.ts` route | All seniors on the file (query `company_users` for `senior_accountant` + `partner` roles) |
| Document `signed_off` | `signOffDocument` in `afsReviewService.ts` | Client via portal notification + accountant |
| Comment added | `comments.ts` POST route | Section assignee + all prior comment authors on the thread |

Filing deadline reminders (30/14/7 days) are handled by the compliance layer in Plan 8.

---

## 10. Implementation Order

Execute in this order — each step is independently testable:

1. **Migration** — run `338_afs_section_comments.sql` against dev DB
2. **Types** — add review workflow additions to `afsTypes.ts`
3. **`afsReviewService.ts`** — state machine (no external dependencies beyond neon + logger)
4. **`afsSectionCommentService.ts`** — CRUD (no dependency on review service)
5. **`afsVersionHistoryService.ts`** — depends on review service (`assertDocumentEditable` + status reset)
6. **`afsProofCopyService.ts`** — depends on all three services above
7. **API routes** — wire services to HTTP; one route file per endpoint
8. **Tests** — `afsReviewService.test.ts` then `afsSectionCommentService.test.ts`

---

## 11. Error Handling Conventions

- `ReviewError` and `CommentError` are domain errors — they bubble up to the route handler untouched.
- Route handlers use a `try/catch` block that maps domain error codes to HTTP status codes (see §7.1 example).
- `withErrorHandler` catches any unhandled `Error` and returns 500.
- No empty catch blocks.
- All errors logged with `log.error` before rethrowing (inside services) or before returning error response (in routes).

---

## 12. Multi-Tenant Safety Checklist

Every DB query in every service must include:

- `AND company_id = ${companyId}` on `afs_section_comments` queries
- `AND company_id = ${companyId}` on `afs_sections` queries
- `AND company_id = ${companyId}` on `afs_documents` queries
- Cross-entity validation: when fetching a section by `sectionId`, always confirm the section's `document_id` matches the route's `documentId` parameter
- Parent comment validation: when `parentId` provided, confirm parent's `section_id = sectionId AND company_id = companyId`

---

## 13. File Size Budget

All files must stay under 300 lines. Projected line counts:

| File | Estimated lines |
|---|---|
| `338_afs_section_comments.sql` | ~25 |
| `afsReviewService.ts` | ~240 |
| `afsSectionCommentService.ts` | ~180 |
| `afsVersionHistoryService.ts` | ~120 |
| `afsProofCopyService.ts` | ~150 |
| `review.ts` (route) | ~45 |
| `sign-off.ts` (route) | ~50 |
| `overrides.ts` (route) | ~60 |
| `comments.ts` (route) | ~65 |
| `comments/[commentId]/resolve.ts` (route) | ~40 |
| `versions.ts` (route) | ~65 |
| `submit-for-review.ts` (route) | ~50 |
| `proof-copy.ts` (route) | ~35 |
| `afsReviewService.test.ts` | ~220 |
| `afsSectionCommentService.test.ts` | ~180 |

If `afsReviewService.ts` approaches 300 lines, extract the guard helpers (`countUnresolvedComments`, `countMandatorySectionsBelow`, `getSectionWithDocument`) into `afsReviewHelpers.ts`.

---

*Plan 5 written: 2026-04-16 | Depends on: Plan 1 (Document Engine) | Next: Plan 6 (Client Portal + Signum)*
