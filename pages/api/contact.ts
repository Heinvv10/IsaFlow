import type { NextApiHandler } from 'next';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { checkRateLimit, getClientIp, withRateLimit } from '@/lib/rateLimit';
import { sendEmail } from '@/modules/accounting/services/core/emailService';
import { emailLayout } from '@/lib/email-templates-shared';
import { validateContactSubmission, buildContactEmail } from '@/lib/contactForm';
import { log } from '@/lib/logger';

/**
 * Public "book a demo / contact us" endpoint. Unauthenticated by design (it's a
 * marketing form), so abuse is bounded by rate-limiting + a honeypot rather than
 * a session. Sends the enquiry to the sales inbox via the shared email service.
 */
const CONTACT_INBOX = process.env.CONTACT_INBOX || 'accounts@isaflow.co.za';

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const result = validateContactSubmission(req.body);
  if (!result.ok) {
    // Honeypot hits return a generic success so bots get no signal; genuine
    // validation errors get the specific message for the user to fix.
    if (result.error === 'spam') {
      log.warn('contact form honeypot tripped', { ip: getClientIp(req) }, 'contact');
      return apiResponse.success(res, null);
    }
    return apiResponse.badRequest(res, result.error);
  }

  // Second, tighter limit keyed on the submitter's email — stops one address
  // flooding the inbox from many IPs (the withRateLimit wrapper covers per-IP).
  const emailAllowed = await checkRateLimit(`contact:email:${result.data.email}`, {
    max: 3,
    windowSecs: 900,
  });
  if (!emailAllowed) {
    log.warn('contact form rate limit (email)', { email: result.data.email, ip: getClientIp(req) }, 'contact');
    // Generic success — do not reveal the limit to a spammer.
    return apiResponse.success(res, null);
  }

  const { subject, html } = buildContactEmail(result.data);
  const sent = await sendEmail({
    to: CONTACT_INBOX,
    subject,
    html: emailLayout(html),
    _log: { companyId: null, emailType: 'other', sentBy: null },
  });

  if (!sent.success) {
    log.error('contact form email failed', { error: sent.error, email: result.data.email }, 'contact');
    // apiResponse.error surfaces `message` in prod too (internalError masks it
    // outside development), so the reassuring "email us directly" copy reaches
    // the user. Maps to a 500 via STATUS_CODE_MAP.
    return apiResponse.error(
      res,
      ErrorCode.INTERNAL_ERROR,
      'Could not send your message right now. Please email us directly at accounts@isaflow.co.za.',
    );
  }

  return apiResponse.success(res, null, 'Thanks — we will be in touch shortly.');
};

// Cap the request body — a contact form never needs more than a few KB, and it
// bounds the unbounded honeypot field cheaply.
export const config = { api: { bodyParser: { sizeLimit: '16kb' } } };

// Per-IP rate limit: a handful of submissions per 15 min is plenty for a human.
export default withRateLimit(handler, { max: 5, windowSecs: 900 }, 'contact');
