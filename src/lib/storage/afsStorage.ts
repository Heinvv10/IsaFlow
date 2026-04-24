// src/lib/storage/afsStorage.ts
// Centralised storage path helpers for AFS files.
// All paths are relative to AFS_STORAGE_ROOT, which defaults to <cwd>/storage.
// Set AFS_STORAGE_ROOT in the environment to override (e.g. /var/isaflow/storage on Velocity).

import path from 'path';

const STORAGE_ROOT = path.resolve(
  process.env.AFS_STORAGE_ROOT ?? path.join(process.cwd(), 'storage'),
);

/**
 * Defence-in-depth guard against path-traversal. Currently all callers pass
 * DB-sourced UUIDs so traversal isn't practical, but this asserts the
 * invariant explicitly (pentest L15).
 */
function assertWithinRoot(p: string): string {
  const resolved = path.resolve(p);
  if (!resolved.startsWith(STORAGE_ROOT + path.sep) && resolved !== STORAGE_ROOT) {
    throw new Error('Resolved AFS path escaped STORAGE_ROOT');
  }
  return resolved;
}

export function afsSignedPdfPath(companyId: string, documentId: string): string {
  return assertWithinRoot(path.join(STORAGE_ROOT, 'afs-signed', companyId, `${documentId}.pdf`));
}

export function afsHtmlPath(companyId: string, documentId: string): string {
  return assertWithinRoot(path.join(STORAGE_ROOT, 'afs-html', companyId, `${documentId}.html`));
}
