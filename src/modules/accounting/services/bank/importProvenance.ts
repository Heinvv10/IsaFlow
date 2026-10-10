/**
 * Who imported a bank statement, through which channel, and from what file
 * (forensic-controls step 2; Hein's decision 2): bank_import_batches'
 * imported_by, import_channel and file_sha256, fixed once set (migration
 * 877). The importer is who may NOT allocate the batch's lines under
 * enforcement (bankLineImporterGate.ts). Every path that gives a line an
 * import_batch_id writes a batch row with these — pinned by
 * tests/unit/services/bank/bankImportProvenanceCensus.test.ts.
 */
import { createHash } from 'node:crypto';

/** 877's CHECK on bank_import_batches.import_channel. */
export type ImportChannel = 'upload' | 'mcp' | 'extension' | 'statement_ocr' | 'classified';

export interface ImportProvenance {
  /** The person: a user id (an MCP import records the token's user, never an `mcp:*` label). */
  importedBy?: string;
  importChannel?: ImportChannel;
  /** Lowercase hex SHA-256 of the file's bytes, where there is a file. */
  fileSha256?: string | null;
}

/** The SHA-256 of a statement upload's bytes: a PDF's decoded base64, else its text as UTF-8. */
export function statementFileSha256(file: { pdfBase64?: string; csvContent?: string }): string {
  const bytes = file.pdfBase64 ? Buffer.from(file.pdfBase64, 'base64') : Buffer.from(file.csvContent ?? '', 'utf8');
  return createHash('sha256').update(bytes).digest('hex');
}

/** A statement upload's provenance (bank-transactions-bulk-commit): the user, channel upload, the bytes' hash. */
export function uploadProvenance(userId: string | undefined, file: { pdfBase64?: string; csvContent?: string }): ImportProvenance {
  return { importedBy: userId, importChannel: 'upload', fileSha256: statementFileSha256(file) };
}
