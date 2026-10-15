/**
 * MCP write tool: attach_entity_document — file a supporting document (a
 * supplier's tax invoice, a remittance, a credit note scan) against an
 * accounting document: supplier_invoice, customer_invoice, credit_note,
 * supplier_payment or customer_payment. Posts nothing, so no requiresPost.
 *
 * This is the entity store (procurement_documents, what the bill and invoice
 * screens show and list_documents reads with entity_type/entity_id), NOT the
 * bank-transaction store attach_document writes. The two are not linked.
 *
 * Bytes travel base64 in the args, as for attach_document. The cap is 2 MB of
 * file bytes: base64 makes that ~2.7 MB, inside the endpoint's 3 MB body.
 *
 * Every refusal happens before storeDocumentBytes uploads or INSERTs, so
 * toolError is safe throughout.
 */
import type { McpTool } from '../types';
import {
  ALLOWED_MIME_TYPES,
  VALID_DOCUMENT_TYPES,
  VALID_ENTITY_TYPES,
  findActiveDuplicate,
  storeDocumentBytes,
  verifyEntityOwnershipTyped,
} from '@/modules/accounting/services/core/documentStorageService';
import type { AccountingEntityType } from '@/types/procurement/document.types';
import { decodeUploadPayload, magicBytesMatchMime } from '@/lib/fileMagic';
import { NOT_FOUND, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

export const ATTACH_ENTITY_MAX_BYTES = 2 * 1024 * 1024;
const MAX_FILE_NAME = 200;
const MAX_NOTES = 1000;

export const attachEntityDocumentTool: McpTool = {
  name: 'attach_entity_document',
  description:
    'Attach a supporting document to an accounting document: entity_type supplier_invoice, customer_invoice, credit_note, supplier_payment or customer_payment, named by entity_id. ' +
    'Use this for a supplier\'s tax invoice on a bill, a remittance on a receipt, a credit note scan. For a slip on a BANK TRANSACTION use attach_document — the two stores are separate. ' +
    'content is the file as base64 (a data: URL is also accepted). Accepts PDF, JPEG, PNG, DOCX, XLSX; maximum 2 MB of file bytes per call. ' +
    'The declared mime_type is checked against the file\'s real bytes and refused on mismatch. ' +
    'If the entity already holds an active document with the same file name and size, nothing is stored and that document comes back with duplicate: true, so a bulk back-fill can be re-run safely. ' +
    'extract (default false) runs the background text extraction on the file. Posts nothing.',
  scope: 'write:invoices',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      entity_type: { type: 'string', enum: [...VALID_ENTITY_TYPES] },
      entity_id: { type: 'string', description: 'UUID of the bill, invoice, credit note or payment.' },
      document_type: {
        type: 'string', enum: [...VALID_DOCUMENT_TYPES],
        description: 'Default "invoice" for invoices and bills, "credit_note_doc" for credit notes, "proof_of_payment" for payments.',
      },
      file_name: { type: 'string', description: 'e.g. "SIV0005104 FTTX 48I01087.pdf"' },
      mime_type: { type: 'string', enum: [...ALLOWED_MIME_TYPES] },
      content: { type: 'string', description: 'Base64 file bytes, or a data:<mime>;base64,… URL.' },
      notes: { type: 'string', description: 'Optional, e.g. the source ("Sage SIV0005104 attachment").' },
      extract: { type: 'boolean', description: 'Run background text extraction (default false).' },
      idempotency_key: { type: 'string' },
    },
    required: ['entity_type', 'entity_id', 'file_name', 'mime_type', 'content', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const entityType = strArg(args, 'entity_type');
    // enum is advisory — the transport does not validate against inputSchema.
    if (!entityType || !(VALID_ENTITY_TYPES as readonly string[]).includes(entityType)) {
      return toolError(`invalid entity_type — expected one of: ${VALID_ENTITY_TYPES.join(', ')}`);
    }
    const entityId = strArg(args, 'entity_id');
    if (!entityId) return toolError('entity_id is required');
    const bad = guardCastableArgs(args, { uuid: ['entity_id'] });
    if (bad) return bad;

    const documentType = strArg(args, 'document_type') ?? defaultDocumentType(entityType as AccountingEntityType);
    if (!(VALID_DOCUMENT_TYPES as readonly string[]).includes(documentType)) {
      return toolError(`invalid document_type — expected one of: ${VALID_DOCUMENT_TYPES.join(', ')}`);
    }

    const fileName = strArg(args, 'file_name');
    if (!fileName) return toolError('file_name is required');
    if (fileName.length > MAX_FILE_NAME) return toolError(`file_name exceeds ${MAX_FILE_NAME} characters`);

    const notes = strArg(args, 'notes');
    if (notes && notes.length > MAX_NOTES) return toolError(`notes exceeds ${MAX_NOTES} characters`);

    const mimeType = strArg(args, 'mime_type');
    if (!mimeType || !ALLOWED_MIME_TYPES.includes(mimeType)) {
      return toolError(`invalid mime_type — expected one of: ${ALLOWED_MIME_TYPES.join(', ')}`);
    }

    const content = typeof args.content === 'string' ? args.content : '';
    if (!content) return toolError('content is required');
    const bytes = decodeUploadPayload(content);
    if (!bytes) return toolError('content is not valid base64');
    if (bytes.length > ATTACH_ENTITY_MAX_BYTES) {
      return toolError(`File exceeds the ${ATTACH_ENTITY_MAX_BYTES / (1024 * 1024)} MB limit (got ${bytes.length} bytes)`);
    }
    if (!magicBytesMatchMime(bytes, mimeType)) {
      return toolError(`File contents do not match mime_type ${mimeType}`);
    }

    // Typed: the id must be a row of the declared kind, not merely ours.
    // Cross-tenant and genuine miss read identically.
    if (!(await verifyEntityOwnershipTyped(entityType as AccountingEntityType, entityId, ctx.companyId))) {
      return toolError(NOT_FOUND);
    }

    const existing = await findActiveDuplicate(entityType, entityId, fileName, bytes.length);
    if (existing) return ok({ ...shape(existing), duplicate: true });

    const doc = await storeDocumentBytes({
      companyId: ctx.companyId,
      entityType,
      entityId,
      documentType,
      notes,
      buffer: bytes,
      mimeType,
      size: bytes.length,
      originalFilename: fileName,
      uploadedBy: ctx.userId,
      uploadedByName: 'mcp',
      extract: args.extract === true,
    });
    return ok({ ...shape(doc), duplicate: false });
  },
};

function defaultDocumentType(entityType: AccountingEntityType): string {
  switch (entityType) {
    case 'credit_note': return 'credit_note_doc';
    case 'supplier_payment':
    case 'customer_payment': return 'proof_of_payment';
    default: return 'invoice';
  }
}

function shape(d: { id: string; entityType: string; entityId: string; documentType: string; documentName: string; fileSize?: number; mimeType?: string; uploadedAt: string }) {
  return {
    document_id: d.id,
    entity_type: d.entityType,
    entity_id: d.entityId,
    document_type: d.documentType,
    file_name: d.documentName,
    file_size: d.fileSize ?? null,
    mime_type: d.mimeType ?? null,
    uploaded_at: d.uploadedAt,
  };
}
