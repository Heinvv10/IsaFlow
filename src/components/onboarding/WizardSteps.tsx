/**
 * Onboarding wizard step components (Steps 1-7).
 */

import { useRef } from 'react';
import { Upload, X } from 'lucide-react';

// ── Types ───────────────────────────────────────────────────────────────────

export interface DocFile {
  type: string; name: string; data: string; mimeType: string; size: number;
}

export interface WizardData {
  name: string; tradingName: string; registrationNumber: string;
  vatNumber: string; taxNumber: string;
  addressLine1: string; addressLine2: string; city: string;
  province: string; postalCode: string; country: string;
  phone: string; email: string; website: string;
  logoData: string;
  bankName: string; bankAccountNumber: string;
  bankBranchCode: string; bankAccountType: string;
  financialYearStart: number; vatPeriod: string; defaultCurrency: string;
  documents: DocFile[];
}

export const INITIAL_WIZARD: WizardData = {
  name: '', tradingName: '', registrationNumber: '', vatNumber: '', taxNumber: '',
  addressLine1: '', addressLine2: '', city: '', province: '', postalCode: '',
  country: 'South Africa', phone: '', email: '', website: '', logoData: '',
  bankName: '', bankAccountNumber: '', bankBranchCode: '', bankAccountType: 'Current',
  financialYearStart: 3, vatPeriod: 'Bi-Monthly', defaultCurrency: 'ZAR',
  documents: [],
};

export type SetFn = <K extends keyof WizardData>(k: K, v: WizardData[K]) => void;

// ── Constants ───────────────────────────────────────────────────────────────

const PROVINCES = [
  'Eastern Cape', 'Free State', 'Gauteng', 'KwaZulu-Natal', 'Limpopo',
  'Mpumalanga', 'North West', 'Northern Cape', 'Western Cape',
];
const SA_BANKS = [
  'ABSA', 'Capitec', 'FNB', 'Investec', 'Nedbank', 'Standard Bank',
  'TymeBank', 'African Bank', 'Discovery Bank', 'Bank Zero',
];
export const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];
export const DOC_SLOTS = [
  { type: 'cipc', label: 'CIPC Registration Certificate' },
  { type: 'tax_clearance', label: 'SARS Tax Clearance Certificate' },
  { type: 'bbbee', label: 'B-BBEE Certificate' },
  { type: 'vat_reg', label: 'VAT Registration Certificate' },
];

// ── Shared UI ───────────────────────────────────────────────────────────────

const inputCls = 'w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent transition';
const labelCls = 'block text-xs font-medium text-gray-400 mb-1.5';

function Field({ label, value, onChange, placeholder, required, type = 'text' }: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; required?: boolean; type?: string;
}) {
  return (
    <div>
      <label className={labelCls}>{label}{required && <span className="text-red-400 ml-0.5">*</span>}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder} className={inputCls} />
    </div>
  );
}

function Select({ label, value, onChange, children }: {
  label: string; value: string | number; onChange: (v: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)} className={inputCls}>
        {children}
      </select>
    </div>
  );
}

// ── Step 1: Company Details ─────────────────────────────────────────────────

export function Step1({ d, set }: { d: WizardData; set: SetFn }) {
  return (
    <div className="grid gap-4">
      <Field label="Company Name" value={d.name} onChange={v => set('name', v)} placeholder="Acme (Pty) Ltd" required />
      <Field label="Trading Name" value={d.tradingName} onChange={v => set('tradingName', v)} placeholder="Acme" />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Field label="Registration Number (CIPC)" value={d.registrationNumber} onChange={v => set('registrationNumber', v)} />
        <Field label="VAT Number" value={d.vatNumber} onChange={v => set('vatNumber', v)} />
        <Field label="Income Tax Number" value={d.taxNumber} onChange={v => set('taxNumber', v)} />
      </div>
    </div>
  );
}

// ── Step 2: Address & Contact ───────────────────────────────────────────────

export function Step2({ d, set }: { d: WizardData; set: SetFn }) {
  return (
    <div className="grid gap-4">
      <Field label="Address Line 1" value={d.addressLine1} onChange={v => set('addressLine1', v)} />
      <Field label="Address Line 2" value={d.addressLine2} onChange={v => set('addressLine2', v)} />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Field label="City" value={d.city} onChange={v => set('city', v)} />
        <Select label="Province" value={d.province} onChange={v => set('province', v)}>
          <option value="">Select...</option>
          {PROVINCES.map(p => <option key={p} value={p}>{p}</option>)}
        </Select>
        <Field label="Postal Code" value={d.postalCode} onChange={v => set('postalCode', v)} />
      </div>
      <Field label="Country" value={d.country} onChange={v => set('country', v)} />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Field label="Phone" value={d.phone} onChange={v => set('phone', v)} type="tel" />
        <Field label="Email" value={d.email} onChange={v => set('email', v)} type="email" />
        <Field label="Website" value={d.website} onChange={v => set('website', v)} />
      </div>
    </div>
  );
}

// ── Step 3: Logo Upload ─────────────────────────────────────────────────────

export function Step3({ d, set }: { d: WizardData; set: SetFn }) {
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = (file: File) => {
    if (!file.type.match(/^image\/(jpeg|png|webp)$/)) return;
    if (file.size > 2 * 1024 * 1024) return;
    const reader = new FileReader();
    reader.onload = () => set('logoData', reader.result as string);
    reader.readAsDataURL(file);
  };

  return (
    <div className="flex flex-col items-center gap-4">
      {d.logoData ? (
        <div className="relative">
          <img src={d.logoData} alt="Logo" className="w-32 h-32 rounded-lg object-contain bg-gray-800" />
          <button onClick={() => set('logoData', '')}
            className="absolute -top-2 -right-2 bg-red-600 rounded-full p-1 hover:bg-red-500">
            <X className="w-3 h-3" />
          </button>
        </div>
      ) : (
        <div
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
          className="w-full border-2 border-dashed border-gray-600 rounded-xl p-10 text-center hover:border-teal-500 transition-colors cursor-pointer"
          onClick={() => fileRef.current?.click()}
        >
          <Upload className="w-10 h-10 text-gray-500 mx-auto mb-3" />
          <p className="text-sm text-gray-400">Drag & drop your logo here, or click to browse</p>
          <p className="text-xs text-gray-500 mt-1">JPEG, PNG, or WebP. Max 2 MB</p>
        </div>
      )}
      <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
      {!d.logoData && (
        <button onClick={() => fileRef.current?.click()}
          className="text-sm text-teal-400 hover:text-teal-300 transition-colors">
          Browse files
        </button>
      )}
    </div>
  );
}

// ── Step 4: Banking Details ─────────────────────────────────────────────────

export function Step4({ d, set }: { d: WizardData; set: SetFn }) {
  return (
    <div className="grid gap-4">
      <div>
        <label className={labelCls}>Bank Name</label>
        <input list="sa-banks" value={d.bankName} onChange={e => set('bankName', e.target.value)}
          className={inputCls} placeholder="Select or type..." />
        <datalist id="sa-banks">
          {SA_BANKS.map(b => <option key={b} value={b} />)}
        </datalist>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Account Number" value={d.bankAccountNumber} onChange={v => set('bankAccountNumber', v)} />
        <Field label="Branch Code" value={d.bankBranchCode} onChange={v => set('bankBranchCode', v)} />
      </div>
      <Select label="Account Type" value={d.bankAccountType} onChange={v => set('bankAccountType', v)}>
        {['Current', 'Savings', 'Transmission', 'Credit Card'].map(t =>
          <option key={t} value={t}>{t}</option>
        )}
      </Select>
    </div>
  );
}

// ── Step 5: Financial Preferences ───────────────────────────────────────────

export function Step5({ d, set }: { d: WizardData; set: SetFn }) {
  return (
    <div className="grid gap-4">
      <Select label="Financial Year Start" value={d.financialYearStart}
        onChange={v => set('financialYearStart', parseInt(v, 10))}>
        {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
      </Select>
      <Select label="VAT Period" value={d.vatPeriod} onChange={v => set('vatPeriod', v)}>
        <option value="Monthly">Monthly</option>
        <option value="Bi-Monthly">Bi-Monthly</option>
      </Select>
      <Select label="Default Currency" value={d.defaultCurrency} onChange={v => set('defaultCurrency', v)}>
        {['ZAR', 'USD', 'EUR', 'GBP'].map(c => <option key={c} value={c}>{c}</option>)}
      </Select>
    </div>
  );
}

// ── Step 6: Statutory Documents ─────────────────────────────────────────────

export function Step6({ d, set }: { d: WizardData; set: SetFn }) {
  const handleDocFile = (slot: typeof DOC_SLOTS[number], file: File) => {
    if (file.size > 10 * 1024 * 1024) return;
    const reader = new FileReader();
    reader.onload = () => {
      const newDoc: DocFile = {
        type: slot.type, name: file.name,
        data: reader.result as string, mimeType: file.type, size: file.size,
      };
      set('documents', [...d.documents.filter(dd => dd.type !== slot.type), newDoc]);
    };
    reader.readAsDataURL(file);
  };

  const removeDoc = (type: string) => set('documents', d.documents.filter(dd => dd.type !== type));

  return (
    <div className="grid gap-4">
      {DOC_SLOTS.map(slot => {
        const doc = d.documents.find(dd => dd.type === slot.type);
        return (
          <div key={slot.type} className="border border-gray-700 rounded-lg p-4">
            <p className="text-sm font-medium text-gray-300 mb-2">{slot.label}</p>
            {doc ? (
              <div className="flex items-center justify-between">
                <div className="text-xs text-gray-400">
                  {doc.name} ({(doc.size / 1024).toFixed(0)} KB)
                </div>
                <button onClick={() => removeDoc(slot.type)}
                  className="text-xs text-red-400 hover:text-red-300">Remove</button>
              </div>
            ) : (
              <label className="flex items-center gap-2 cursor-pointer text-xs text-teal-400 hover:text-teal-300">
                <Upload className="w-3.5 h-3.5" /> Upload
                <input type="file" className="hidden" accept="image/*,application/pdf"
                  onChange={e => { const f = e.target.files?.[0]; if (f) handleDocFile(slot, f); }} />
              </label>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Step 7: Review & Complete ───────────────────────────────────────────────

export function Step7({ d }: { d: WizardData }) {
  const section = (title: string, items: [string, string | undefined][]) => {
    const filtered = items.filter(([, v]) => v);
    if (filtered.length === 0) return null;
    return (
      <div>
        <h3 className="text-sm font-semibold text-teal-400 mb-2">{title}</h3>
        <div className="grid gap-1">
          {filtered.map(([k, v]) => (
            <div key={k} className="flex gap-2 text-sm">
              <span className="text-gray-500 w-36 shrink-0">{k}:</span>
              <span className="text-gray-200">{v}</span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const addr = [d.addressLine1, d.addressLine2, d.city, d.province, d.postalCode]
    .filter(Boolean).join(', ');

  return (
    <div className="grid gap-6">
      {section('Company', [
        ['Name', d.name], ['Trading Name', d.tradingName],
        ['Registration', d.registrationNumber], ['VAT', d.vatNumber], ['Tax', d.taxNumber],
      ])}
      {section('Address & Contact', [
        ['Address', addr || undefined], ['Country', d.country],
        ['Phone', d.phone], ['Email', d.email], ['Website', d.website],
      ])}
      <div>
        <h3 className="text-sm font-semibold text-teal-400 mb-2">Logo</h3>
        {d.logoData ? (
          <img src={d.logoData} alt="Logo" className="w-16 h-16 rounded-lg object-contain bg-gray-800" />
        ) : (
          <p className="text-sm text-gray-500">Not uploaded</p>
        )}
      </div>
      {section('Banking', [
        ['Bank', d.bankName], ['Account', d.bankAccountNumber],
        ['Branch', d.bankBranchCode], ['Type', d.bankAccountType],
      ])}
      {section('Financial', [
        ['FY Start', MONTHS[d.financialYearStart - 1]],
        ['VAT Period', d.vatPeriod], ['Currency', d.defaultCurrency],
      ])}
      <div>
        <h3 className="text-sm font-semibold text-teal-400 mb-2">Documents</h3>
        {d.documents.length > 0 ? (
          <ul className="space-y-1">
            {d.documents.map(doc => (
              <li key={doc.type} className="text-sm text-gray-300">
                {DOC_SLOTS.find(s => s.type === doc.type)?.label || doc.type} — {doc.name}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-gray-500">None uploaded</p>
        )}
      </div>
    </div>
  );
}
