// src/modules/accounting/services/afs/packDeliveryService.ts
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { sendEmail } from '@/modules/accounting/services/core/emailService';
import { emailLayout } from '@/lib/email-templates';
import type { PackRecipient, KpiResult } from './afsTypes';
import { getKpiScorecard } from './afsKpiService';

type Row = DbRow;

// ── HTML escaping ─────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The statuses that mean a person has signed the pack off. Everything else is a draft. */
const SIGNED_STATUSES = new Set(['signed_off', 'filed']);
const DRAFT_MARK = 'DRAFT — NOT FOR DISTRIBUTION';

// ── PDF stub ─────────────────────────────────────────────────────────────────
async function generatePackPdf(documentId: string, companyId: string, documentStatus: string): Promise<Buffer | null> {
  try {
    const { exportToPdf } = await import('./pdfExportService');
    // A pack that is not signed off goes out marked as a draft, so a draft-tier recipient can
    // never mistake an unreviewed pack for a signed one.
    return await exportToPdf(documentId, companyId, {
      skipChecks: true,
      ...(SIGNED_STATUSES.has(documentStatus) ? {} : { watermark: DRAFT_MARK }),
    });
  } catch (err) {
    log.warn(
      'PDF generation failed — delivering email without attachment',
      { documentId, companyId, error: err instanceof Error ? err.message : String(err) },
      'packDeliveryService',
    );
    return null;
  }
}

// ── Data fetchers ────────────────────────────────────────────────────────────

async function fetchDocument(documentId: string, companyId: string): Promise<Row | null> {
  const rows = (await sql`
    SELECT * FROM afs_documents
    WHERE id = ${documentId}::UUID
      AND company_id = ${companyId}::UUID
    LIMIT 1
  `) as Row[];
  return rows[0] ?? null;
}

async function fetchConfig(companyId: string): Promise<Row | null> {
  const rows = (await sql`
    SELECT * FROM management_pack_configs
    WHERE company_id = ${companyId}::UUID
    LIMIT 1
  `) as Row[];
  return rows[0] ?? null;
}

async function fetchCompanyName(companyId: string): Promise<string> {
  const rows = (await sql`
    SELECT name FROM companies WHERE id = ${companyId}::UUID LIMIT 1
  `) as Row[];
  return String(rows[0]?.name ?? 'Unknown Company');
}

// ── Email builder ────────────────────────────────────────────────────────────

function ragColour(rag: string): string {
  if (rag === 'green') return '#16a34a';
  if (rag === 'amber') return '#d97706';
  return '#dc2626';
}

function buildPackEmailHtml(params: {
  companyName: string;
  period: string;
  kpis: KpiResult[];
  portalUrl: string;
  isDraft: boolean;
}): string {
  const topKpis = [...params.kpis]
    .sort((a, b) => {
      const order = { red: 0, amber: 1, green: 2 };
      return order[a.rag] - order[b.rag];
    })
    .slice(0, 5);

  const kpiBlocks = topKpis
    .map(
      k => `
      <div style="display:inline-block;margin:6px;padding:12px 20px;background:#f8fafc;border-left:4px solid ${ragColour(k.rag)};border-radius:4px;min-width:140px;">
        <div style="font-size:12px;color:#64748b;">${escapeHtml(k.label)}</div>
        <div style="font-size:20px;font-weight:700;color:#0f172a;">${escapeHtml(k.formatted)}</div>
        <div style="font-size:11px;color:${ragColour(k.rag)};text-transform:uppercase;">${escapeHtml(k.rag)}</div>
      </div>`,
    )
    .join('');

  // The KPI figures travel in the body as well as the PDF, so the draft mark does too.
  const draftBanner = params.isDraft
    ? `<p style="background:#fef3c7;color:#92400e;font-weight:700;padding:8px 12px;border-radius:4px;margin:0 0 16px;">${DRAFT_MARK} — this pack has not been signed off.</p>`
    : '';
  const body = `
    ${draftBanner}
    <h2 style="color:#0f172a;margin:0 0 4px;">${escapeHtml(params.companyName)}</h2>
    <p style="color:#64748b;margin:0 0 24px;">Management Accounts — ${escapeHtml(params.period)}</p>
    <h3 style="color:#0f172a;margin:0 0 12px;font-size:14px;text-transform:uppercase;letter-spacing:0.05em;">KPI Dashboard</h3>
    <div style="margin-bottom:24px;">${kpiBlocks}</div>
    <div style="text-align:center;margin-top:32px;">
      <a href="${params.portalUrl}" style="display:inline-block;padding:12px 28px;background:#2563eb;color:#fff;font-weight:600;border-radius:6px;text-decoration:none;">
        View Full Report
      </a>
    </div>`;

  return emailLayout(body);
}

// ── Delivery logic ────────────────────────────────────────────────────────────

async function sendToRecipient(
  recipient: PackRecipient,
  documentStatus: string,
  subject: string,
  html: string,
  pdfBuffer: Buffer | null,
  companyId: string,
): Promise<void> {
  const { receives } = recipient;
  // Final-tier recipients receive signed packs only: in_review and partner_review are drafts too.
  const isDraft = !SIGNED_STATUSES.has(documentStatus);

  if (receives === 'final' && isDraft) return;
  if (receives === 'draft' && !isDraft) return;
  // 'both' always sends

  const attachments =
    pdfBuffer
      ? [{ filename: `${subject}.pdf`, content: pdfBuffer, contentType: 'application/pdf' }]
      : [];

  const result = await sendEmail({
    to: recipient.email,
    subject,
    html,
    attachments,
    _log: { companyId, emailType: 'other' },
  });

  if (!result.success) {
    log.error(
      'Failed to send management pack email',
      { recipient: recipient.email, error: result.error },
      'packDeliveryService',
    );
  } else {
    log.info('Management pack emailed', { recipient: recipient.email }, 'packDeliveryService');
  }
}

// ── Public interface ──────────────────────────────────────────────────────────

/** Raised when the document itself says it may not go out yet. */
export class PackDeliveryWithheldError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'PackDeliveryWithheldError';
  }
}

/**
 * Sends the pack to its recipients. THE gate for that: every delivery — the route, a future
 * scheduler, a script — passes through here, so the refusal lives here rather than in a caller.
 * A pack generated with review SKIPPED carries delivery_withheld_reason until a person signs the
 * document off (afsDocumentTransitions clears it and audits the release).
 */
export async function deliverPack(documentId: string, companyId: string): Promise<void> {
  log.info('Delivering management pack', { documentId, companyId }, 'packDeliveryService');

  const [doc, config, companyName] = await Promise.all([
    fetchDocument(documentId, companyId),
    fetchConfig(companyId),
    fetchCompanyName(companyId),
  ]);

  if (!doc) {
    throw new Error(`Management pack document not found: ${documentId}`);
  }

  const withheld = doc.delivery_withheld_reason as string | null;
  if (withheld) {
    log.warn('Pack delivery refused', { documentId, companyId, reason: withheld }, 'packDeliveryService');
    throw new PackDeliveryWithheldError(withheld);
  }

  const period = String(doc.period ?? '');
  const documentStatus = String(doc.status ?? 'draft');
  const recipients: PackRecipient[] = Array.isArray(config?.recipients)
    ? (config.recipients as PackRecipient[])
    : [];

  const scorecard = await getKpiScorecard(companyId, period).catch((err) => {
    log.warn('Failed to load KPIs for email', { documentId, error: String(err) }, 'packDeliveryService');
    return null;
  });
  const kpis: KpiResult[] = scorecard?.kpis ?? [];

  const portalUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.isaflow.co.za'}/accounting/afs/management-packs/${documentId}`;
  const isDraft = !SIGNED_STATUSES.has(documentStatus);
  const subject = `${isDraft ? '[DRAFT] ' : ''}${companyName} — Management Accounts ${period}`;
  const html = buildPackEmailHtml({ companyName, period, kpis, portalUrl, isDraft });

  const pdfBuffer = await generatePackPdf(documentId, companyId, documentStatus);

  for (const recipient of recipients) {
    await sendToRecipient(recipient, documentStatus, subject, html, pdfBuffer, companyId);
  }

  await sql`
    UPDATE afs_documents
    SET updated_at = NOW()
    WHERE id = ${documentId}::UUID AND company_id = ${companyId}::UUID
  `;

  log.info('Management pack delivery complete', { documentId, companyId, recipientCount: recipients.length }, 'packDeliveryService');
}

export async function scheduleDelivery(
  documentId: string,
  companyId: string,
  deliverAt: Date,
): Promise<void> {
  // For now, log the intent. A proper scheduler (e.g. BullMQ / Vercel Cron) can pick this up.
  log.info(
    'Delivery scheduled',
    { documentId, companyId, deliverAt: deliverAt.toISOString() },
    'packDeliveryService',
  );
}
