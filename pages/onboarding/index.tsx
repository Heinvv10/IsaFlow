/**
 * /onboarding — 7-step company setup wizard.
 * Standalone layout (no AppLayout), matches login dark theme.
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import {
  Check, Building2, MapPin, Image, Landmark,
  Settings, FileText, ChevronLeft, ChevronRight, Loader2,
} from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import {
  type WizardData, INITIAL_WIZARD, MONTHS, DOC_SLOTS,
  Step1, Step2, Step3, Step4, Step5, Step6, Step7,
} from '@/components/onboarding/WizardSteps';

const STEPS = [
  { icon: Building2, title: 'Company Details', sub: 'Tell us about your business' },
  { icon: MapPin, title: 'Address & Contact', sub: 'Where can we reach you?' },
  { icon: Image, title: 'Logo Upload', sub: 'Brand your workspace' },
  { icon: Landmark, title: 'Banking Details', sub: 'Your primary bank account' },
  { icon: Settings, title: 'Financial Preferences', sub: 'Year-end, VAT & currency' },
  { icon: FileText, title: 'Statutory Documents', sub: 'Upload key certificates' },
  { icon: Check, title: 'Review & Complete', sub: 'Confirm and get started' },
];

export default function OnboardingWizard() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [d, setD] = useState<WizardData>(INITIAL_WIZARD);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [authChecked, setAuthChecked] = useState(false);

  // Auth check
  useEffect(() => {
    apiFetch('/api/auth/me').then(async (r) => {
      if (!r.ok) { void router.replace('/login'); return; }
      const body = await r.json();
      if (body.data?.onboardingCompleted) { void router.replace('/accounting'); return; }
      setAuthChecked(true);
    }).catch(() => void router.replace('/login'));
  }, [router]);

  const set = useCallback(<K extends keyof WizardData>(k: K, v: WizardData[K]) => {
    setD(prev => ({ ...prev, [k]: v }));
  }, []);

  const canContinue = step === 0 ? d.name.trim().length > 0 : true;
  const isLast = step === STEPS.length - 1;
  const skippable = step >= 1 && step <= 5;

  const next = () => { if (canContinue) setStep(s => Math.min(s + 1, STEPS.length - 1)); };
  const back = () => setStep(s => Math.max(s - 1, 0));

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

      // 2. Upload documents
      if (d.documents.length > 0 && companyId) {
        const docRes = await apiFetch('/api/onboarding/documents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ companyId, documents: d.documents }),
        });
        if (!docRes.ok) throw new Error('Failed to upload documents');
      }

      // 3. Mark onboarding complete
      await apiFetch('/api/onboarding/complete', { method: 'POST' });

      // 4. Navigate
      void router.push('/accounting');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setSubmitting(false);
    }
  };

  if (!authChecked) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-teal-500 animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white px-4 py-8">
      {/* Logo */}
      <div className="max-w-2xl mx-auto mb-8">
        <img src="/logo.png" alt="ISAFlow" className="h-10 w-auto brightness-0 invert" />
      </div>

      {/* Progress */}
      <div className="max-w-2xl mx-auto mb-8">
        <div className="flex items-center justify-between">
          {STEPS.map((s, i) => (
            <div key={i} className="flex items-center flex-1 last:flex-none">
              <button
                onClick={() => i < step && setStep(i)}
                disabled={i > step}
                className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-medium shrink-0 transition-colors ${
                  i < step ? 'bg-teal-600 text-white cursor-pointer' :
                  i === step ? 'bg-teal-500 text-white ring-2 ring-teal-400' :
                  'bg-gray-800 text-gray-500'
                }`}
              >
                {i < step ? <Check className="w-4 h-4" /> : i + 1}
              </button>
              {i < STEPS.length - 1 && (
                <div className={`h-0.5 flex-1 mx-1 ${i < step ? 'bg-teal-600' : 'bg-gray-800'}`} />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Card */}
      <div className="max-w-2xl mx-auto">
        <div className="mb-4">
          <h2 className="text-xl font-semibold">{STEPS[step]?.title}</h2>
          <p className="text-sm text-gray-400">{STEPS[step]?.sub}</p>
        </div>

        <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 shadow-xl min-h-[320px]">
          {step === 0 && <Step1 d={d} set={set} />}
          {step === 1 && <Step2 d={d} set={set} />}
          {step === 2 && <Step3 d={d} set={set} />}
          {step === 3 && <Step4 d={d} set={set} />}
          {step === 4 && <Step5 d={d} set={set} />}
          {step === 5 && <Step6 d={d} set={set} />}
          {step === 6 && <Step7 d={d} />}
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
            onClick={back}
            disabled={step === 0}
            className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronLeft className="w-4 h-4" /> Back
          </button>
          <div className="flex gap-3">
            {skippable && !isLast && (
              <button onClick={next} className="text-sm text-gray-400 hover:text-white transition-colors">
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
    </div>
  );
}
