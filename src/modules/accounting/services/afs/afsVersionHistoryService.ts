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
  const rows = (await sql`
    SELECT id, content, version_history, status
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
