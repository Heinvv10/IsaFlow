/**
 * The trial has ended. Makes no promise about access or data after the trial; it only says how to
 * keep using IsaFlow. Replies go to the contact address (replyTo in runTrialLifecycleEmails.ts).
 */
import {
  button, company, contactLine, contactLink, formatEndDate, greeting, headerSafe, list, para, trialLayout, upgradeUrl,
  escapeHtml, type RenderedEmail, type TrialEmailPayload,
} from './shared';

export function renderEnded(p: TrialEmailPayload): RenderedEmail {
  const inner = [
    greeting(p),
    para(`Your IsaFlow trial for ${company(p)} ended on <strong>${escapeHtml(formatEndDate(p.trialEndsAt))}</strong>.`),
    para('To keep using IsaFlow:'),
    list([
      `Reply to this email, or email us at ${contactLink()}.`,
      'We will move your company onto a paid plan.',
    ]),
    button('Contact us', upgradeUrl()),
    contactLine(),
  ].join('');
  return { subject: headerSafe(`Your IsaFlow trial for ${p.companyName} has ended`), html: trialLayout(inner) };
}
