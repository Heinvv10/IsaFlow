/**
 * POST /api/waitlist — public pre-launch lead capture.
 *
 * We are marketing ISAFlow but not yet taking paying customers. Every
 * "Sign up" / "Create account" CTA on the public site posts here instead
 * of creating a real account. We persist the lead, notify the team, and
 * return success; duplicate emails are a silent no-op so re-submitters
 * still see the thank-you screen.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { apiResponse } from '@/lib/apiResponse';
import { checkRateLimit, getClientIp } from '@/lib/rateLimit';
import { sendEmail } from '@/modules/accounting/services/core/emailService';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const NOTIFY_TO = 'ai@velocityfibre.co.za';

function clean(value: unknown, max = 255): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function buildNotificationHtml(lead: {
  name: string | null;
  email: string;
  signup_type: 'direct' | 'accountant';
  company_name: string | null;
  practice_name: string | null;
  phone: string | null;
  annual_turnover_cents: number | null;
  ip: string;
}): string {
  const row = (label: string, value: string | null) =>
    `<tr><td style="padding:6px 12px 6px 0;color:#64748b;font-size:13px;">${label}</td>` +
    `<td style="padding:6px 0;color:#0f172a;font-size:14px;font-weight:500;">${value ?? '—'}</td></tr>`;

  const turnover = lead.annual_turnover_cents === null
    ? null
    : `R${(lead.annual_turnover_cents / 100).toLocaleString('en-ZA', { maximumFractionDigits: 0 })}`;
  const paygHint = lead.annual_turnover_cents !== null && lead.annual_turnover_cents < 100_000_000
    ? ' <span style="color:#0d9488;font-weight:600;">(PAYG eligible)</span>'
    : '';

  return `
    <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
      <h2 style="color:#0f172a;margin:0 0 12px;font-size:20px;">New ISAFlow waitlist signup</h2>
      <p style="color:#475569;margin:0 0 20px;font-size:14px;">Someone just joined the pre-launch waitlist:</p>
      <table style="border-collapse:collapse;width:100%;">
        ${row('Type', lead.signup_type === 'accountant' ? 'Accountant (bureau)' : 'Direct (own business)')}
        ${row('Name', lead.name)}
        ${row('Email', lead.email)}
        ${row(lead.signup_type === 'accountant' ? 'Practice' : 'Company', lead.signup_type === 'accountant' ? lead.practice_name : lead.company_name)}
        ${row('Phone', lead.phone)}
        ${row('Annual turnover', turnover === null ? null : `${turnover}${paygHint}`)}
        ${row('IP', lead.ip)}
      </table>
    </div>
  `;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'unknown', ['POST']);
  }

  // Per-IP throttle — 10 submissions per 10 minutes is plenty for real humans.
  const ip = getClientIp(req);
  const allowed = await checkRateLimit(`waitlist:${ip}`, { max: 10, windowSecs: 600 });
  if (!allowed) {
    return apiResponse.tooManyRequests(res, 'Too many signups from this network. Please try again later.');
  }

  const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;

  const email = clean(body.email, 320)?.toLowerCase() ?? null;
  if (!email || !EMAIL_RE.test(email)) {
    return apiResponse.badRequest(res, 'A valid email address is required.');
  }

  const rawType = clean(body.signupType ?? body.signup_type, 20);
  const signupType: 'direct' | 'accountant' = rawType === 'accountant' ? 'accountant' : 'direct';

  // Declared annual turnover is accepted as whole ZAR (not cents) to keep the
  // form simple. Bureaus don't declare their own turnover here — only the
  // 'direct' path populates it.
  let annualTurnoverCents: number | null = null;
  if (signupType === 'direct') {
    const raw = body.annualTurnover ?? body.annual_turnover ?? body.annualTurnoverCents;
    const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    if (Number.isFinite(parsed) && parsed >= 0 && parsed < 1_000_000_000) {
      // If the caller passed whole-rand (most clients), convert to cents.
      // If they passed cents explicitly (API consumers), respect that.
      const key = body.annualTurnoverCents !== undefined ? 'cents' : 'rand';
      annualTurnoverCents = key === 'cents' ? Math.round(parsed) : Math.round(parsed * 100);
    }
  }

  const lead = {
    name:                  clean(body.name, 200),
    email,
    signup_type:           signupType,
    company_name:          clean(body.companyName ?? body.company ?? body.company_name, 200),
    practice_name:         clean(body.practiceName ?? body.practice_name, 200),
    phone:                 clean(body.phone, 40),
    annual_turnover_cents: annualTurnoverCents,
    ip,
    user_agent:            clean(req.headers['user-agent'], 500),
  };

  // Insert; duplicate emails no-op. We use ON CONFLICT on the unique
  // (lower(email)) index from migration 432.
  const rows = await sql`
    INSERT INTO waitlist_signups
      (name, email, signup_type, company_name, practice_name, phone,
       annual_turnover_cents, ip, user_agent)
    VALUES
      (${lead.name}, ${lead.email}, ${lead.signup_type},
       ${lead.company_name}, ${lead.practice_name},
       ${lead.phone}, ${lead.annual_turnover_cents},
       ${lead.ip}, ${lead.user_agent})
    ON CONFLICT ((lower(email))) DO NOTHING
    RETURNING id
  `;

  const isNew = rows.length > 0;

  log.info('waitlist signup', { email: lead.email, isNew, ip }, 'waitlist');

  // Fire-and-forget notification — don't fail the submission if SMTP is down.
  if (isNew) {
    sendEmail({
      to: NOTIFY_TO,
      subject: `ISAFlow waitlist: ${lead.email}`,
      html: buildNotificationHtml(lead),
      _log: { companyId: null, emailType: 'other' },
    }).catch((err: unknown) => {
      log.error('waitlist notification email failed', {
        error: err instanceof Error ? err.message : String(err),
        email: lead.email,
      }, 'waitlist');
    });
  }

  return apiResponse.success(
    res,
    { received: true },
    "Thanks! We'll be in touch closer to launch.",
  );
}
