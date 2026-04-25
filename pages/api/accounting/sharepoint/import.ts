/**
 * POST /api/accounting/sharepoint/import
 *
 * Body: { serverRelativeUrl: string, entityType: string, entityId: string }
 *
 * Flow:
 *   1. Download file from SharePoint
 *   2. Upload to Supabase Storage (captured-documents bucket)
 *   3. Insert into captured_documents table
 *   4. Link to the target entity (supplier_invoice / customer_invoice / bank_transaction)
 *   5. Return the captured_document row
 */

import type { NextApiResponse } from 'next';
import { randomUUID } from 'crypto';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { downloadFile } from '@/lib/sharepointClient';
import {
  uploadCapturedDocument,
  signedUrlForCapturedDocument,
  CAPTURED_DOCS_BUCKET,
} from '@/lib/supabaseStorage';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SqlRow = Record<string, any>;

const VALID_ENTITY_TYPES = ['supplier_invoice', 'customer_invoice', 'bank_transaction'] as const;
type EntityType = (typeof VALID_ENTITY_TYPES)[number];

interface ImportBody {
  serverRelativeUrl?: string;
  entityType?: string;
  entityId?: string;
}

function mapEntityTypeToDocumentType(entityType: EntityType): string {
  if (entityType === 'supplier_invoice') return 'supplier_invoice';
  if (entityType === 'customer_invoice') return 'customer_invoice';
  return 'bank_statement';
}

async function linkToEntity(
  entityType: EntityType,
  entityId: string,
  companyId: string,
  docId: string,
  storageBucket: string,
  storagePath: string,
  fileName: string,
  fileSize: number,
  uploadedBy: string,
): Promise<void> {
  if (entityType === 'supplier_invoice') {
    await sql`
      UPDATE supplier_invoices
      SET source_document_id = ${docId}
      WHERE id = ${entityId}
        AND company_id = ${companyId}
    `;
  } else if (entityType === 'customer_invoice') {
    await sql`
      UPDATE customer_invoices
      SET source_document_id = ${docId}
      WHERE id = ${entityId}
        AND company_id = ${companyId}
    `;
  } else if (entityType === 'bank_transaction') {
    const signedUrl = await signedUrlForCapturedDocument(
      storageBucket,
      storagePath,
      365 * 24 * 3600,
    );
    const attachmentId = randomUUID();
    await sql`
      INSERT INTO bank_transaction_attachments
        (id, bank_transaction_id, file_url, file_name, file_size, uploaded_by)
      VALUES
        (${attachmentId}, ${entityId}, ${signedUrl}, ${fileName}, ${fileSize}, ${uploadedBy})
    `;
  }
}

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  if (!process.env.AZURE_CLIENT_ID) {
    return apiResponse.badRequest(res, 'SharePoint not configured');
  }

  const { serverRelativeUrl, entityType, entityId } = req.body as ImportBody;

  if (!serverRelativeUrl || typeof serverRelativeUrl !== 'string') {
    return apiResponse.badRequest(res, 'serverRelativeUrl is required');
  }
  if (!entityType || !VALID_ENTITY_TYPES.includes(entityType as EntityType)) {
    return apiResponse.badRequest(res, 'entityType must be one of: supplier_invoice, customer_invoice, bank_transaction');
  }
  if (!entityId || typeof entityId !== 'string') {
    return apiResponse.badRequest(res, 'entityId is required');
  }

  const companyId = req.companyId;
  const uploadedBy = req.user.id;
  const typedEntityType = entityType as EntityType;

  log.info('SharePoint import started', { serverRelativeUrl, entityType, entityId, companyId }, 'sharepoint-import');

  const { buffer, contentType, fileName } = await downloadFile(serverRelativeUrl);

  const docId = randomUUID();
  const uploadResult = await uploadCapturedDocument(companyId, docId, buffer, contentType);

  const documentType = mapEntityTypeToDocumentType(typedEntityType);
  const notes = `SharePoint: ${serverRelativeUrl}`;

  const rows = await sql`
    INSERT INTO captured_documents
      (id, company_id, file_name, file_type, file_size, document_type, status,
       notes, storage_bucket, storage_path, uploaded_by, created_at)
    VALUES
      (${docId}, ${companyId}, ${fileName}, ${contentType}, ${buffer.length},
       ${documentType}, 'matched', ${notes},
       ${uploadResult.bucket}, ${uploadResult.path}, ${uploadedBy}, NOW())
    RETURNING *
  ` as SqlRow[];

  const capturedDoc = rows[0];

  await linkToEntity(
    typedEntityType,
    entityId,
    companyId,
    docId,
    uploadResult.bucket,
    uploadResult.path,
    fileName,
    buffer.length,
    uploadedBy,
  );

  log.info('SharePoint import complete', { docId, entityType, entityId, companyId }, 'sharepoint-import');

  return apiResponse.success(res, capturedDoc);
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
