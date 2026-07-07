import { z } from 'zod';

/**
 * Public contact / "book a demo" form — pure validation + email builder.
 *
 * Kept free of I/O so it can be unit-tested and reused by the API route
 * (`pages/api/contact.ts`). The route adds rate-limiting + email delivery.
 */

export const contactSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100, 'Name is too long'),
  email: z.string().trim().toLowerCase().email('A valid email is required').max(160, 'Email is too long'),
  company: z.string().trim().max(120, 'Company is too long').optional(),
  message: z
    .string()
    .trim()
    .min(10, 'Please add a little more detail (at least 10 characters)')
    .max(2000, 'Message is too long (max 2000 characters)'),
  /** Honeypot — real users leave this empty; bots fill every field. */
  website: z.string().optional(),
});

export type ContactSubmission = Omit<z.infer<typeof contactSchema>, 'website'>;

export type ContactValidation =
  | { ok: true; data: ContactSubmission }
  | { ok: false; error: string };

export function validateContactSubmission(body: unknown): ContactValidation {
  const parsed = contactSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: first?.message ?? 'Invalid submission' };
  }
  const { website, ...data } = parsed.data;
  // Honeypot tripped → silently treat as spam (the route still returns a
  // generic success so bots get no signal).
  if (website && website.trim().length > 0) {
    return { ok: false, error: 'spam' };
  }
  return { ok: true, data };
}

/** Minimal HTML escape for user-supplied text rendered into the notify email. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildContactEmail(data: ContactSubmission): { subject: string; html: string } {
  const company = data.company?.trim() ? escapeHtml(data.company) : '—';
  const subject = `New demo/contact request — ${data.name}`;
  const html = `
    <h2>New contact request from isaflow.co.za</h2>
    <table cellpadding="6" style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
      <tr><td style="color:#64748b;">Name</td><td><strong>${escapeHtml(data.name)}</strong></td></tr>
      <tr><td style="color:#64748b;">Email</td><td>${escapeHtml(data.email)}</td></tr>
      <tr><td style="color:#64748b;">Company</td><td>${company}</td></tr>
    </table>
    <p style="color:#64748b;font-family:sans-serif;font-size:14px;margin-top:16px;">Message</p>
    <p style="font-family:sans-serif;font-size:14px;white-space:pre-wrap;">${escapeHtml(data.message)}</p>
    <p style="color:#94a3b8;font-family:sans-serif;font-size:12px;margin-top:24px;">Reply directly to ${escapeHtml(data.email)} to respond.</p>
  `;
  return { subject, html };
}
