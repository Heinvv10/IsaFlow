/**
 * /onboarding — 7-step company setup wizard with Smart Setup pre-step.
 * Standalone layout (no AppLayout), matches login dark theme.
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import {
  Check, Building2, MapPin, Image, Landmark,
  Settings, FileText, ChevronLeft, ChevronRight, Loader2, LayoutGrid,
} from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import {
  type WizardData, INITIAL_WIZARD,
  Step1, Step2, Step3, Step4, Step5, Step6, Step7, StepCoaTemplate,
} from '@/components/onboarding/WizardSteps';
import { SmartSetupChoice } from '@/components/onboarding/SmartSetupChoice';

const STEPS = [
  { icon: Building2,   title: 'Company Details',       sub: 'Tell us about your business' },
  { icon: MapPin,      title: 'Address & Contact',      sub: 'Where can we reach you?' },
  { icon: Image,       title: 'Logo Upload',            sub: 'Brand your workspace' },
  { icon: Landmark,    title: 'Banking Details',        sub: 'Your primary bank account' },
  { icon: Settings,    title: 'Financial Preferences',  sub: 'Year-end, VAT & currency' },
  { icon: LayoutGrid,  title: 'Account Structure',      sub: 'Choose your GL account layout' },
  { icon: FileText,    title: 'Statutory Documents',    sub: 'Upload key certificates' },
  { icon: Check,       title: 'Review & Complete',      sub: 'Confirm and get started' },
];

const DOCUMENTS_STEP_INDEX = 6; // Statutory Documents step — skipped if CIPC uploaded via Smart Setup
const COA_STEP_INDEX = 5;       // Chart of Accounts template step

export default function OnboardingWizard() {
  const router = useRouter();

  // ?new=1 means an existing user wants to add a second company.
  // Skip all "already has company → redirect" guards in that case.
  const isAddNew = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('new') === '1';

  // step === -1 is the Smart Setup pre-step (choice screen)
  const [step, setStep]             = useState(-1);
  const [d, setD]                   = useState<WizardData>(INITIAL_WIZARD);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]           = useState('');
  const [authChecked, setAuthChecked] = useState(false);

  // Auth check — fires once on mount only.
  // router is intentionally excluded from deps: it is only used for navigation
  // (router.replace), not for reading state. Including it caused repeated fires
  // each time Next.js updated the router reference during navigation, creating
  // an accounting → onboarding → accounting redirect loop.
  useEffect(() => {
    apiFetch('/api/auth/me').then(async (r) => {
      if (!r.ok) { void router.replace('/login'); return; }
      const body = await r.json();

      // When adding a new company, skip both guards and go straight to the wizard.
      if (isAddNew) { setAuthChecked(true); return; }

      if (body.data?.onboardingCompleted) { void router.replace('/accounting'); return; }

      // Invited users (and users coming back after completing the wizard)
      // already have a company — skip onboarding and go straight to dashboard.
      //
      // The API shape is { data: { items: [...] } }; the previous version
      // read compBody.data directly and then asked it for .length, which was
      // always undefined, so this branch never fired.
      try {
        const compRes = await apiFetch('/api/accounting/companies?action=user-companies');
        if (compRes.ok) {
          const compBody = (await compRes.json()) as { data?: { items?: unknown[] } };
          const companies = compBody.data?.items ?? [];
          if (Array.isArray(companies) && companies.length > 0) {
            await apiFetch('/api/onboarding/complete', { method: 'POST' });
            void router.replace('/accounting');
            return;
          }
        }
      } catch {
        // Non-fatal — fall through to show the wizard
      }

      setAuthChecked(true);
    }).catch(() => void router.replace('/login'));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = useCallback(<K extends keyof WizardData>(k: K, v: WizardData[K]) => {
    setD(prev => ({ ...prev, [k]: v }));
  }, []);

  // Smart Setup: merge extracted fields and jump to step 0
  const handleExtracted = useCallback((extracted: Partial<WizardData>) => {
    setD(prev => ({ ...prev, ...extracted }));
    setStep(0);
  }, []);

  const hasCipc     = d.documents.some(doc => doc.type === 'cipc_certificate');
  // If the user uploaded the CIPC in the Smart Setup pre-step the Statutory
  // Documents step (index 6) is already satisfied and is auto-skipped — don't
  // re-ask users for docs they've already given us.
  const skipDocsStep = hasCipc;
  const canContinue = step === 0 ? d.name.trim().length > 0
                    : step === DOCUMENTS_STEP_INDEX ? hasCipc   // CIPC is required on documents step
                    : true;
  const isLast      = step === STEPS.length - 1;
  // Steps 1-5 skippable (address, logo, bank, financial, COA); docs (6) not skippable
  const skippable   = step >= 1 && step <= COA_STEP_INDEX;
  const isPreStep   = step === -1;

  const next = () => {
    if (!canContinue) return;
    setStep(s => {
      let target = Math.min(s + 1, STEPS.length - 1);
      if (target === DOCUMENTS_STEP_INDEX && skipDocsStep) target = Math.min(target + 1, STEPS.length - 1);
      return target;
    });
  };
  const back = () => {
    setStep(s => {
      let target = Math.max(s - 1, 0);
      if (target === DOCUMENTS_STEP_INDEX && skipDocsStep) target = Math.max(target - 1, 0);
      return target;
    });
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setError('');
    try {
      // 1. Create company
      const compRes = await apiFetch('/api/accounting/companies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: d.name, tradingName: d.tradingName,
          registrationNumber: d.registrationNumber, vatNumber: d.vatNumber,
          taxNumber: d.taxNumber, addressLine1: d.addressLine1,
          addressLine2: d.addressLine2, city: d.city, province: d.province,
          postalCode: d.postalCode, country: d.country, phone: d.phone,
          email: d.email, website: d.website, logoData: d.logoData || undefined,
          bankName: d.bankName || undefined,
          bankAccountNumber: d.bankAccountNumber || undefined,
          bankBranchCode: d.bankBranchCode || undefined,
          bankAccountType: d.bankAccountType,
          financialYearStart: d.financialYearStart,
          vatPeriod: d.vatPeriod, defaultCurrency: d.defaultCurrency,
        }),
      });
      if (!compRes.ok) {
        const body = await compRes.json();
        throw new Error(body.error?.message || 'Failed to create company');
      }
      const compData = await compRes.json();
      const companyId = compData.data?.id;

      // 2. Seed Chart of Accounts from chosen template (non-blocking but important)
      if (companyId) {
        try {
          await apiFetch('/api/accounting/coa-seed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Company-Id': companyId },
            body: JSON.stringify({ template: d.coaTemplate }),
          });
        } catch { /* non-critical — user can add accounts manually */ }
      }

      // 3. Save directors (non-blocking)
      if (d.directors.length > 0 && companyId) {
        try {
          await apiFetch('/api/accounting/company-directors', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Company-Id': companyId },
            body: JSON.stringify({ directors: d.directors }),
          });
        } catch { /* non-critical */ }
      }

      // 4. Upload documents (non-blocking — company is already created)
      if (d.documents.length > 0 && companyId) {
        try {
          await apiFetch('/api/onboarding/documents', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ companyId, documents: d.documents }),
          });
        } catch { /* non-critical */ }
      }

      // 5. Mark onboarding complete
      await apiFetch('/api/onboarding/complete', { method: 'POST' });

      // Navigate — full reload so the middleware picks up the new ff_onboarding_done cookie
      window.location.href = '/accounting';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setSubmitting(false);
    }
  };

  if (!authChecked) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-gray-950 flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-teal-500 animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-gray-950 text-slate-900 dark:text-white px-4 py-8">
      {/* Logo */}
      <div className="max-w-2xl mx-auto mb-8">
        <img src="/logo.png" alt="ISAFlow" className="h-10 w-auto brightness-0 invert" />
      </div>

      {/* Progress — only shown during the 7-step wizard (step 0-6) */}
      {!isPreStep && (
        <div className="max-w-2xl mx-auto mb-8">
          <div className="flex items-center justify-between">
            {STEPS.map((s, i) => {
              const isDocsAutoSkipped = i === DOCUMENTS_STEP_INDEX && skipDocsStep;
              const isPast = i < step || (isDocsAutoSkipped && step > DOCUMENTS_STEP_INDEX);
              const isCurrent = i === step;
              return (
                <div key={i} className="flex items-center flex-1 last:flex-none">
                  <button
                    onClick={() => { if (isPast && !isDocsAutoSkipped) setStep(i); }}
                    disabled={i > step || isDocsAutoSkipped}
                    title={isDocsAutoSkipped ? 'Already captured from Smart Setup' : s.title}
                    className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-medium shrink-0 transition-colors ${ isDocsAutoSkipped ? 'bg-teal-600/40 text-white/70 cursor-default' : isPast ? 'bg-teal-600 text-white cursor-pointer' : isCurrent ? 'bg-teal-500 text-white ring-2 ring-teal-400' : 'bg-gray-800 text-gray-500' }`}
                  >
                    {isDocsAutoSkipped || isPast ? <Check className="w-4 h-4" /> : i + 1}
                  </button>
                  {i < STEPS.length - 1 && (
                    <div className={`h-0.5 flex-1 mx-1 ${(isPast || isDocsAutoSkipped) ? 'bg-teal-600' : 'bg-gray-800'}`} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Pre-step: Smart Setup choice */}
      {isPreStep && (
        <SmartSetupChoice
          onManual={() => setStep(0)}
          onExtracted={handleExtracted}
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
            {step === 0 && <Step1 d={d} set={set} />}
            {step === 1 && <Step2 d={d} set={set} />}
            {step === 2 && <Step3 d={d} set={set} />}
            {step === 3 && <Step4 d={d} set={set} />}
            {step === 4 && <Step5 d={d} set={set} />}
            {step === COA_STEP_INDEX && <StepCoaTemplate d={d} set={set} />}
            {step === 6 && <Step6 d={d} set={set} />}
            {step === 7 && <Step7 d={d} />}
          </div>

          {/* Error */}
          {error && (
            <div className="mt-4 px-3 py-2.5 bg-red-500/10 border border-red-500/30 rounded-lg">
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          {/* Navigation */}
          <div className="flex justify-between mt-6">
            <button
              onClick={step === 0 ? () => setStep(-1) : back}
              className="flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-white transition-colors"
            >
              <ChevronLeft className="w-4 h-4" /> Back
            </button>
            <div className="flex gap-3">
              {skippable && !isLast && (
                <button onClick={next} className="text-sm text-gray-600 dark:text-gray-400 hover:text-white transition-colors">
                  Skip
                </button>
              )}
              {isLast ? (
                <button
                  onClick={() => void handleSubmit()}
                  disabled={submitting}
                  className="flex items-center gap-2 bg-teal-600 hover:bg-teal-500 disabled:bg-teal-800 text-white font-medium text-sm px-6 py-2.5 rounded-lg transition-colors"
                >
                  {submitting ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving...</> : 'Complete Setup'}
                </button>
              ) : (
                <button
                  onClick={next}
                  disabled={!canContinue}
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
