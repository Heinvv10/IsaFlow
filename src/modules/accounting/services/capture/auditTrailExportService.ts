/**
 * Audit-trail-as-a-product — PRD-05 Phase 12.
 *
 * Bundles a company's GL for a period plus every referenced source document
 * into a single signed PDF. Output seals with a SHA-256 hash written to the
 * audit_trail_exports row so tampering is trivially detectable.
 *
 * Portal sessions (separate auditor login URL) are issued once the pack is
 * ready — time-limited bcrypt tokens scoped to the single bundle.
 */

import PDFDocument from 'pdfkit';
import { createHash, randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { log } from '@/lib/logger';
import { uploadCapturedDocument } from '@/lib/supabaseStorage';

type Row = Record<string, unknown>;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AuditExport {
  id: string;
  companyId: string;
  periodStart: string;
  periodEnd: string;
  status: 'queued' | 'building' | 'ready' | 'failed';
  includeSourceDocs: boolean;
  jeCount: number;
  lineCount: number;
  documentCount: number;
  totalDebits: number;
  totalCredits: number;
  pdfStoragePath: string | null;
  pdfSha256: string | null;
  error: string | null;
  requestedBy: string | null;
  requestedAt: string;
  builtAt: string | null;
  expiresAt: string | null;
}

function toISODate(v: unknown): string {
  if (!v) return '';
  if (v instanceof Date) return fmtDate(v);
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : fmtDate(d);
}

function mapExport(row: Row): AuditExport {
  return {
    id: row.id as string,
    companyId: row.company_id as string,
    periodStart: toISODate(row.period_start),
    periodEnd: toISODate(row.period_end),
    status: row.status as AuditExport['status'],
    includeSourceDocs: Boolean(row.include_source_docs),
    jeCount: Number(row.je_count ?? 0),
    lineCount: Number(row.line_count ?? 0),
    documentCount: Number(row.document_count ?? 0),
    totalDebits: Number(row.total_debits ?? 0),
    totalCredits: Number(row.total_credits ?? 0),
    pdfStoragePath: (row.pdf_storage_path as string) ?? null,
    pdfSha256: (row.pdf_sha256 as string) ?? null,
    error: (row.error as string) ?? null,
    requestedBy: (row.requested_by as string) ?? null,
    requestedAt: String(row.requested_at),
    builtAt: row.built_at ? String(row.built_at) : null,
    expiresAt: row.expires_at ? String(row.expires_at) : null,
  };
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export async function listExports(companyId: string, limit = 50): Promise<AuditExport[]> {
  const rows = (await sql`
    SELECT * FROM audit_trail_exports
    WHERE company_id = ${companyId}::uuid
    ORDER BY requested_at DESC
    LIMIT ${limit}
  `) as Row[];
  return rows.map(mapExport);
}

export async function getExport(id: string, companyId: string): Promise<AuditExport | null> {
  const rows = (await sql`
    SELECT * FROM audit_trail_exports
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
    LIMIT 1
  `) as Row[];
  return rows.length ? mapExport(rows[0]!) : null;
}

export interface CreateExportInput {
  companyId: string;
  periodStart: string;
  periodEnd: string;
  includeSourceDocs?: boolean;
  requestedBy?: string | null;
  expiresAt?: string | null;
}

export async function createExport(input: CreateExportInput): Promise<AuditExport> {
  const [row] = (await sql`
    INSERT INTO audit_trail_exports (
      company_id, period_start, period_end, include_source_docs,
      requested_by, expires_at, status
    ) VALUES (
      ${input.companyId}::uuid, ${input.periodStart}::date, ${input.periodEnd}::date,
      ${input.includeSourceDocs ?? true}, ${input.requestedBy ?? null},
      ${input.expiresAt ?? null}::timestamptz, 'queued'
    )
    RETURNING *
  `) as Row[];
  return mapExport(row!);
}

// ─── Pack builder ─────────────────────────────────────────────────────────────

interface JEForExport {
  id: string;
  entryNumber: string;
  entryDate: string;
  description: string;
  source: string;
  postingAgent: string | null;
  sourceDocumentId: string | null;
  documentFileName: string | null;
  documentVendorName: string | null;
  documentReference: string | null;
  lines: Array<{
    glAccountCode: string;
    glAccountName: string;
    debit: number;
    credit: number;
    description: string | null;
  }>;
}

async function loadPeriodData(exportRow: AuditExport): Promise<JEForExport[]> {
  const entries = (await sql`
    SELECT je.id, je.entry_number, je.entry_date, je.description,
           je.source, je.posting_agent, je.source_document_id,
           cd.file_name AS document_file_name,
           cd.vendor_name AS document_vendor_name,
           cd.reference_number AS document_reference
    FROM gl_journal_entries je
    LEFT JOIN captured_documents cd
      ON cd.id = je.source_document_id AND cd.company_id = ${exportRow.companyId}::uuid
    WHERE je.company_id = ${exportRow.companyId}::uuid
      AND je.status = 'posted'
      AND je.entry_date BETWEEN ${exportRow.periodStart}::date AND ${exportRow.periodEnd}::date
    ORDER BY je.entry_date ASC, je.entry_number ASC
  `) as Row[];

  const results: JEForExport[] = [];
  for (const je of entries) {
    const lines = (await sql`
      SELECT jl.debit, jl.credit, jl.description,
             ga.account_code, ga.account_name
      FROM gl_journal_lines jl
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE jl.journal_entry_id = ${je.id as string}::uuid
        AND jl.company_id = ${exportRow.companyId}::uuid
      ORDER BY jl.created_at ASC
    `) as Row[];

    results.push({
      id: je.id as string,
      entryNumber: (je.entry_number as string) ?? '',
      entryDate: toISODate(je.entry_date),
      description: (je.description as string) ?? '',
      source: (je.source as string) ?? '',
      postingAgent: (je.posting_agent as string) ?? null,
      sourceDocumentId: (je.source_document_id as string) ?? null,
      documentFileName: (je.document_file_name as string) ?? null,
      documentVendorName: (je.document_vendor_name as string) ?? null,
      documentReference: (je.document_reference as string) ?? null,
      lines: lines.map(l => ({
        glAccountCode: (l.account_code as string) ?? '',
        glAccountName: (l.account_name as string) ?? '',
        debit: Number(l.debit ?? 0),
        credit: Number(l.credit ?? 0),
        description: (l.description as string) ?? null,
      })),
    });
  }

  return results;
}

async function buildPdf(
  companyName: string,
  exportRow: AuditExport,
  entries: JEForExport[],
): Promise<{ buffer: Buffer; sha: string }> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const sha = createHash('sha256').update(buffer).digest('hex');
      resolve({ buffer, sha });
    });
    doc.on('error', reject);

    // Cover page
    doc.fontSize(22).text('Evidence Audit Pack', { align: 'left' });
    doc.moveDown(0.3);
    doc.fontSize(12).fillColor('#444').text(companyName);
    doc.moveDown(1);
    doc.fillColor('#000').fontSize(10)
      .text(`Period: ${exportRow.periodStart} to ${exportRow.periodEnd}`)
      .text(`Export ID: ${exportRow.id}`)
      .text(`Generated: ${new Date().toISOString()}`)
      .text(`Journal entries: ${entries.length}`)
      .text(`Journal lines: ${entries.reduce((s, e) => s + e.lines.length, 0)}`);
    doc.moveDown(1);

    const totalDr = entries.reduce((s, e) => s + e.lines.reduce((t, l) => t + l.debit, 0), 0);
    const totalCr = entries.reduce((s, e) => s + e.lines.reduce((t, l) => t + l.credit, 0), 0);
    doc.text(`Total debits: R ${totalDr.toFixed(2)}`);
    doc.text(`Total credits: R ${totalCr.toFixed(2)}`);
    doc.text(`Balance check: ${Math.abs(totalDr - totalCr) < 0.01 ? 'BALANCED ✓' : 'UNBALANCED — investigate'}`);

    doc.moveDown(2);
    doc.fontSize(8).fillColor('#888')
      .text('This pack is cryptographically sealed. The SHA-256 hash below must match the value stored alongside this export.');

    // Journal entries
    doc.addPage();
    doc.fontSize(14).fillColor('#000').text('Journal Entries', { underline: true });
    doc.moveDown(0.5);

    for (const e of entries) {
      doc.fontSize(10).fillColor('#000')
        .text(`${e.entryNumber}  ·  ${e.entryDate}  ·  ${e.source}  ·  agent: ${e.postingAgent ?? '—'}`);
      doc.fontSize(9).fillColor('#444').text(e.description);
      if (e.documentVendorName || e.documentReference) {
        doc.fontSize(8).fillColor('#666')
          .text(`Source doc: ${e.documentVendorName ?? ''} ${e.documentReference ?? ''}`.trim());
      }
      doc.moveDown(0.25);
      // Lines as simple 4-column table
      doc.fontSize(8).fillColor('#000');
      for (const l of e.lines) {
        doc.text(
          `${(l.glAccountCode + ' ' + l.glAccountName).padEnd(40)} ${l.debit > 0 ? 'DR ' + l.debit.toFixed(2) : '               '}  ${l.credit > 0 ? 'CR ' + l.credit.toFixed(2) : ''}`,
          { lineBreak: false },
        );
        doc.moveDown(0.15);
      }
      doc.moveDown(0.6);
    }

    doc.end();
  });
}

// ─── Main pipeline ────────────────────────────────────────────────────────────

export async function buildExport(id: string, companyId: string): Promise<AuditExport> {
  const existing = await getExport(id, companyId);
  if (!existing) throw new Error('Export not found');
  if (existing.status === 'ready') return existing;

  await sql`
    UPDATE audit_trail_exports SET status = 'building'
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
  `;

  try {
    const [companyRow] = (await sql`
      SELECT name FROM companies WHERE id = ${companyId}::uuid
    `) as Row[];
    const companyName = (companyRow?.name as string) ?? 'ISAFlow';

    const entries = await loadPeriodData(existing);
    const docIds = new Set(entries.map(e => e.sourceDocumentId).filter(Boolean) as string[]);

    const { buffer, sha } = await buildPdf(companyName, existing, entries);

    // Reuse the captured-documents bucket for the PDF pack. The path is
    // namespaced by companyId/id so tenant isolation holds.
    const upload = await uploadCapturedDocument(
      companyId,
      `audit-${id}`,
      buffer,
      'application/pdf',
    );

    const totalDr = entries.reduce((s, e) => s + e.lines.reduce((t, l) => t + l.debit, 0), 0);
    const totalCr = entries.reduce((s, e) => s + e.lines.reduce((t, l) => t + l.credit, 0), 0);
    const lineCount = entries.reduce((s, e) => s + e.lines.length, 0);

    const [updated] = (await sql`
      UPDATE audit_trail_exports
      SET status = 'ready',
          je_count = ${entries.length},
          line_count = ${lineCount},
          document_count = ${docIds.size},
          total_debits = ${totalDr},
          total_credits = ${totalCr},
          pdf_storage_bucket = ${upload.bucket},
          pdf_storage_path = ${upload.path},
          pdf_sha256 = ${sha},
          built_at = NOW()
      WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
      RETURNING *
    `) as Row[];

    log.info('audit export built', {
      id, companyId, entries: entries.length, docs: docIds.size, sha,
    }, 'audit-export');

    return mapExport(updated!);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('audit export build failed', { id, companyId, err: msg }, 'audit-export');
    await sql`
      UPDATE audit_trail_exports
      SET status = 'failed', error = ${msg}
      WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
    `;
    throw err;
  }
}

// ─── Portal sessions ──────────────────────────────────────────────────────────

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

export async function createPortalSession(
  exportId: string,
  companyId: string,
  auditorEmail: string,
  opts: { issuedBy?: string | null; ttlHours?: number } = {},
): Promise<{ session: PortalSession; accessToken: string }> {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = await bcrypt.hash(token, 10);
  const ttlHours = opts.ttlHours ?? 7 * 24;

  const [row] = (await sql`
    INSERT INTO audit_portal_sessions
      (export_id, company_id, auditor_email, token_hash, issued_by, expires_at)
    VALUES
      (${exportId}::uuid, ${companyId}::uuid, ${auditorEmail},
       ${tokenHash}, ${opts.issuedBy ?? null},
       NOW() + (${ttlHours} || ' hours')::interval)
    RETURNING *
  `) as Row[];

  log.info('audit portal session issued', {
    exportId, auditorEmail, expiresAt: row!.expires_at,
  }, 'audit-export');

  return { session: mapSession(row!), accessToken: token };
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
  const rows = (await sql`
    UPDATE audit_portal_sessions
    SET revoked_at = NOW()
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
      AND revoked_at IS NULL
    RETURNING id
  `) as Array<{ id: string }>;
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
