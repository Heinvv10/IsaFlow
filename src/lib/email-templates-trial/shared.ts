/**
 * Shared pieces of the four trial lifecycle emails: the payload, escaping, the upgrade contact, and a
 * layout. The layout is the shared header and button (email-templates-shared.ts) with its own footer:
 * the shared footer says "Please do not reply directly" (these emails ask the reader to write to us),
 * links a preferences page that does not exist, and carries an em dash.
 */
import { BRAND, ctaButton } from '@/lib/email-templates-shared';
import { escapeHtml } from '@/lib/email-templates-budget-digest';
import { LEGAL_ENTITY } from '@/config/legalEntity';

export { escapeHtml };

export interface TrialEmailPayload {
  companyName: string;
  recipientName: string;
  /** The trial's end date (companies.trial_ends_at). */
  trialEndsAt: Date;
  appBaseUrl: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
}

/** Where people write to upgrade. */
export const TRIAL_CONTACT_EMAIL = LEGAL_ENTITY.contactEmail;

/** The upgrade button's link: env TRIAL_UPGRADE_URL, else an email to the contact address. */
export function upgradeUrl(): string {
  const configured = process.env.TRIAL_UPGRADE_URL?.trim();
  if (configured && /^(https:\/\/|mailto:)/i.test(configured)) return configured;
  return `mailto:${TRIAL_CONTACT_EMAIL}?subject=${encodeURIComponent('Upgrade my IsaFlow trial')}`;
}

/** A header value: line breaks and control characters collapsed to one space. */
export function headerSafe(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** "27 November 2026", in South Africa's time zone. */
export function formatEndDate(d: Date): string {
  return new Intl.DateTimeFormat('en-ZA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Johannesburg' }).format(d);
}

export function greeting(p: TrialEmailPayload): string {
  return `<p style="margin:0 0 16px;">Hi ${escapeHtml(p.recipientName)},</p>`;
}

/** The company name, escaped and bold. */
export function company(p: TrialEmailPayload): string {
  return `<strong>${escapeHtml(p.companyName)}</strong>`;
}

export function para(html: string): string {
  return `<p style="margin:0 0 16px; line-height:1.6;">${html}</p>`;
}

export function list(items: readonly string[]): string {
  return `<ul style="margin:0 0 16px; padding-left:20px; line-height:1.8;">${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
}

/** A link into the app, escaped for an attribute. */
export function appLink(p: TrialEmailPayload, path: string, label: string): string {
  return `<a href="${escapeHtml(`${p.appBaseUrl}${path}`)}" style="color:${BRAND.primaryTeal};">${escapeHtml(label)}</a>`;
}

export function button(label: string, url: string): string {
  return ctaButton(escapeHtml(label), escapeHtml(url));
}

/** The contact address as a mailto link, styled like the contact line. */
export function contactLink(): string {
  const mail = escapeHtml(TRIAL_CONTACT_EMAIL);
  return `<a href="mailto:${mail}" style="color:${BRAND.primaryTeal};">${mail}</a>`;
}

export function contactLine(): string {
  return para(`Questions? Email us at ${contactLink()}.`);
}

/** Footer text: slate-600, 7.24:1 on BRAND.footerBg (#f8fafc); BRAND.textMuted is 2.45:1 there. */
export const TRIAL_FOOTER_TEXT = '#475569';

export function trialLayout(inner: string): string {
  const footer = `
    <tr><td style="background-color:${BRAND.footerBg}; padding:20px 32px; border-top:1px solid ${BRAND.borderColor};
                   font-family:${BRAND.fontStack}; font-size:12px; color:${TRIAL_FOOTER_TEXT}; line-height:1.5;">
      IsaFlow, South African cloud accounting.<br>
      You are receiving this because you started an IsaFlow trial for your company.
    </td></tr>`;
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; background-color:${BRAND.outerBg};">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="background-color:${BRAND.outerBg}; padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" border="0" role="presentation"
             style="max-width:600px; width:100%; background-color:${BRAND.cardBg}; border-radius:8px; overflow:hidden;">
        <tr><td align="center" style="background-color:${BRAND.darkBg}; padding:28px 32px; border-bottom:3px solid ${BRAND.primaryTeal};">
          <img src="${BRAND.logoUrl}" alt="IsaFlow" height="40" style="display:block; max-height:40px; width:auto; border:0;" />
        </td></tr>
        <tr><td style="padding:32px; font-family:${BRAND.fontStack}; color:${BRAND.textBody}; font-size:15px;">
          ${inner}
        </td></tr>
        ${footer}
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
