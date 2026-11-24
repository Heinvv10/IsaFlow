/** Day 3 of a trial: the setup steps the company has not done yet (from setupProgressService). */
import { appLink, company, contactLine, greeting, headerSafe, list, para, trialLayout, type RenderedEmail, type TrialEmailPayload } from './shared';

export interface SetupStep {
  label: string;
  /** In-app path, e.g. /accounting/customers/new. */
  href: string;
}

/** At most this many steps are listed, so the email stays short. */
export const MAX_SETUP_STEPS = 3;

export function renderSetupNudge(p: TrialEmailPayload, steps: readonly SetupStep[]): RenderedEmail {
  const shown = steps.slice(0, MAX_SETUP_STEPS);
  const inner = [
    greeting(p),
    para(`Thanks for trying IsaFlow with ${company(p)}. A few quick steps will get your books working for you:`),
    list(shown.map((s) => appLink(p, s.href, s.label))),
    para(`Your setup checklist on the ${appLink(p, '/accounting', 'IsaFlow dashboard')} shows what is left.`),
    contactLine(),
  ].join('');
  return { subject: headerSafe(`Get ${p.companyName} set up in IsaFlow`), html: trialLayout(inner) };
}

