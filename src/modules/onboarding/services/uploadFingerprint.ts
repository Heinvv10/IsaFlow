/**
 * Identity of an uploaded file's CONTENT: sha256 of its decoded bytes, so the
 * same scan sent twice (under any file name or data-URL formatting) is
 * recognised as the same document. Server only (node:crypto).
 */

import { createHash } from 'node:crypto';
import { decodeUploadPayload } from '@/lib/fileMagic';

export function uploadFingerprint(data: string | null | undefined): string | null {
  const buf = data ? decodeUploadPayload(data) : null;
  return buf ? createHash('sha256').update(buf).digest('hex') : null;
}
