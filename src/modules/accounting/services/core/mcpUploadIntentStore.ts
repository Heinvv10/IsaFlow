/**
 * mcp_upload_intents (999q): the rows behind create_upload_urls → PUT /api/mcp/uploads/<token> → finalize_uploads.
 *
 * The upload token is self-authenticating (16 random bytes + a 16-byte HMAC tag, base64url, 43 characters; see
 * @/lib/mcp/uploadToken). Only its sha256 is stored, so a database read never yields a usable URL, and the lookup is an
 * equality probe on that hash (no timing signal about the token itself).
 *
 * Every statement names company_id. The MCP tools run under the bearer pipeline's RLS context; the PUT route runs on the
 * service pool (no tenant GUCs) and reaches a row by its token hash first, then names id AND company_id on the write.
 */
import { createHash } from 'crypto';
import type pg from 'pg';
import { sql } from '@/lib/neon';
import { uploadAdminPool } from '@/lib/mcp/uploadAdminPool';
import { log } from '@/lib/logger';
import { rollbackFailed } from '@/lib/rollbackFailed';
import { newUploadToken } from '@/lib/mcp/uploadToken';
import type { DbRow } from '@/lib/neon';

/** How long an upload URL stays usable (999q's trigger sets it; this is for messages). */
export const UPLOAD_TTL_MINUTES = 30;
/** After a successful PUT the row has this long to be finalized (999q's trigger moves expires_at). */
export const FINALIZE_WINDOW_HOURS = 2;
/** Per company: outstanding (pending or uploaded, unexpired) uploads, and the bytes they declare. */
export const MAX_OUTSTANDING_UPLOADS = 300;
export const MAX_OUTSTANDING_BYTES = 300 * 1024 * 1024;

export const SHA256_RE = /^[0-9a-f]{64}$/;

export type UploadTargetKind =
  | 'bank_transaction' | 'supplier_invoice' | 'customer_invoice' | 'credit_note' | 'supplier_payment' | 'customer_payment'
  | 'purchase_order';

export type IntentStatus = 'pending' | 'uploaded' | 'finalized' | 'refused';

/** An intent without its staged bytes (readStagedBytes fetches them when they are about to be verified). */
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
  resultDocumentId: string | null;
  resultDuplicate: boolean | null;
  refusal: string | null;
  expiresAt: string;
  expired: boolean;
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

/**
 * created_by (the session user), status and expires_at are set by 999q's trigger; app_user cannot send them. Throws
 * when the upload-token key is missing (create_upload_urls checks uploadTokenKeyAvailable first).
 */
export async function insertUploadIntent(
  companyId: string, tokenJti: string | null, i: NewIntent,
): Promise<{ id: string; token: string; expiresAt: string }> {
  const { token, tokenHash } = newUploadToken();
  const [row] = (await sql`
    INSERT INTO mcp_upload_intents
      (company_id, created_token_jti, target_kind, target_id, document_type, file_name, mime_type, declared_size, sha256,
       token_hash)
    VALUES (${companyId}::UUID, ${tokenJti}, ${i.targetKind}, ${i.targetId}::UUID, ${i.documentType}, ${i.fileName},
            ${i.mimeType}, ${i.size}, ${i.sha256}, ${tokenHash})
    RETURNING id, expires_at
  `) as DbRow[];
  return { id: String(row!.id), token, expiresAt: iso(row!.expires_at) };
}

/**
 * Serialises create_upload_urls per company (transaction-scoped advisory lock) and returns its outstanding uploads:
 * pending or uploaded, unexpired, and the bytes they declare. Two concurrent calls cannot both pass the cap.
 */
export async function lockAndReadUploadUsage(companyId: string): Promise<{ count: number; bytes: number }> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`mcp-upload-create:${companyId}`}, 0))`;
  const [row] = (await sql`
    SELECT count(*)::INT AS n, COALESCE(sum(declared_size), 0)::BIGINT AS bytes FROM mcp_upload_intents
     WHERE company_id = ${companyId}::UUID AND status IN ('pending', 'uploaded') AND expires_at > now()
  `) as DbRow[];
  return { count: Number(row?.n ?? 0), bytes: Number(row?.bytes ?? 0) };
}

/**
 * Serialises every writer of these bytes to this target until the transaction ends (finalize_uploads, attach_document):
 * taken BEFORE the duplicate read, so two concurrent writes of the same file cannot both find nothing and both store.
 */
export async function lockUploadTarget(
  companyId: string, targetKind: UploadTargetKind, targetId: string, sha256: string,
): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`mcp-upload:${companyId}:${targetKind}:${targetId}:${sha256}`}, 0))`;
}

/**
 * Entity-store targets: the document an earlier finalized upload of the same bytes to the same entity wrote (or
 * matched), while it is still active. The entity store keeps no hash, so a file attached to the entity through another
 * route is not seen here and is stored again (the safe failure). A bank line's dedup reads its stored bytes instead.
 */
export async function findFinalizedSameBytes(
  companyId: string, targetKind: UploadTargetKind, targetId: string, sha256: string,
): Promise<string | null> {
  const [row] = (await sql`
    SELECT i.result_document_id FROM mcp_upload_intents i
     WHERE i.company_id = ${companyId}::UUID AND i.target_kind = ${targetKind} AND i.target_id = ${targetId}::UUID
       AND i.sha256 = ${sha256} AND i.status = 'finalized' AND i.target_kind <> 'bank_transaction'
       AND EXISTS (
         SELECT 1 FROM procurement_documents pd
          WHERE pd.id = i.result_document_id AND pd.entity_type = i.target_kind AND pd.entity_id = i.target_id
            AND pd.is_active = true)
     ORDER BY i.finalized_at
     LIMIT 1
  `) as DbRow[];
  return row ? String(row.result_document_id) : null;
}

/** The intent a token names (any company: the token is the credential), with whether it has expired. No bytes. */
export async function findIntentByToken(token: string): Promise<UploadIntent | null> {
  const [row] = (await sql`
    SELECT i.id, i.company_id, i.target_kind, i.target_id, i.document_type, i.created_by, i.created_token_jti,
           i.file_name, i.mime_type, i.declared_size, i.sha256, i.status, i.result_document_id, i.result_duplicate,
           i.refusal, i.expires_at, (i.expires_at <= now()) AS expired
      FROM mcp_upload_intents i
     WHERE i.token_hash = ${hashUploadToken(token)}
  `) as DbRow[];
  return row ? mapIntent(row) : null;
}

/**
 * Stage the bytes of a pending, unexpired intent. False when another PUT got there first or it expired meanwhile.
 * 999q's trigger re-hashes them against the declared sha256 and opens the 2-hour finalize window.
 */
/**
 * The stage could not run now: the row is held (a finalize locked it) past STAGE_LOCK_WAIT, or the upload admin pool
 * had no connection within its connect timeout. Its code ends in `_LOCK_TIMEOUT`, so `respondIfLockTimeout` answers it
 * 503 + Retry-After: nothing was staged, the url still works, PUT again.
 */
export class UploadStageLockTimeoutError extends Error {
  readonly code = 'UPLOAD_STAGE_LOCK_TIMEOUT';
  constructor(cause: unknown) {
    super('The upload is busy (another request holds it): nothing was staged, PUT the file again in a moment', { cause });
    this.name = 'UploadStageLockTimeoutError';
  }
}

/** The longest a stage waits for its row; the pool is small and shared by every company's PUTs, so it never queues. */
export const STAGE_LOCK_WAIT = '2s';
const STAGE_STATEMENT_TIMEOUT = '30s';
const isStageTimeout = (err: unknown): boolean => {
  const code = (err as { code?: unknown } | null)?.code;
  return code === '55P03' || code === '57014'
    || (err instanceof Error && /timeout exceeded when trying to connect|connection timeout/i.test(err.message));
};

const STAGE_SQL = `UPDATE mcp_upload_intents SET staged_bytes = $3, status = 'uploaded'
  WHERE id = $1::UUID AND company_id = $2::UUID AND status = 'pending' AND expires_at > now()
  RETURNING id`;

/**
 * Stage an upload's bytes: one short transaction on the migration_admin upload pool (uploadAdminPool: no app role may
 * write staged_bytes, S-07b), never a request transaction; the row is named by id AND company_id, compare-and-set on
 * pending + unexpired. It waits at most STAGE_LOCK_WAIT for a row a finalize holds, and throws
 * UploadStageLockTimeoutError (503) rather than hold one of the pool's few connections. `db` (tests): a client already
 * in the migration_admin role and a transaction of its own, used as is.
 */
export async function stageUploadBytes(
  companyId: string, id: string, bytes: Buffer, db?: Pick<pg.PoolClient, 'query'>,
): Promise<boolean> {
  if (db) return (await db.query(STAGE_SQL, [id, companyId, bytes])).rowCount === 1;
  let client: pg.PoolClient;
  try {
    client = await uploadAdminPool().connect();
  } catch (err) {
    if (isStageTimeout(err)) throw new UploadStageLockTimeoutError(err);
    throw err;
  }
  // R-176, as routeAdminTx: a transaction this function opened is rolled back through rollbackFailed (bounded, the
  // backend cancelled on a hang), and a connection whose ROLLBACK failed is destroyed (release(true)), never handed to
  // the next PUT or sweep on this small pool.
  let opened = false;
  let unusable = false;
  try {
    opened = true; // before BEGIN (R-176): a BEGIN that reached the server but failed is rolled back too
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '${STAGE_LOCK_WAIT}'`);
    await client.query(`SET LOCAL statement_timeout = '${STAGE_STATEMENT_TIMEOUT}'`);
    const res = await client.query(STAGE_SQL, [id, companyId, bytes]);
    await client.query('COMMIT');
    opened = false;
    return res.rowCount === 1;
  } catch (err) {
    if (opened) unusable = await rollbackFailed(client, 'mcp-upload stage');
    if ((err as { code?: unknown } | null)?.code === '57014') {
      // Not a held row: the write itself ran past STAGE_STATEMENT_TIMEOUT. Still a retry for the agent, but a slow
      // database is worth seeing apart from contention.
      log.warn('MCP upload stage ran past its statement timeout', { uploadId: id, size: bytes.length }, 'mcp-uploads');
    }
    if (isStageTimeout(err)) throw new UploadStageLockTimeoutError(err);
    throw err;
  } finally {
    client.release(unusable);
  }
}

/** One of this company's intents, locked for finalize (its bytes are not read). */
export async function lockIntentForFinalize(companyId: string, id: string): Promise<UploadIntent | null> {
  const [row] = (await sql`
    SELECT i.id, i.company_id, i.target_kind, i.target_id, i.document_type, i.created_by, i.created_token_jti,
           i.file_name, i.mime_type, i.declared_size, i.sha256, i.status, i.result_document_id, i.result_duplicate,
           i.refusal, i.expires_at, (i.expires_at <= now()) AS expired
      FROM mcp_upload_intents i
     WHERE i.id = ${id}::UUID AND i.company_id = ${companyId}::UUID
     FOR UPDATE
  `) as DbRow[];
  return row ? mapIntent(row) : null;
}

/** The staged bytes of one of this company's intents (null when none are staged). */
export async function readStagedBytes(companyId: string, id: string): Promise<Buffer | null> {
  const [row] = (await sql`
    SELECT staged_bytes FROM mcp_upload_intents WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  return row?.staged_bytes == null ? null : Buffer.from(row.staged_bytes as Buffer);
}

/** 999q's trigger checks the document is the target's (and, for a bank line, holds these bytes) and clears the bytes. */
export async function markIntentFinalized(
  companyId: string, id: string, documentId: string, duplicate: boolean,
): Promise<void> {
  await sql`
    UPDATE mcp_upload_intents SET status = 'finalized', result_document_id = ${documentId}::UUID, result_duplicate = ${duplicate}
     WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `;
}

export async function markIntentRefused(companyId: string, id: string, refusal: string): Promise<void> {
  await sql`
    UPDATE mcp_upload_intents SET status = 'refused', refusal = ${refusal.slice(0, 300)}
     WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `;
}
