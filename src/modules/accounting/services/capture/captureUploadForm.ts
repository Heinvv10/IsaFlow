/**
 * The multipart upload shared by the two routes that read an uploaded PDF or
 * image with the VLM (`document-capture`, `vlm-extract`): the accepted types,
 * the size cap, an in-memory parse (nothing touches disk), and the one switch
 * between the PDF and the image reader.
 */

import type { NextApiRequest } from 'next';
import { Writable } from 'stream';
import formidable from 'formidable';
import { extractFromPdf, extractFromImage } from '../core/ocrService';
import type { ExtractedDocument } from '../../types/documentCapture.types';
import { MAX_FILE_SIZE } from './captureLimits';

export { MAX_FILE_SIZE };

export const ALLOWED_MIME_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/tiff': 'tiff',
};

/** The MIME type a stored file is read as, by the `file_type` key the upload saved (the inverse of ALLOWED_MIME_TYPES). */
export const MIME_BY_FILE_TYPE: Record<string, string> = {
  pdf: 'application/pdf',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  tiff: 'image/tiff',
};

/** In-memory file buffer attached to formidable file objects */
const fileBuffers = new WeakMap<formidable.File, Buffer>();

/** The bytes formidable collected for `file` (undefined when it collected none). */
export function uploadedBuffer(file: formidable.File): Buffer | undefined {
  return fileBuffers.get(file);
}

export function parseUploadForm(req: NextApiRequest): Promise<{ fields: formidable.Fields; files: formidable.Files }> {
  return new Promise((resolve, reject) => {
    const form = formidable({
      maxFileSize: MAX_FILE_SIZE,
      keepExtensions: true,
      filter: (part) => {
        // Reject parts with no MIME or an unrecognised MIME — H13 skip-when-absent guard.
        const mime = part.mimetype || '';
        return !!mime && mime in ALLOWED_MIME_TYPES;
      },
      fileWriteStreamHandler: (file) => {
        const chunks: Buffer[] = [];
        const writable = new Writable({
          write(chunk, _encoding, callback) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            callback();
          },
          final(callback) {
            fileBuffers.set(file as unknown as formidable.File, Buffer.concat(chunks));
            callback();
          },
        });
        return writable;
      },
    });
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

/** Read an uploaded file with the VLM: a PDF by its magic bytes, anything else as an image of `mimeType`. */
export function readUploadedDocument(buffer: Buffer, mimeType: string): Promise<ExtractedDocument> {
  const isPdf = buffer.subarray(0, 4).toString('hex').toUpperCase().startsWith('25504446');
  return isPdf ? extractFromPdf(buffer) : extractFromImage(buffer, mimeType);
}
