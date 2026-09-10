// src/modules/accounting/services/afs/afsVersionHistoryService.ts
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { assertIndependentRequestReview } from '@/modules/accounting/services/controls/independentReview';
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

async function getSectionContent(
  companyId: string,
  sectionId: string,
  lock = false
): Promise<SectionContentRow | null> {
  const rows = (lock ? await sql`
    SELECT id, content, overrides, version_history, status
    FROM afs_sections
    WHERE id = ${sectionId}
      AND company_id = ${companyId}
    FOR UPDATE
  ` : await sql`
    SELECT id, content, overrides, version_history, status
    FROM afs_sections
    WHERE id = ${sectionId}
      AND company_id = ${companyId}
  `) as Record<string, unknown>[];
  if (rows.length === 0) return null;
  const first = rows[0];
  if (first === undefined) return null;
  return first as unknown as SectionContentRow;
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
  userId: string,
  note?: string
): Promise<AfsSectionVersionEntry> {
  const section = await getSectionContent(companyId, sectionId);
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
    throw new VersionHistoryError(`Section ${sectionId} not found for company ${companyId}`, 'NOT_FOUND');
  }
  return Array.isArray(section.version_history) ? section.version_history : [];
}

/**
 * Restores a previous version:
 * 1. Saves current state as a new version (restore is reversible)
 * 2. Sets section.content = target version's content snapshot
 * 3. Clears section.overrides
 * 4. Never raises the review status. A restore replaces content, so whatever review
 *    covered the current content no longer covers the section: a reviewed or signed-off
 *    section drops to 'pending' and the saved snapshot records that the restore
 *    invalidated its review; any lower status is kept as it is.
 */
export async function restoreVersion(
  companyId: string,
  sectionId: string,
  version: number,
  userId: string
): Promise<AfsSectionVersionEntry> {
  // Locked: whether this restore invalidates a review is decided on the status a
  // concurrent reviewer has COMMITTED, not on a snapshot that review is about to replace.
  const section = await getSectionContent(companyId, sectionId, true);
  if (!section) {
    throw new VersionHistoryError(`Section ${sectionId} not found for company ${companyId}`, 'NOT_FOUND');
  }

  const history = Array.isArray(section.version_history) ? section.version_history : [];
  const target = history.find((v) => v.version === version);
  if (!target) {
    throw new VersionHistoryError(`Version ${version} not found for section ${sectionId}`, 'VERSION_NOT_FOUND');
  }

  // Dropping a review is a change of review state; an impersonated session may not make it.
  const reviewInvalidated = section.status === 'reviewed' || section.status === 'signed_off';
  if (reviewInvalidated) assertIndependentRequestReview();

  // Save current state as a new version first (so restore is reversible)
  const saveEntry = await saveVersion(companyId, sectionId, userId, reviewInvalidated
    ? `Restoring version ${version} invalidated the section's prior ${section.status} review`
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
      AND company_id = ${companyId}
  `;

  log.info('Version restored', {
    sectionId, companyId, userId,
    restoredVersion: version,
    newVersionEntry: saveEntry.version,
  }, 'afsVersionHistoryService');

  return saveEntry;
}
