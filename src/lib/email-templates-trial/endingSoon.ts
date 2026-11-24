/** Five days before a trial ends: the end date and how to continue (no self-serve upgrade yet). */
import {
  button, company, contactLine, contactLink, formatEndDate, greeting, headerSafe, list, para, trialLayout, upgradeUrl,
  escapeHtml, type RenderedEmail, type TrialEmailPayload,
} from './shared';

export function renderEndingSoon(p: TrialEmailPayload): RenderedEmail {
  const end = formatEndDate(p.trialEndsAt);
  const inner = [
    greeting(p),
    para(`Your IsaFlow trial for ${company(p)} ends on <strong>${escapeHtml(end)}</strong>.`),
    para('To keep using IsaFlow on a paid plan:'),
    list([
      `Email us at ${contactLink()} and tell us which company you want to upgrade.`,
      'We will confirm the plan and move your company onto it.',
    ]),
    button('Contact us', upgradeUrl()),
    contactLine(),
  ].join('');
  return { subject: headerSafe(`Your IsaFlow trial for ${p.companyName} ends on ${end}`), html: trialLayout(inner) };
}
