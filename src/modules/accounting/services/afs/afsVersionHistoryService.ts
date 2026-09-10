// src/modules/accounting/services/afs/afsVersionHistoryService.ts
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { lockSectionForWrite, voidSectionAttestation } from './afsSectionAttestation';
import type { AfsSectionVersionEntry, NoteContent } from './afsTypes';

// ── Error ───────────────────────────────────────────────────────────────────

export type VersionHistoryErrorCode = 'NOT_FOUND' | 'VERSION_NOT_FOUND';
export class VersionHistoryError extends Error {
  constructor(message: string, public readonly code: VersionHistoryErrorCode) {
    super(message);
    this.name = 'VersionHistoryError';
  }
}

// ── Internal helpers ────────────────────────────────────────────────────────

interface SectionContentRow {
  id: string;
  content: NoteContent | null;
  overrides: Partial<NoteContent> | null;
  version_history: AfsSectionVersionEntry[];
  status: string;
}

/** Reads a section of `documentId` only: a section is never reached through another document. */
async function getSectionContent(
  companyId: string,
  documentId: string,
  sectionId: string
): Promise<SectionContentRow | null> {
  const rows = (await sql`
    SELECT id, content, overrides, version_history, status
    FROM afs_sections
    WHERE id = ${sectionId}
      AND document_id = ${documentId}
      AND company_id = ${companyId}
  `) as Record<string, unknown>[];
  const first = rows[0];
  return first === undefined ? null : first as unknown as SectionContentRow;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Snapshots the current section content into version_history (prepended). A snapshot only:
 * it changes neither content nor review state. A caller that goes on to change the content
 * voids the review itself (voidSectionAttestation) — the snapshot cannot know whether it will.
 */
export async function saveVersion(
  companyId: string,
  documentId: string,
  sectionId: string,
  userId: string,
  note?: string
): Promise<AfsSectionVersionEntry> {
  const section = await getSectionContent(companyId, documentId, sectionId);
  if (!section) {
    throw new VersionHistoryError(`Section ${sectionId} not found for company ${companyId}`, 'NOT_FOUND');
  }

  const currentHistory = Array.isArray(section.version_history) ? section.version_history : [];

  const newVersion: AfsSectionVersionEntry = {
    version: currentHistory.length + 1,
    savedAt: new Date().toISOString(),
    savedBy: userId,
    content: section.content ?? { title: '', blocks: [] },
    overrides: section.overrides ?? null,
    ...(note ? { note } : {}),
  };

  await sql`
    UPDATE afs_sections
    SET version_history = jsonb_build_array(${JSON.stringify(newVersion)}::jsonb)
                          || COALESCE(version_history, '[]'::jsonb),
        updated_at = now()
    WHERE id = ${sectionId}
      AND document_id = ${documentId}
      AND company_id = ${companyId}
  `;

  log.info('Version saved', { sectionId, documentId, companyId, userId, version: newVersion.version }, 'afsVersionHistoryService');
  return newVersion;
}

/**
 * Returns the version_history array from the section row.
 */
export async function listVersions(
  companyId: string,
  documentId: string,
  sectionId: string
): Promise<AfsSectionVersionEntry[]> {
  const section = await getSectionContent(companyId, documentId, sectionId);
  if (!section) {
    throw new VersionHistoryError(`Section ${sectionId} not found for company ${companyId}`, 'NOT_FOUND');
  }
  return Array.isArray(section.version_history) ? section.version_history : [];
}

/**
 * Restores a previous version of a section of `documentId`:
 * 1. Locks the section and its document; refuses a locked document (ReviewError)
 * 2. Voids any review or sign-off: restored content was not what was reviewed
 * 3. Saves current state as a new version (restore is reversible)
 * 4. Sets section.content and overrides to the target version's snapshot
 * A restore never raises the review status: a reviewed or signed-off section drops to
 * 'pending' and the saved snapshot records that the restore invalidated its review; any
 * lower status is kept as it is.
 */
export async function restoreVersion(
  companyId: string,
  documentId: string,
  sectionId: string,
  version: number,
  userId: string
): Promise<AfsSectionVersionEntry> {
  // Locked: whether this restore invalidates a review is decided on the status a
  // concurrent reviewer has COMMITTED, not on a snapshot that review is about to replace.
  const locked = await lockSectionForWrite(companyId, documentId, sectionId);
  const section = await getSectionContent(companyId, documentId, sectionId);
  if (!section) {
    throw new VersionHistoryError(`Section ${sectionId} not found for company ${companyId}`, 'NOT_FOUND');
  }

  const history = Array.isArray(section.version_history) ? section.version_history : [];
  const target = history.find((v) => v.version === version);
  if (!target) {
    throw new VersionHistoryError(`Version ${version} not found for section ${sectionId}`, 'VERSION_NOT_FOUND');
  }

  const reviewInvalidated = locked.status === 'reviewed' || locked.status === 'signed_off';
  await voidSectionAttestation(companyId, locked, userId, `Restoring version ${version} replaced the section's content`);

  // Save current state as a new version first (so restore is reversible)
  const saveEntry = await saveVersion(companyId, documentId, sectionId, userId, reviewInvalidated
    ? `Restoring version ${version} invalidated the section's prior ${locked.status} review`
    : undefined);

  // Now apply the target version's content and overrides
  await sql`
    UPDATE afs_sections
    SET content = ${JSON.stringify(target.content)}::jsonb,
        overrides = ${target.overrides != null ? JSON.stringify(target.overrides) : null}::jsonb,
        -- Decided in SQL as well: even without an enclosing transaction to hold the lock,
        -- restored content never carries a review forward.
        status = CASE WHEN status IN ('reviewed','signed_off') THEN 'pending' ELSE status END,
        updated_at = now()
    WHERE id = ${sectionId}
      AND document_id = ${documentId}
      AND company_id = ${companyId}
  `;

  log.info('Version restored', {
    sectionId, documentId, companyId, userId,
    restoredVersion: version,
    newVersionEntry: saveEntry.version,
  }, 'afsVersionHistoryService');

  return saveEntry;
}
