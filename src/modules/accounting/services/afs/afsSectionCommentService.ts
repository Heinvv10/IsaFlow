// src/modules/accounting/services/afs/afsSectionCommentService.ts
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { lockSectionForWrite } from './afsSectionAttestation';
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

async function verifySectionInDocument(
  companyId: string,
  documentId: string,
  sectionId: string
): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM afs_sections
    WHERE id = ${sectionId}
      AND document_id = ${documentId}
      AND company_id = ${companyId}
    LIMIT 1
  `;
  return rows.length > 0;
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function listComments(
  companyId: string,
  documentId: string,
  sectionId: string
): Promise<AfsSectionComment[]> {
  if (!(await verifySectionInDocument(companyId, documentId, sectionId))) {
    throw new CommentError('Section not found', 'NOT_FOUND');
  }
  const rows = (await sql`
    SELECT c.*
    FROM afs_section_comments c
    JOIN afs_sections s ON s.id = c.section_id AND s.company_id = ${companyId}
    WHERE c.section_id = ${sectionId}
      AND c.company_id = ${companyId}
    ORDER BY c.created_at ASC
  `) as Record<string, unknown>[];
  return rows.map(mapRow);
}

export async function addComment(
  companyId: string,
  documentId: string,
  sectionId: string,
  authorId: string,
  body: string,
  parentId?: string
): Promise<AfsSectionComment> {
  // A comment is review correspondence about a section of THIS document, and a locked or
  // out-for-signature document takes no more of it. Raises ReviewError, which the routes map.
  await lockSectionForWrite(companyId, documentId, sectionId);

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

  const rows = (await sql`
    INSERT INTO afs_section_comments (section_id, company_id, author_id, body, parent_id)
    VALUES (${sectionId}, ${companyId}, ${authorId}, ${body}, ${parentId ?? null})
    RETURNING *
  `) as Record<string, unknown>[];

  const first = rows[0];
  if (first === undefined) {
    throw new Error('Insert returned no rows');
  }

  log.info('Comment added', { sectionId, companyId, authorId, parentId }, 'afsSectionCommentService');
  return mapRow(first);
}

export async function resolveComment(
  companyId: string,
  documentId: string,
  sectionId: string,
  commentId: string,
  resolvedBy: string
): Promise<AfsSectionComment> {
  await lockSectionForWrite(companyId, documentId, sectionId);
  const rows = (await sql`
    UPDATE afs_section_comments
    SET resolved = TRUE,
        resolved_by = ${resolvedBy},
        resolved_at = now()
    WHERE id = ${commentId}
      AND section_id = ${sectionId}
      AND company_id = ${companyId}
    RETURNING *
  `) as Record<string, unknown>[];

  if (rows.length === 0) {
    throw new CommentError('Comment not found', 'NOT_FOUND');
  }

  const first = rows[0];
  if (first === undefined) {
    throw new CommentError('Comment not found', 'NOT_FOUND');
  }

  log.info('Comment resolved', { commentId, companyId, resolvedBy }, 'afsSectionCommentService');
  return mapRow(first);
}

export async function deleteComment(
  companyId: string,
  commentId: string,
  requesterId: string
): Promise<void> {
  const rows = (await sql`
    SELECT author_id FROM afs_section_comments
    WHERE id = ${commentId}
      AND company_id = ${companyId}
  `) as Record<string, unknown>[];

  if (rows.length === 0) {
    throw new CommentError('Comment not found', 'NOT_FOUND');
  }

  const first = rows[0];
  if (first === undefined) {
    throw new CommentError('Comment not found', 'NOT_FOUND');
  }

  if (first.author_id !== requesterId) {
    throw new CommentError('Only the comment author can delete this comment', 'FORBIDDEN');
  }

  await sql`
    DELETE FROM afs_section_comments
    WHERE id = ${commentId}
      AND company_id = ${companyId}
  `;

  log.info('Comment deleted', { commentId, companyId, requesterId }, 'afsSectionCommentService');
}
