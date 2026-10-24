/**
 * Auditor portal sessions: time-limited bcrypt tokens scoped to one ready
 * audit export, issued by an owner or admin and presented by an outside
 * auditor to /api/audit-portal/download. Split from auditTrailExportService.ts
 * (which re-exports it) in S-07d.
 *
 * Issue and revoke run on the migration_admin pool (migration 935): a session
 * row is an outsider's download of the pack, so no app role may INSERT or
 * UPDATE audit_portal_sessions (forged claims planted the hash of a known
 * token against any company's export). App roles keep only the auditor's use
 * stamp (last_used_at, use_count), written by verifyPortalToken.
 */

import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { sql } from '@/lib/neon';
import { migrationAdminTx } from '@/lib/auth/migrationAdminPool';
import { log } from '@/lib/logger';

type Row = Record<string, unknown>;

export interface PortalSession {
  id: string;
  exportId: string;
  companyId: string;
  auditorEmail: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  useCount: number;
}

function mapSession(row: Row): PortalSession {
  return {
    id: row.id as string,
    exportId: row.export_id as string,
    companyId: row.company_id as string,
    auditorEmail: row.auditor_email as string,
    issuedAt: String(row.issued_at),
    expiresAt: String(row.expires_at),
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
    lastUsedAt: row.last_used_at ? String(row.last_used_at) : null,
    useCount: Number(row.use_count ?? 0),
  };
}

/** createPortalSession found the export not this company's, or not ready (a race the route's pre-check lost). */
export class AuditExportNotIssuableError extends Error {
  constructor() { super('This audit export is not ready to share.'); this.name = 'AuditExportNotIssuableError'; }
}

export async function createPortalSession(
  exportId: string,
  companyId: string,
  auditorEmail: string,
  opts: { issuedBy?: string | null; ttlHours?: number } = {},
): Promise<{ session: PortalSession; accessToken: string }> {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = await bcrypt.hash(token, 10);
  const ttlHours = opts.ttlHours ?? 7 * 24;

  // On migration_admin (S-07d, 935): a session row is an outsider's download
  // of the pack, so no app role may write audit_portal_sessions. The export
  // must be this company's and ready, read in the same statement.
  const row = await migrationAdminTx('issue audit portal session', async (client) => (await client.query(
    `INSERT INTO audit_portal_sessions (export_id, company_id, auditor_email, token_hash, issued_by, expires_at)
     SELECT e.id, e.company_id, $3, $4, $5, NOW() + ($6::text || ' hours')::interval
       FROM audit_trail_exports e
      WHERE e.id = $1::uuid AND e.company_id = $2::uuid AND e.status = 'ready'
     RETURNING *`,
    [exportId, companyId, auditorEmail, tokenHash, opts.issuedBy ?? null, ttlHours],
  )).rows[0] as Row | undefined);
  if (!row) throw new AuditExportNotIssuableError();

  log.info('audit portal session issued', {
    exportId, auditorEmail, expiresAt: row.expires_at,
  }, 'audit-export');

  return { session: mapSession(row), accessToken: token };
}

export async function listPortalSessions(
  exportId: string,
  companyId: string,
): Promise<PortalSession[]> {
  const rows = (await sql`
    SELECT id, company_id, export_id, auditor_email, issued_by,
           issued_at, expires_at, revoked_at, last_used_at, use_count
    FROM audit_portal_sessions
    WHERE export_id = ${exportId}::uuid AND company_id = ${companyId}::uuid
    ORDER BY issued_at DESC
  `) as Row[];
  return rows.map(mapSession);
}

export async function revokePortalSession(id: string, companyId: string): Promise<boolean> {
  const rows = await migrationAdminTx('revoke audit portal session', async (client) => (await client.query(
    `UPDATE audit_portal_sessions
        SET revoked_at = NOW()
      WHERE id = $1::uuid AND company_id = $2::uuid
        AND revoked_at IS NULL
      RETURNING id`,
    [id, companyId],
  )).rows as Array<{ id: string }>);
  return rows.length > 0;
}

export async function verifyPortalToken(
  sessionId: string,
  token: string,
): Promise<{ companyId: string; exportId: string; auditorEmail: string } | null> {
  const [row] = (await sql`
    SELECT id, company_id, export_id, auditor_email, token_hash,
           expires_at, revoked_at
    FROM audit_portal_sessions
    WHERE id = ${sessionId}::uuid
      AND revoked_at IS NULL
      AND expires_at > NOW()
  `) as Row[];
  if (!row) return null;

  const storedHash = row.token_hash as string;
  if (!storedHash) return null;

  const ok = await bcrypt.compare(token, storedHash);
  if (!ok) return null;

  // Touch last_used_at + count
  await sql`
    UPDATE audit_portal_sessions
    SET last_used_at = NOW(), use_count = use_count + 1
    WHERE id = ${sessionId}::uuid
  `;

  return {
    companyId: row.company_id as string,
    exportId: row.export_id as string,
    auditorEmail: row.auditor_email as string,
  };
}
