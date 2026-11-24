/**
 * The trial has ended. Says only what is true today: nothing locks an expired trial, the company keeps
 * signing in and its data stays; features that belong to a paid plan can stop (src/modules/admin/.claude.md).
 */
import {
  button, company, contactLine, formatEndDate, greeting, headerSafe, list, para, trialLayout, upgradeUrl,
  TRIAL_CONTACT_EMAIL, escapeHtml, type RenderedEmail, type TrialEmailPayload,
} from './shared';

export function renderEnded(p: TrialEmailPayload): RenderedEmail {
  const inner = [
    greeting(p),
    para(`Your IsaFlow trial for ${company(p)} ended on <strong>${escapeHtml(formatEndDate(p.trialEndsAt))}</strong>.`),
    para('What happens now:'),
    list([
      'You can still sign in, and the data you captured is kept.',
      'Some features that belong to a paid plan may no longer be available.',
      `To upgrade, email us at ${escapeHtml(TRIAL_CONTACT_EMAIL)} and we will move your company onto a paid plan.`,
    ]),
    button('Contact us to upgrade', upgradeUrl()),
    contactLine(),
  ].join('');
  return { subject: headerSafe(`Your IsaFlow trial for ${p.companyName} has ended`), html: trialLayout(inner) };
}
