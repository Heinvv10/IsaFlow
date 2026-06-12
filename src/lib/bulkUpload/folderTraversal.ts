/**
 * Bulk-upload folder traversal helpers.
 *
 * Used by the bulk bank-statement import dropzone to walk a dropped
 * folder (or accept multiple files via `<input webkitdirectory>`) into
 * a flat list of validated File objects, applying extension and size
 * caps before any network call is made.
 */

export type AllowedExtension = 'pdf' | 'csv' | 'ofx' | 'qif' | 'mt940' | 'sta';

export const ALLOWED_EXTENSIONS: AllowedExtension[] = ['pdf', 'csv', 'ofx', 'qif', 'mt940', 'sta'];

export interface BulkUploadLimits {
  maxFiles: number;
  maxBytesPerFile: number;
  maxTotalBytes: number;
}

export const DEFAULT_BULK_LIMITS: BulkUploadLimits = {
  maxFiles: 100,
  maxBytesPerFile: 20 * 1024 * 1024,    // 20 MB
  maxTotalBytes: 250 * 1024 * 1024,     // 250 MB
};

export interface CollectedFile {
  file: File;
  relativePath: string;                 // includes folder prefix when dropped
  extension: AllowedExtension;
  sizeBytes: number;
}

export interface CollectionResult {
  files: CollectedFile[];
  rejected: Array<{ name: string; reason: string }>;
}

/**
 * Extract a CollectedFile entry, or null when the file is filtered out
 * (unsupported extension or oversize). Mirrors the logic used by both
 * drag-drop and `<input>` paths so they stay in sync.
 */
function classifyFile(
  file: File,
  relativePath: string,
  limits: BulkUploadLimits,
): { ok: CollectedFile } | { reject: string } {
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (!ext || !ALLOWED_EXTENSIONS.includes(ext as AllowedExtension)) {
    return { reject: `Unsupported file type (.${ext ?? 'unknown'})` };
  }
  if (file.size > limits.maxBytesPerFile) {
    return {
      reject: `Exceeds per-file limit of ${Math.round(limits.maxBytesPerFile / 1024 / 1024)} MB`,
    };
  }
  return {
    ok: {
      file,
      relativePath,
      extension: ext as AllowedExtension,
      sizeBytes: file.size,
    },
  };
}

/**
 * Walk a `<input type="file" webkitdirectory multiple>` FileList into
 * a CollectionResult. The browser sets `webkitRelativePath` on each
 * entry, which we use as the display path.
 */
export function collectFromFileList(
  fileList: FileList | File[],
  limits: BulkUploadLimits = DEFAULT_BULK_LIMITS,
): CollectionResult {
  const files: CollectedFile[] = [];
  const rejected: CollectionResult['rejected'] = [];
  const arr = Array.isArray(fileList) ? fileList : Array.from(fileList);

  for (const file of arr) {
    const relativePath =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    const classified = classifyFile(file, relativePath, limits);
    if ('ok' in classified) files.push(classified.ok);
    else rejected.push({ name: relativePath, reason: classified.reject });
  }

  return enforceAggregateLimits(files, rejected, limits);
}

/**
 * Walk DataTransferItemList from a drop event, recursing into folders
 * via the `webkitGetAsEntry()` API. Files are collected with paths
 * relative to the drop root (e.g. `Statements/2024/feb.pdf`).
 *
 * Falls back to flat file iteration when entries API is unavailable
 * (mostly Safari < 16.4); folders dropped on those browsers will be
 * silently ignored, but loose files still work.
 */
export async function collectFromDataTransfer(
  dataTransfer: DataTransfer,
  limits: BulkUploadLimits = DEFAULT_BULK_LIMITS,
): Promise<CollectionResult> {
  const files: CollectedFile[] = [];
  const rejected: CollectionResult['rejected'] = [];

  const items = dataTransfer.items;
  const supportsEntries =
    items && items.length > 0 && typeof items[0]?.webkitGetAsEntry === 'function';

  if (!supportsEntries) {
    return collectFromFileList(dataTransfer.files, limits);
  }

  const queue: FileSystemEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    const entry = items[i]?.webkitGetAsEntry();
    if (entry) queue.push(entry);
  }

  while (queue.length > 0) {
    const entry = queue.shift()!;
    if (entry.isFile) {
      const file = await readFileEntry(entry as FileSystemFileEntry);
      const classified = classifyFile(file, entry.fullPath.replace(/^\//, ''), limits);
      if ('ok' in classified) files.push(classified.ok);
      else rejected.push({ name: entry.fullPath, reason: classified.reject });
    } else if (entry.isDirectory) {
      const children = await readDirectoryEntries(entry as FileSystemDirectoryEntry);
      queue.push(...children);
    }
  }

  return enforceAggregateLimits(files, rejected, limits);
}

function readFileEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readDirectoryEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  return new Promise((resolve, reject) => {
    const readBatch = () => {
      reader.readEntries(
        (entries) => {
          if (entries.length === 0) resolve(all);
          else {
            all.push(...entries);
            readBatch();
          }
        },
        reject,
      );
    };
    readBatch();
  });
}

function enforceAggregateLimits(
  files: CollectedFile[],
  rejected: CollectionResult['rejected'],
  limits: BulkUploadLimits,
): CollectionResult {
  if (files.length > limits.maxFiles) {
    const overflow = files.splice(limits.maxFiles);
    for (const f of overflow) {
      rejected.push({
        name: f.relativePath,
        reason: `Over file count limit of ${limits.maxFiles}`,
      });
    }
  }

  let runningTotal = 0;
  const accepted: CollectedFile[] = [];
  for (const f of files) {
    if (runningTotal + f.sizeBytes > limits.maxTotalBytes) {
      rejected.push({
        name: f.relativePath,
        reason: `Would exceed total upload limit of ${Math.round(
          limits.maxTotalBytes / 1024 / 1024,
        )} MB`,
      });
      continue;
    }
    runningTotal += f.sizeBytes;
    accepted.push(f);
  }

  return { files: accepted, rejected };
}

/**
 * Helper for the React layer: read a CollectedFile into the payload
 * shape our bulk endpoints expect (PDFs as base64, text formats as
 * plain string).
 */
export async function readFileForUpload(collected: CollectedFile): Promise<
  | { fileType: 'pdf'; pdfBase64: string }
  | { fileType: 'csv' | 'ofx' | 'qif' | 'mt940'; csvContent: string }
> {
  if (collected.extension === 'pdf') {
    const buffer = await collected.file.arrayBuffer();
    return { fileType: 'pdf', pdfBase64: bufferToBase64(buffer) };
  }
  const text = await collected.file.text();
  // Both .sta and .mt940 carry SWIFT MT940 content — normalise to one fileType.
  const fileType = collected.extension === 'sta' ? 'mt940' : collected.extension;
  return { fileType, csvContent: text };
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}
