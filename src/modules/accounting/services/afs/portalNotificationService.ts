/**
 * Portal Notification Service
 * Sends portal notifications via email for key lifecycle events.
 * Never throws — notification failures must not break the calling flow.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { sendEmail } from '@/modules/accounting/services/core/emailService';
import { emailLayout, ctaButton } from '@/lib/email-templates-shared';
import type { PortalContact } from './afsTypes';

const APP_URL = 'https://app.isaflow.co.za';

export async function notifyMagicLinkRequested(
  contact: PortalContact,
  magicLinkUrl: string,
): Promise<void> {
  try {
    const html = emailLayout(`
      <h2>ISaFlow Portal — Sign-in Link</h2>
      <p>Hi ${contact.name},</p>
      <p>Click the button below to access your financial documents. This link expires in 30 minutes.</p>
      ${ctaButton('Sign In to Portal', magicLinkUrl)}
      <p style="font-size:12px;color:#94a3b8;">If you did not request this link, you can safely ignore this email.</p>
    `);
    await sendEmail({
      to: contact.email,
      subject: 'ISaFlow Portal — Your sign-in link',
      html,
      _log: { companyId: contact.companyId, emailType: 'other', sentBy: null },
    });
    log.info('Magic link email sent', { contactId: contact.id, email: contact.email }, 'portalNotificationService');
  } catch (err) {
    log.error(
      'Failed to send magic link email',
      { contactId: contact.id, error: err instanceof Error ? err.message : String(err) },
      'portalNotificationService',
    );
  }
}

export async function notifySigningRequested(
  contact: PortalContact,
  documentId: string,
  signingUrl: string,
): Promise<void> {
  try {
    const html = emailLayout(`
      <h2>Annual Financial Statements — Signature Required</h2>
      <p>Hi ${contact.name},</p>
      <p>The annual financial statements for your company are ready for your signature.</p>
      ${ctaButton('Review & Sign', signingUrl)}
      <p style="font-size:12px;color:#94a3b8;">This signing link expires in ${process.env.SIGNUM_EXPIRES_IN_DAYS ?? 14} days.</p>
    `);
    await sendEmail({
      to: contact.email,
      subject: 'Annual Financial Statements — Signature Required',
      html,
      _log: { companyId: contact.companyId, emailType: 'other', sentBy: null },
    });
    log.info('Signing request email sent', { contactId: contact.id, documentId }, 'portalNotificationService');
  } catch (err) {
    log.error(
      'Failed to send signing request email',
      { contactId: contact.id, error: err instanceof Error ? err.message : String(err) },
      'portalNotificationService',
    );
  }
}

export async function notifyDocumentSignedOff(
  companyId: string,
  documentId: string,
): Promise<void> {
  try {
    const contacts = (await sql`
      SELECT id, name, email
      FROM portal_contacts
      WHERE company_id = ${companyId}::UUID
        AND active = true
        AND role IN ('director', 'cfo')
    `) as Array<{ id: string; name: string; email: string }>;

    for (const row of contacts) {
      const html = emailLayout(`
        <h2>Annual Financial Statements — Signed Off</h2>
        <p>Hi ${row.name},</p>
        <p>All signatures have been collected. The signed document is now available in your portal.</p>
        ${ctaButton('View in Portal', `${APP_URL}/accounting/afs/portal/dashboard`)}
      `);
      await sendEmail({
        to: row.email,
        subject: 'Annual Financial Statements — Signed Off',
        html,
        _log: { companyId, emailType: 'other', sentBy: null },
      });
    }
    log.info(
      'Signed-off notification sent',
      { companyId, documentId, recipientCount: contacts.length },
      'portalNotificationService',
    );
  } catch (err) {
    log.error(
      'Failed to send signed-off notification',
      { companyId, error: err instanceof Error ? err.message : String(err) },
      'portalNotificationService',
    );
  }
}

export async function notifyAnnotationReceived(
  companyId: string,
  sectionId: string,
  authorName: string,
): Promise<void> {
  try {
    log.info(
      'Annotation received (email notification not yet implemented)',
      { companyId, sectionId, authorName },
      'portalNotificationService',
    );
    // TODO: email the reviewing accountant that a client annotation was received
  } catch (err) {
    log.error(
      'Failed to send annotation notification',
      { companyId, error: err instanceof Error ? err.message : String(err) },
      'portalNotificationService',
    );
  }
}
