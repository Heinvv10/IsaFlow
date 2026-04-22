/**
 * Document Storage Helper
 *
 * Persists and fetches the raw bytes of a captured_document.
 * Currently backed by captured_documents.raw_bytes (BYTEA). When volume demands
 * object storage, swap these two functions — callers don't need to change.
 */

import crypto from 'node:crypto';
import { sql } from './neon';

export function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

type Row = Record<string, unknown>;

export interface RawBytes {
  buffer: Buffer;
  hash: string;
  size: number;
  fileType: string;
}

/**
 * Fetch raw bytes for a captured document. Returns null when no bytes exist
 * (legacy row or pre-storage migration).
 */
export async function fetchRawBytes(
  documentId: string,
  companyId: string,
): Promise<RawBytes | null> {
  const rows = (await sql`
    SELECT raw_bytes, raw_bytes_sha256, raw_bytes_size, file_type
    FROM captured_documents
    WHERE id = ${documentId}::uuid
      AND company_id = ${companyId}
    LIMIT 1
  `) as Row[];

  const row = rows[0];
  if (!row) return null;

  const raw = row.raw_bytes;
  if (raw === null || raw === undefined) return null;

  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);

  return {
    buffer,
    hash: (row.raw_bytes_sha256 as string | null) ?? sha256(buffer),
    size: (row.raw_bytes_size as number | null) ?? buffer.length,
    fileType: (row.file_type as string | null) ?? 'bin',
  };
}
