/**
 * Document Storage Helper
 *
 * Persists raw captured_document bytes into Supabase Storage and resolves
 * them back via the DB pointer (storage_bucket + storage_path). Keeps the
 * SHA-256 hash in the DB as the integrity seal.
 */

import crypto from 'node:crypto';
import { sql } from './neon';
import {
  uploadCapturedDocument,
  downloadCapturedDocument,
  CAPTURED_DOCS_BUCKET,
} from './supabaseStorage';

export function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

type Row = Record<string, unknown>;

export interface StoredDocument {
  documentId: string;
  bucket: string;
  path: string;
  hash: string;
  size: number;
}

/**
 * Upload the file to the captured-documents bucket and return the pointer
 * metadata (bucket + path + hash + size). The caller is responsible for
 * writing the pointer back onto captured_documents.
 */
export async function storeCapturedBytes(
  companyId: string,
  documentId: string,
  buffer: Buffer,
  contentType: string,
): Promise<StoredDocument> {
  const hash = sha256(buffer);
  const size = buffer.length;

  const { bucket, path } = await uploadCapturedDocument(
    companyId,
    documentId,
    buffer,
    contentType,
  );

  return { documentId, bucket, path, hash, size };
}

export interface RawBytes {
  buffer: Buffer;
  hash: string;
  size: number;
  fileType: string;
}

/**
 * Fetch raw bytes for a captured document from Storage. Returns null when the
 * storage_path isn't set (legacy / not-yet-uploaded row).
 */
export async function fetchRawBytes(
  documentId: string,
  companyId: string,
): Promise<RawBytes | null> {
  const rows = (await sql`
    SELECT storage_bucket, storage_path, raw_bytes_sha256, raw_bytes_size, file_type
    FROM captured_documents
    WHERE id = ${documentId}::uuid
      AND company_id = ${companyId}
    LIMIT 1
  `) as Row[];

  const row = rows[0];
  if (!row) return null;

  const bucket = (row.storage_bucket as string | null) ?? CAPTURED_DOCS_BUCKET;
  const path = row.storage_path as string | null;
  if (!path) return null;

  const buffer = await downloadCapturedDocument(bucket, path);

  return {
    buffer,
    hash: (row.raw_bytes_sha256 as string | null) ?? sha256(buffer),
    size: (row.raw_bytes_size as number | null) ?? buffer.length,
    fileType: (row.file_type as string | null) ?? 'bin',
  };
}
