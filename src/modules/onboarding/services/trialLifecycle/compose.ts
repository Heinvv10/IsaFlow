/**
 * Builds one stage's email for one owner. Day 3 lists only the setup steps the company has not done
 * (setupProgressService, the same facts as the in-app checklist); with nothing left it returns null
 * and the stage is recorded as skipped_setup_complete.
 */
import { probeSetupFacts, buildSetupProgress } from '@/modules/accounting/services/core/setupProgressService';
import { renderSetupNudge, MAX_SETUP_STEPS, type SetupStep } from '@/lib/email-templates-trial/setupNudge';
import { renderCheckIn } from '@/lib/email-templates-trial/checkIn';
import { renderEndingSoon } from '@/lib/email-templates-trial/endingSoon';
import { renderEnded } from '@/lib/email-templates-trial/ended';
import type { RenderedEmail, TrialEmailPayload } from '@/lib/email-templates-trial/shared';
import type { TrialStage } from './stages';

/** The setup steps not done yet, in checklist order, at most MAX_SETUP_STEPS. */
export async function openSetupSteps(companyId: string): Promise<SetupStep[]> {
  const progress = buildSetupProgress(await probeSetupFacts(companyId));
  return progress.modules.flatMap((m) => m.tasks).filter((t) => !t.done)
    .slice(0, MAX_SETUP_STEPS).map((t) => ({ label: t.label, href: t.href }));
}

export function renderStage(stage: TrialStage, p: TrialEmailPayload, setupSteps: readonly SetupStep[]): RenderedEmail {
  switch (stage) {
    case 'setup_nudge': return renderSetupNudge(p, setupSteps);
    case 'check_in': return renderCheckIn(p);
    case 'ending_soon': return renderEndingSoon(p);
    case 'ended': return renderEnded(p);
  }
}
