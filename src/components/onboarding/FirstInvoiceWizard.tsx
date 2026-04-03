/**
 * FirstInvoiceWizard — 3-step modal for first-time invoice setup.
 * Steps: Company Branding → Payment Details → Invoice Numbering
 * Dismissed via user_preferences key: first_invoice_wizard_dismissed
 */

import { useRef, useState } from 'react';
import { Upload, X } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useFirstUseWizard } from '@/hooks/useFirstUseWizard';

interface WizardState {
  companyName: string; logoData: string;
  bankName: string; accountNumber: string; branchCode: string; paymentTerms: string;
  invoicePrefix: string; nextNumber: string;
}

const INITIAL: WizardState = {
  companyName: '', logoData: '', bankName: '', accountNumber: '', branchCode: '',
  paymentTerms: 'Payment due within 30 days.', invoicePrefix: 'INV-', nextNumber: '0001',
};

type SetState = React.Dispatch<React.SetStateAction<WizardState>>;

function StepDots({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center justify-center gap-2 mb-6">
      {Array.from({ length: total }).map((_, i) => (
        <div key={i} className={`rounded-full transition-all duration-200 ${i === current ? 'w-6 h-2 bg-teal-500' : i < current ? 'w-2 h-2 bg-teal-700' : 'w-2 h-2 bg-gray-600'}`} />
      ))}
    </div>
  );
}

function InvoiceHeaderPreview({ state }: { state: WizardState }) {
  const num = `${state.invoicePrefix || 'INV-'}${state.nextNumber || '0001'}`;
  return (
    <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-4 text-xs select-none">
      <div className="flex justify-between items-start">
        <div>
          {state.logoData
            ? <img src={state.logoData} alt="Logo" className="w-12 h-12 object-contain rounded mb-1" />
            : <div className="w-12 h-12 bg-gray-200 dark:bg-gray-700 rounded flex items-center justify-center text-gray-400 text-[10px] mb-1">Logo</div>}
          <p className="font-semibold text-gray-800 dark:text-gray-100">{state.companyName || 'Your Company Name'}</p>
        </div>
        <div className="text-right">
          <p className="text-base font-bold text-teal-600 dark:text-teal-400">INVOICE</p>
          <p className="text-gray-500 dark:text-gray-400">{num}</p>
          <p className="text-gray-400 dark:text-gray-500">{new Date().toLocaleDateString('en-ZA')}</p>
        </div>
      </div>
    </div>
  );
}

function Step1({ state, setState }: { state: WizardState; setState: SetState }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const handleFile = (file: File) => {
    if (!file.type.startsWith('image/') || file.size > 2 * 1024 * 1024) return;
    const reader = new FileReader();
    reader.onload = () => setState(s => ({ ...s, logoData: reader.result as string }));
    reader.readAsDataURL(file);
  };
  return (
    <div className="space-y-4">
      <Input label="Company Name" value={state.companyName} onChange={e => setState(s => ({ ...s, companyName: e.target.value }))} placeholder="Acme (Pty) Ltd" />
      <div>
        <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Company Logo</p>
        {state.logoData ? (
          <div className="relative inline-block">
            <img src={state.logoData} alt="Logo" className="w-20 h-20 object-contain rounded-lg border border-gray-300 dark:border-gray-600" />
            <button type="button" onClick={() => setState(s => ({ ...s, logoData: '' }))} className="absolute -top-2 -right-2 bg-red-600 rounded-full p-0.5 hover:bg-red-500">
              <X className="w-3 h-3 text-white" />
            </button>
          </div>
        ) : (
          <div onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
            onClick={() => fileRef.current?.click()} className="border-2 border-dashed border-gray-400 dark:border-gray-600 rounded-lg p-6 text-center cursor-pointer hover:border-teal-500 transition-colors">
            <Upload className="w-8 h-8 text-gray-400 mx-auto mb-2" />
            <p className="text-sm text-gray-500 dark:text-gray-400">Drop logo here or click to browse</p>
            <p className="text-xs text-gray-400 mt-1">PNG, JPG, WebP — max 2 MB</p>
          </div>
        )}
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
      </div>
      <div>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-2 uppercase tracking-wide font-medium">Preview</p>
        <InvoiceHeaderPreview state={state} />
      </div>
    </div>
  );
}

function Step2({ state, setState }: { state: WizardState; setState: SetState }) {
  return (
    <div className="space-y-4">
      <Input label="Bank Name" value={state.bankName} onChange={e => setState(s => ({ ...s, bankName: e.target.value }))} placeholder="e.g. First National Bank" />
      <div className="grid grid-cols-2 gap-3">
        <Input label="Account Number" value={state.accountNumber} onChange={e => setState(s => ({ ...s, accountNumber: e.target.value }))} placeholder="62xxxxxxxx" />
        <Input label="Branch Code" value={state.branchCode} onChange={e => setState(s => ({ ...s, branchCode: e.target.value }))} placeholder="250655" />
      </div>
      <div>
        <label className="text-sm font-medium text-gray-700 dark:text-gray-300 block mb-1.5">Payment Terms</label>
        <textarea value={state.paymentTerms} onChange={e => setState(s => ({ ...s, paymentTerms: e.target.value }))} rows={3}
          className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 placeholder-gray-400 transition-colors" />
      </div>
    </div>
  );
}

function Step3({ state, setState }: { state: WizardState; setState: SetState }) {
  const preview = `${state.invoicePrefix || 'INV-'}${state.nextNumber || '0001'}`;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Input label="Prefix" value={state.invoicePrefix} onChange={e => setState(s => ({ ...s, invoicePrefix: e.target.value }))} placeholder="INV-" />
        <Input label="Next Number" value={state.nextNumber} onChange={e => setState(s => ({ ...s, nextNumber: e.target.value }))} placeholder="0001" />
      </div>
      <div className="bg-gray-100 dark:bg-gray-700/50 rounded-lg p-4 text-center">
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Your next invoice number will be</p>
        <p className="text-2xl font-bold text-teal-600 dark:text-teal-400 tracking-wide">{preview}</p>
      </div>
      <p className="text-xs text-gray-400 dark:text-gray-500">The number increments automatically with each new invoice.</p>
    </div>
  );
}

const STEP_TITLES = ['Branding', 'Payment Details', 'Numbering'];

export function FirstInvoiceWizard() {
  const { shouldShow, dismiss, loading } = useFirstUseWizard('first_invoice_wizard');
  const [step, setStep] = useState(0);
  const [state, setState] = useState<WizardState>(INITIAL);

  if (loading || !shouldShow) return null;

  const isLast = step === STEP_TITLES.length - 1;

  return (
    <Modal open title={`Set Up Your Invoices — ${STEP_TITLES[step]}`} onClose={dismiss} size="md" disableBackdropClose>
      <Modal.Body>
        <StepDots current={step} total={STEP_TITLES.length} />
        {step === 0 && <Step1 state={state} setState={setState} />}
        {step === 1 && <Step2 state={state} setState={setState} />}
        {step === 2 && <Step3 state={state} setState={setState} />}
      </Modal.Body>
      <Modal.Footer className="justify-between">
        <button type="button" onClick={dismiss} className="text-sm text-gray-400 hover:text-gray-300 transition-colors">
          Skip for now
        </button>
        <div className="flex gap-2">
          {step > 0 && <Button variant="secondary" size="sm" onClick={() => setStep(s => s - 1)}>Back</Button>}
          <Button size="sm" onClick={() => { if (isLast) dismiss(); else setStep(s => s + 1); }}>
            {isLast ? 'Finish' : 'Next'}
          </Button>
        </div>
      </Modal.Footer>
    </Modal>
  );
}
