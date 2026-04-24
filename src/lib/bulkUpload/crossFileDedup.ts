/**
 * Client-side cross-file duplicate detector for the bulk bank-statement
 * uploader.
 *
 * The server returns each parsed file's `rowHashes` (computed via
 * bankTransactionHash). When two uploaded files cover overlapping
 * months we want to flag the duplicates client-side so the user can
 * see what'll be skipped before committing — the server still does
 * the authoritative dedupe pass at commit time.
 */

export interface FileHashes {
  filename: string;
  rowHashes: string[];
}

export interface DuplicatePair {
  filename: string;
  duplicateOf: string;
  duplicateRows: number;
  totalRows: number;
}

/**
 * For each file, find earlier files that share at least one row hash.
 * Returns a per-file overlap summary keyed by filename for direct UI
 * lookup. Files iterated in input order, so a file is only ever
 * "duplicate of" something earlier in the list — keeps the warning
 * stable when files are added incrementally.
 */
export function findCrossFileDuplicates(files: FileHashes[]): Map<string, DuplicatePair> {
  const overlapByFile = new Map<string, DuplicatePair>();
  const seen = new Map<string, string>(); // hash -> first filename that contained it

  for (const file of files) {
    if (file.rowHashes.length === 0) {
      continue;
    }
    const overlapsByOwner = new Map<string, number>();
    for (const hash of file.rowHashes) {
      const owner = seen.get(hash);
      if (owner && owner !== file.filename) {
        overlapsByOwner.set(owner, (overlapsByOwner.get(owner) ?? 0) + 1);
      } else if (!owner) {
        seen.set(hash, file.filename);
      }
    }
    if (overlapsByOwner.size === 0) continue;

    // Pick the owner with the largest overlap as the primary "duplicate of".
    let bestOwner = '';
    let bestCount = 0;
    for (const [owner, count] of overlapsByOwner) {
      if (count > bestCount) {
        bestOwner = owner;
        bestCount = count;
      }
    }
    overlapByFile.set(file.filename, {
      filename: file.filename,
      duplicateOf: bestOwner,
      duplicateRows: bestCount,
      totalRows: file.rowHashes.length,
    });
  }

  return overlapByFile;
}
