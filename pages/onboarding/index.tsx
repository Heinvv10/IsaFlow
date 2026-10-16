/**
 * /onboarding — company setup wizard. Step 0 asks what kind of business this
 * is; the Smart Setup pre-step (when the type has a document to read) and
 * every later step follow the answer (src/lib/entityTypes.ts,
 * entityOnboardingRules). Completes with ONE request to
 * /api/onboarding/complete-setup, which writes everything in one transaction.
 * Standalone layout (no AppLayout), matches login dark theme.
 */

import { useState, useCallback, useRef } from 'react';
import {
  Check, Building2, MapPin, Image, Landmark, Briefcase,
  Settings, FileText, ChevronLeft, ChevronRight, Loader2, LayoutGrid,
} from 'lucide-react';
import { apiErrorMessage } from '@/lib/apiFetch';
import type { EntityTypeCode } from '@/lib/entityTypes';
import {
  hasRequiredProofDocument, proofIssues, setupIssues, smartSetupSourceFor,
} from '@/modules/onboarding/services/entityOnboardingRules';
import { MAX_TOTAL_UPLOAD_BYTES, TOTAL_TOO_LARGE } from '@/modules/onboarding/uploadLimits';
import {
  type WizardData, INITIAL_WIZARD,
  Step1, Step2, Step3, Step4, Step5, Step6, Step7, StepCoaTemplate,
} from '@/components/onboarding/WizardSteps';
import { withEntityType } from '@/components/onboarding/wizardTypes';
import { factsOf, uploadBytesOf } from '@/components/onboarding/wizardFacts';
import { EntityTypeStep } from '@/components/onboarding/EntityTypeStep';
import { SmartSetupChoice } from '@/components/onboarding/SmartSetupChoice';
import { WizardProgress } from '@/components/onboarding/WizardProgress';
import { newRequestKey, submitOnboardingSetup } from '@/components/onboarding/submitOnboardingSetup';
import { useOnboardingAuthGate } from '@/components/onboarding/useOnboardingAuthGate';

const STEPS = [
  { icon: Briefcase,   title: 'Business Type',          sub: 'What kind of business is this?' },
  { icon: Building2,   title: 'Business Details',       sub: 'Tell us about your business' },
  { icon: MapPin,      title: 'Address & Contact',      sub: 'Where can we reach you?' },
  { icon: Image,       title: 'Logo Upload',            sub: 'Brand your workspace' },
  { icon: Landmark,    title: 'Banking Details',        sub: 'Your primary bank account' },
  { icon: Settings,    title: 'Financial Preferences',  sub: 'Year-end, VAT & currency' },
  { icon: LayoutGrid,  title: 'Account Structure',      sub: 'Choose your GL account layout' },
  { icon: FileText,    title: 'Statutory Documents',    sub: 'Upload key certificates' },
  { icon: Check,       title: 'Review & Complete',      sub: 'Confirm and get started' },
];

const SMART_SETUP = -1;    // pre-step between the business type and the details
const ENTITY_STEP = 0;
const DETAILS_STEP = 1;
const COA_STEP_INDEX = 6;
const DOCUMENTS_STEP_INDEX = 7; // skipped once the required certificate came in through Smart Setup
const LAST_STEP = STEPS.length - 1;

export default function OnboardingWizard() {
  // ?new=1 means an existing user wants to add a second company.
  // Skip all "already has company → redirect" guards in that case.
  const isAddNew = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('new') === '1';

  const { authChecked, authTimeout, error, setError } = useOnboardingAuthGate(isAddNew);
  const [step, setStep]             = useState(ENTITY_STEP);
  const [d, setD]                   = useState<WizardData>(INITIAL_WIZARD);
  const [submitting, setSubmitting] = useState(false);
  // One key per wizard session, re-sent on every retry: a retry after a lost
  // response gets the company the first request created, never a second one.
  const [requestKey] = useState(newRequestKey);
  const inFlightRef = useRef(false);

  const set = useCallback(<K extends keyof WizardData>(k: K, v: WizardData[K]) => {
    setD(prev => ({ ...prev, [k]: v }));
  }, []);
  const chooseEntity = useCallback((code: EntityTypeCode) => setD(prev => withEntityType(prev, code)), []);

  // Smart Setup: merge extracted fields (and a business type the user confirmed) and go to the details
  const handleExtracted = useCallback((extracted: Partial<WizardData>) => {
    setD(prev => {
      const merged = { ...prev, ...extracted };
      return extracted.entityType ? withEntityType(merged, extracted.entityType) : merged;
    });
    setStep(DETAILS_STEP);
  }, []);

  const entity = d.entityType;
  const hasSmartSetup = entity !== null && smartSetupSourceFor(entity).kind !== 'none';
  // Don't re-ask for a certificate the user already gave Smart Setup.
  const skipDocsStep = entity !== null && hasRequiredProofDocument(entity, d.documents.map(doc => doc.type));
  const canContinue = step === ENTITY_STEP ? entity !== null
                    : step === DETAILS_STEP ? d.name.trim().length > 0
                    : step === DOCUMENTS_STEP_INDEX ? proofIssues(factsOf(d)).length === 0 // the entity's one required proof
                    : true;
  const isLast      = step === LAST_STEP;
  // What the server would refuse (the same rules), shown on the review step instead of a failed submit
  const submitIssues = isLast ? setupIssues(factsOf(d)) : [];
  // Why the documents step's Continue is dimmed, said next to it
  const blockedReason = step === DOCUMENTS_STEP_INDEX && !canContinue ? `${proofIssues(factsOf(d)).join('. ')} to continue.` : '';
  // Address, logo, bank, financial and COA are skippable; the documents step is not
  const skippable   = step > DETAILS_STEP && step <= COA_STEP_INDEX;
  const isPreStep   = step === SMART_SETUP;

  const next = () => {
    if (!canContinue) return;
    if (step === ENTITY_STEP) { setStep(hasSmartSetup ? SMART_SETUP : DETAILS_STEP); return; }
    setStep(s => {
      let target = Math.min(s + 1, LAST_STEP);
      if (target === DOCUMENTS_STEP_INDEX && skipDocsStep) target = Math.min(target + 1, LAST_STEP);
      return target;
    });
  };
  const back = () => {
    if (step === DETAILS_STEP) { setStep(hasSmartSetup ? SMART_SETUP : ENTITY_STEP); return; }
    setStep(s => {
      let target = Math.max(s - 1, ENTITY_STEP);
      if (target === DOCUMENTS_STEP_INDEX && skipDocsStep) target = Math.max(target - 1, ENTITY_STEP);
      return target;
    });
  };

  const handleSubmit = async () => {
    if (inFlightRef.current) return;
    if (uploadBytesOf(d) > MAX_TOTAL_UPLOAD_BYTES) { setError(TOTAL_TOO_LARGE); return; }
    inFlightRef.current = true;
    setSubmitting(true);
    setError('');
    try {
      await submitOnboardingSetup(d, requestKey);
      // Navigate — full reload so the middleware picks up the new cookies (active company, onboarding done)
      window.location.href = '/accounting';
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not finish setting up your company - try again'));
      setSubmitting(false);
      inFlightRef.current = false;
    }
  };

  if (!authChecked) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-gray-950 flex flex-col items-center justify-center gap-4">
        <Loader2 className="w-8 h-8 text-teal-500 animate-spin" />
        {authTimeout && (
          <p className="text-sm text-gray-600 dark:text-gray-400 text-center max-w-sm">
            We could not load onboarding setup.{' '}
            <a href="/accounting" className="text-teal-500 underline hover:text-teal-400">
              Go to Accounting Dashboard
            </a>
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-gray-950 text-slate-900 dark:text-white px-4 py-8">
      {/* Logo */}
      <div className="max-w-2xl mx-auto mb-8">
        <img src="/logo.png" alt="ISAFlow" className="h-10 w-auto brightness-0 dark:invert" />
      </div>

      {/* Progress — hidden on the Smart Setup pre-step */}
      {!isPreStep && (
        <WizardProgress steps={STEPS} step={step} skippedIndex={skipDocsStep ? DOCUMENTS_STEP_INDEX : null} onJump={setStep} />
      )}

      {/* Pre-step: Smart Setup choice */}
      {isPreStep && entity && (
        <SmartSetupChoice
          entityType={entity}
          onManual={() => setStep(DETAILS_STEP)}
          onExtracted={handleExtracted}
          onBack={() => setStep(ENTITY_STEP)}
        />
      )}

      {/* Wizard card */}
      {!isPreStep && (
        <div className="max-w-2xl mx-auto">
          <div className="mb-4">
            <h2 className="text-xl font-semibold">{STEPS[step]?.title}</h2>
            <p className="text-sm text-gray-600 dark:text-gray-400">{STEPS[step]?.sub}</p>
          </div>

          <div className="bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-2xl p-6 shadow-xl min-h-[320px]">
            {step === ENTITY_STEP && <EntityTypeStep value={entity} onChange={chooseEntity} />}
            {step === DETAILS_STEP && <Step1 d={d} set={set} />}
            {step === 2 && <Step2 d={d} set={set} />}
            {step === 3 && <Step3 d={d} set={set} />}
            {step === 4 && <Step4 d={d} set={set} />}
            {step === 5 && <Step5 d={d} set={set} />}
            {step === COA_STEP_INDEX && <StepCoaTemplate d={d} set={set} />}
            {step === DOCUMENTS_STEP_INDEX && <Step6 d={d} set={set} />}
            {step === LAST_STEP && <Step7 d={d} />}
          </div>

          {submitIssues.length > 0 && (
            <ul className="mt-4 px-3 py-2.5 bg-amber-500/10 border border-amber-500/30 rounded-lg text-sm text-amber-400 space-y-0.5">
              {submitIssues.map(issue => <li key={issue}>{issue}</li>)}
            </ul>
          )}

          {/* Error */}
          {error && (
            <div className="mt-4 px-3 py-2.5 bg-red-500/10 border border-red-500/30 rounded-lg">
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          {blockedReason && (
            <p id="continue-blocked" className="mt-4 text-sm text-right text-amber-700 dark:text-amber-400">{blockedReason}</p>
          )}

          {/* Navigation */}
          <div className="flex justify-between mt-6">
            {step === ENTITY_STEP ? <span /> : (
              <button
                onClick={back}
                className="flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
              >
                <ChevronLeft className="w-4 h-4" /> Back
              </button>
            )}
            <div className="flex gap-3">
              {skippable && !isLast && (
                <button onClick={next} className="text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors">
                  Skip
                </button>
              )}
              {isLast ? (
                <button
                  onClick={() => void handleSubmit()}
                  disabled={submitting || submitIssues.length > 0}
                  className="flex items-center gap-2 bg-teal-600 hover:bg-teal-500 disabled:bg-teal-800 text-white font-medium text-sm px-6 py-2.5 rounded-lg transition-colors"
                >
                  {submitting ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving...</> : 'Complete Setup'}
                </button>
              ) : (
                <button
                  onClick={next}
                  disabled={!canContinue}
                  aria-describedby={blockedReason ? 'continue-blocked' : undefined}
                  className="flex items-center gap-1.5 bg-teal-600 hover:bg-teal-500 disabled:bg-teal-800 disabled:cursor-not-allowed text-white font-medium text-sm px-5 py-2.5 rounded-lg transition-colors"
                >
                  Continue <ChevronRight className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
