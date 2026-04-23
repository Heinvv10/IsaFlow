/**
 * Supabase Storage client (self-hosted stack).
 *
 * Wraps @supabase/storage-js with env-driven configuration + a singleton
 * client so every caller hits the same underlying pool.
 *
 * Target: the IsaFlow self-hosted Supabase at SUPABASE_URL (Kong). Storage API
 * routes via `${SUPABASE_URL}/storage/v1`. Authentication via the service-role
 * key (server-only — never expose to the browser).
 */

import { StorageClient } from '@supabase/storage-js';
import { log } from './logger';

let cached: StorageClient | null = null;

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`${key} is not set — required for Supabase Storage`);
  }
  return value;
}

export function getStorageClient(): StorageClient {
  if (cached) return cached;

  const baseUrl = requireEnv('SUPABASE_URL');
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  cached = new StorageClient(`${baseUrl}/storage/v1`, {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
  });

  return cached;
}

export const CAPTURED_DOCS_BUCKET =
  process.env.SUPABASE_CAPTURED_DOCS_BUCKET ?? 'captured-documents';

export const CUSTOMER_INVOICES_BUCKET =
  process.env.SUPABASE_CUSTOMER_INVOICES_BUCKET ?? 'customer-invoices';

export interface UploadResult {
  bucket: string;
  path: string;
}

async function uploadToBucket(
  bucket: string,
  path: string,
  buffer: Buffer,
  contentType: string,
): Promise<UploadResult> {
  const { error } = await getStorageClient()
    .from(bucket)
    .upload(path, buffer, { contentType, upsert: false });

  if (error) {
    log.error('Storage upload failed', { bucket, path, error: error.message }, 'supabase-storage');
    throw new Error(`Storage upload failed: ${error.message}`);
  }

  return { bucket, path };
}

export async function uploadCapturedDocument(
  companyId: string,
  documentId: string,
  buffer: Buffer,
  contentType: string,
): Promise<UploadResult> {
  return uploadToBucket(CAPTURED_DOCS_BUCKET, `${companyId}/${documentId}`, buffer, contentType);
}

/**
 * Upload a sealed customer invoice PDF snapshot. The path is
 * `${companyId}/${documentId}.pdf` so bucket listing stays tenant-scoped and
 * the file extension is preserved for Supabase's content-type negotiation.
 */
export async function uploadCustomerInvoicePdf(
  companyId: string,
  documentId: string,
  buffer: Buffer,
): Promise<UploadResult> {
  await ensureCustomerInvoicesBucket();
  return uploadToBucket(
    CUSTOMER_INVOICES_BUCKET,
    `${companyId}/${documentId}.pdf`,
    buffer,
    'application/pdf',
  );
}

let customerInvoicesBucketChecked = false;

/**
 * Lazy bucket provisioner. Supabase's createBucket is idempotent via the
 * "already exists" error code, which we swallow. First call per process does
 * the network round-trip; subsequent calls are no-ops.
 */
export async function ensureCustomerInvoicesBucket(): Promise<void> {
  if (customerInvoicesBucketChecked) return;

  const { error } = await getStorageClient().createBucket(CUSTOMER_INVOICES_BUCKET, {
    public: false,
  });

  if (error && !/already exists/i.test(error.message)) {
    log.warn('Customer invoices bucket create failed', { error: error.message }, 'supabase-storage');
  }

  customerInvoicesBucketChecked = true;
}

export async function downloadCapturedDocument(
  bucket: string,
  path: string,
): Promise<Buffer> {
  const { data, error } = await getStorageClient().from(bucket).download(path);

  if (error || !data) {
    log.error('Storage download failed', { bucket, path, error: error?.message }, 'supabase-storage');
    throw new Error(`Storage download failed: ${error?.message ?? 'no data'}`);
  }

  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function removeCapturedDocument(
  bucket: string,
  path: string,
): Promise<void> {
  const { error } = await getStorageClient().from(bucket).remove([path]);
  if (error) {
    log.warn('Storage remove failed', { bucket, path, error: error.message }, 'supabase-storage');
  }
}

/**
 * Return a short-lived signed URL (default 1 hour) for client-side preview.
 * Used by the capture inbox and the evidence drill modal when we want to show
 * the original slip without proxying bytes through the Next.js server.
 */
export async function signedUrlForCapturedDocument(
  bucket: string,
  path: string,
  expiresInSeconds = 3600,
): Promise<string> {
  const { data, error } = await getStorageClient()
    .from(bucket)
    .createSignedUrl(path, expiresInSeconds);

  if (error || !data) {
    throw new Error(`Signed URL failed: ${error?.message ?? 'no data'}`);
  }
  return data.signedUrl;
}
