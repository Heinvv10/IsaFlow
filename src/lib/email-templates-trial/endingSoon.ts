/** Five days before a trial ends: the end date and how to upgrade (no self-serve upgrade yet). */
import {
  button, company, contactLine, formatEndDate, greeting, headerSafe, list, para, trialLayout, upgradeUrl,
  TRIAL_CONTACT_EMAIL, escapeHtml, type RenderedEmail, type TrialEmailPayload,
} from './shared';

export function renderEndingSoon(p: TrialEmailPayload): RenderedEmail {
  const end = formatEndDate(p.trialEndsAt);
  const inner = [
    greeting(p),
    para(`Your IsaFlow trial for ${company(p)} ends on <strong>${escapeHtml(end)}</strong>.`),
    para('To keep using IsaFlow on a paid plan:'),
    list([
      `Email us at ${escapeHtml(TRIAL_CONTACT_EMAIL)} and tell us which company you want to upgrade.`,
      'We will confirm the plan that suits you and move your company onto it.',
      'Everything you have captured during the trial stays as it is.',
    ]),
    button('Contact us to upgrade', upgradeUrl()),
    contactLine(),
  ].join('');
  return { subject: headerSafe(`Your IsaFlow trial for ${p.companyName} ends on ${end}`), html: trialLayout(inner) };
}
