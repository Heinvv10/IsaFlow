/**
 * mcp_upload_intents (999q): the rows behind create_upload_urls → PUT /api/mcp/uploads/<token> → finalize_uploads.
 *
 * The upload token is 32 random bytes (base64url, 43 characters). Only its sha256 is stored, so a database read never
 * yields a usable URL, and the lookup is an equality probe on that hash (no timing signal about the token itself).
 *
 * Every statement names company_id. The MCP tools run under the bearer pipeline's RLS context; the PUT route runs on the
 * service pool (no tenant GUCs) and reaches a row by its token hash first, then names id AND company_id on the write.
 */
import { createHash, randomBytes } from 'crypto';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

/** How long an upload URL stays usable. Unfinalized rows past it are purged. */
export const UPLOAD_TTL_MINUTES = 30;
/** Rows deleted per purge call: bounded so a tool call never stalls on a backlog. */
const PURGE_BATCH = 500;

export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;

export type UploadTargetKind =
  | 'bank_transaction' | 'supplier_invoice' | 'customer_invoice' | 'credit_note' | 'supplier_payment' | 'customer_payment';

export type IntentStatus = 'pending' | 'uploaded' | 'finalized' | 'refused';

export interface UploadIntent {
  id: string;
  companyId: string;
  targetKind: UploadTargetKind;
  targetId: string;
  documentType: string | null;
  /** The user and token (PAT id / OAuth authorisation id) that asked for the url; finalize binds to both. */
  createdBy: string;
  createdTokenJti: string | null;
  fileName: string;
  mimeType: string;
  declaredSize: number;
  sha256: string;
  status: IntentStatus;
  stagedBytes: Buffer | null;
  resultDocumentId: string | null;
  resultDuplicate: boolean | null;
  refusal: string | null;
  expiresAt: string;
  expired: boolean;
}

export function newUploadToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashUploadToken(token) };
}

export function hashUploadToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

function mapIntent(r: DbRow): UploadIntent {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    targetKind: String(r.target_kind) as UploadTargetKind,
    targetId: String(r.target_id),
    documentType: r.document_type == null ? null : String(r.document_type),
    createdBy: String(r.created_by),
    createdTokenJti: r.created_token_jti == null ? null : String(r.created_token_jti),
    fileName: String(r.file_name),
    mimeType: String(r.mime_type),
    declaredSize: Number(r.declared_size),
    sha256: String(r.sha256),
    status: String(r.status) as IntentStatus,
    stagedBytes: r.staged_bytes == null ? null : Buffer.from(r.staged_bytes as Buffer),
    resultDocumentId: r.result_document_id == null ? null : String(r.result_document_id),
    resultDuplicate: r.result_duplicate == null ? null : Boolean(r.result_duplicate),
    refusal: r.refusal == null ? null : String(r.refusal),
    expiresAt: iso(r.expires_at),
    expired: Boolean(r.expired),
  };
}

export interface NewIntent {
  targetKind: UploadTargetKind;
  targetId: string;
  documentType: string | null;
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
}

export async function insertUploadIntent(
  companyId: string, by: { userId: string; tokenJti: string | null }, i: NewIntent,
): Promise<{ id: string; token: string; expiresAt: string }> {
  const { token, tokenHash } = newUploadToken();
  const [row] = (await sql`
    INSERT INTO mcp_upload_intents
      (company_id, created_by, created_token_jti, target_kind, target_id, document_type, file_name, mime_type, declared_size, sha256,
       token_hash, expires_at)
    VALUES (${companyId}::UUID, ${by.userId}, ${by.tokenJti}, ${i.targetKind}, ${i.targetId}::UUID, ${i.documentType}, ${i.fileName},
            ${i.mimeType}, ${i.size}, ${i.sha256}, ${tokenHash}, now() + make_interval(mins => ${UPLOAD_TTL_MINUTES}))
    RETURNING id, expires_at
  `) as DbRow[];
  return { id: String(row!.id), token, expiresAt: iso(row!.expires_at) };
}

/**
 * The document an earlier finalized upload of the same bytes to the same target wrote (or matched), while that document
 * is still live: an active entity-store row, or an attachment still on the bank line. A document since removed is not a
 * duplicate, so the file can be sent again.
 */
export async function findFinalizedSameBytes(
  companyId: string, targetKind: UploadTargetKind, targetId: string, sha256: string,
): Promise<string | null> {
  const [row] = (await sql`
    SELECT i.result_document_id FROM mcp_upload_intents i
     WHERE i.company_id = ${companyId}::UUID AND i.target_kind = ${targetKind} AND i.target_id = ${targetId}::UUID
       AND i.sha256 = ${sha256} AND i.status = 'finalized'
       AND (
         (i.target_kind = 'bank_transaction' AND EXISTS (
            SELECT 1 FROM bank_transaction_attachments a JOIN bank_transactions bt ON bt.id = a.bank_transaction_id
             WHERE a.id = i.result_document_id AND bt.id = i.target_id AND bt.company_id = i.company_id))
         OR (i.target_kind <> 'bank_transaction' AND EXISTS (
            SELECT 1 FROM procurement_documents pd
             WHERE pd.id = i.result_document_id AND pd.entity_id = i.target_id AND pd.is_active = true)))
     ORDER BY i.finalized_at
     LIMIT 1
  `) as DbRow[];
  return row ? String(row.result_document_id) : null;
}

/** The intent a token names (any company: the token is the credential), with whether it has expired. */
export async function findIntentByToken(token: string): Promise<UploadIntent | null> {
  const [row] = (await sql`
    SELECT i.*, (i.expires_at <= now()) AS expired FROM mcp_upload_intents i
     WHERE i.token_hash = ${hashUploadToken(token)}
  `) as DbRow[];
  return row ? mapIntent(row) : null;
}

/** Stage the bytes of a pending, unexpired intent. False when another PUT got there first or it expired meanwhile. */
export async function stageUploadBytes(companyId: string, id: string, bytes: Buffer): Promise<boolean> {
  const rows = (await sql`
    UPDATE mcp_upload_intents SET staged_bytes = ${bytes}, status = 'uploaded', uploaded_at = now()
     WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID AND status = 'pending' AND expires_at > now()
    RETURNING id
  `) as DbRow[];
  return rows.length === 1;
}

/** One of this company's intents, locked for finalize. */
export async function lockIntentForFinalize(companyId: string, id: string): Promise<UploadIntent | null> {
  const [row] = (await sql`
    SELECT i.*, (i.expires_at <= now()) AS expired FROM mcp_upload_intents i
     WHERE i.id = ${id}::UUID AND i.company_id = ${companyId}::UUID
     FOR UPDATE
  `) as DbRow[];
  return row ? mapIntent(row) : null;
}

export async function markIntentFinalized(
  companyId: string, id: string, documentId: string, duplicate: boolean,
): Promise<void> {
  await sql`
    UPDATE mcp_upload_intents
       SET status = 'finalized', result_document_id = ${documentId}::UUID, result_duplicate = ${duplicate},
           staged_bytes = NULL, finalized_at = now()
     WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `;
}

export async function markIntentRefused(companyId: string, id: string, refusal: string): Promise<void> {
  await sql`
    UPDATE mcp_upload_intents SET status = 'refused', refusal = ${refusal.slice(0, 300)}, staged_bytes = NULL
     WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `;
}

/** Delete up to PURGE_BATCH of the company's unfinalized intents past their expiry (staged bytes go with them). */
export async function purgeExpiredIntents(companyId: string): Promise<number> {
  const rows = (await sql`
    DELETE FROM mcp_upload_intents
     WHERE id IN (
       SELECT id FROM mcp_upload_intents
        WHERE company_id = ${companyId}::UUID AND status <> 'finalized' AND expires_at <= now()
        LIMIT ${PURGE_BATCH})
       AND company_id = ${companyId}::UUID
    RETURNING id
  `) as DbRow[];
  return rows.length;
}
