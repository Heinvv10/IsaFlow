/**
 * Onboarding wizard step components (Steps 1-7).
 */

import { useRef, useState } from 'react';
import { Upload, X, Loader2, ScanLine, Check } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import type { CoaTemplate } from '@/modules/accounting/services/gl/chartOfAccountsService';

// ── Types ───────────────────────────────────────────────────────────────────

export interface DocFile {
  type: string; name: string; data: string; mimeType: string; size: number;
}

export interface Director {
  name: string;
  idNumber: string;
  role: string; // e.g. 'Director', 'Managing Director', 'Member'
  idDocument?: DocFile;
  extracting?: boolean;
  idVerification?: 'verified' | 'updated' | 'failed'; // result of ID upload extraction
  idVerificationMsg?: string;
}

export type { CoaTemplate };

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
  coaTemplate: CoaTemplate;
  directors: Director[];
  cipcDirectors: Director[]; // directors extracted from CIPC for validation
  documents: DocFile[];
}

/** Human labels for the stored vat_period values, used by the review step. */
const VAT_LABELS: Record<string, string> = {
  none: 'Not registered',
  monthly: 'Monthly (Category C)',
  'bi-monthly': 'Bi-Monthly (Category A/B)',
};

export const INITIAL_WIZARD: WizardData = {
  name: '', tradingName: '', registrationNumber: '', vatNumber: '', taxNumber: '',
  addressLine1: '', addressLine2: '', city: '', province: '', postalCode: '',
  country: 'South Africa', phone: '', email: '', website: '', logoData: '',
  bankName: '', bankAccountNumber: '', bankBranchCode: '', bankAccountType: 'Current',
  financialYearStart: 3, vatPeriod: 'bi-monthly', defaultCurrency: 'ZAR',
  coaTemplate: 'isaflow_standard',
  directors: [],
  cipcDirectors: [],
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
  { type: 'cipc_certificate', label: 'CIPC Registration Certificate', required: true },
  { type: 'tax_clearance', label: 'SARS Tax Clearance Certificate', required: false },
  { type: 'bbbee_certificate', label: 'B-BBEE Certificate', required: false },
  { type: 'vat_registration', label: 'VAT Registration Certificate', required: false },
];
const DIRECTOR_ROLES = ['Director', 'Managing Director', 'Member', 'Chairperson', 'Secretary'];

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr: number[] = Array.from({ length: b.length + 1 }, () => 0);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const del = (prev[j] ?? 0) + 1;
      const ins = (curr[j - 1] ?? 0) + 1;
      const sub = (prev[j - 1] ?? 0) + cost;
      curr[j] = Math.min(del, ins, sub);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length] ?? 0;
}

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

interface ValidationWarning {
  type: string;
  message: string;
}

export function Step1({ d, set }: { d: WizardData; set: SetFn }) {
  const [validationWarnings, setValidationWarnings] = useState<ValidationWarning[]>([]);
  const [validating, setValidating] = useState(false);

  const runValidation = async (directors: Director[]) => {
    if (d.cipcDirectors.length === 0 || directors.length === 0) {
      setValidationWarnings([]);
      return;
    }
    setValidating(true);
    try {
      const res = await apiFetch('/api/onboarding/validate-directors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enteredDirectors: directors.map(dir => ({ name: dir.name, idNumber: dir.idNumber, role: dir.role })),
          cipcDirectors: d.cipcDirectors.map(dir => ({ name: dir.name, idNumber: dir.idNumber, role: dir.role })),
        }),
      });
      if (res.ok) {
        const body = await res.json() as { data?: { warnings?: ValidationWarning[] } };
        setValidationWarnings(body.data?.warnings ?? []);
      }
    } catch { /* non-critical */ }
    setValidating(false);
  };

  const addDirector = () => set('directors', [...d.directors, { name: '', idNumber: '', role: 'Director' }]);
  const updateDirector = (i: number, updates: Partial<Director>) => {
    const updated = d.directors.map((dir, idx) => idx === i ? { ...dir, ...updates } : dir);
    set('directors', updated);
    // Trigger validation if name or ID changed and CIPC data exists
    if (('name' in updates || 'idNumber' in updates) && d.cipcDirectors.length > 0) {
      void runValidation(updated);
    }
  };
  const removeDirector = (i: number) => {
    const updated = d.directors.filter((_, idx) => idx !== i);
    set('directors', updated);
    if (d.cipcDirectors.length > 0) void runValidation(updated);
  };

  const handleIdUpload = async (i: number, file: File) => {
    if (file.size > 20 * 1024 * 1024) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result as string;
      const doc: DocFile = { type: 'director_id', name: file.name, data: dataUrl, mimeType: file.type, size: file.size };
      updateDirector(i, { idDocument: doc, extracting: true, idVerification: undefined, idVerificationMsg: undefined });

      try {
        const res = await apiFetch('/api/onboarding/extract-id', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: dataUrl }),
        });
        if (res.ok) {
          const body = await res.json() as { success: boolean; data?: { name?: string; idNumber?: string } };
          if (body.success && body.data) {
            const existing = d.directors[i];
            const extractedName = body.data.name || '';
            const extractedId = body.data.idNumber || '';
            const hadName = existing?.name?.trim();
            const hadId = existing?.idNumber?.trim();

            // Determine verification status
            let verification: Director['idVerification'] = 'updated';
            let msg = '';

            // Final values to commit — may diverge from the raw extraction
            // if we detect a likely OCR misread of an already-correct name.
            let finalName = extractedName || existing?.name || '';
            const finalId = extractedId || existing?.idNumber || '';

            if (hadName && hadId && extractedName && extractedId) {
              // Both existed — check if they match
              const nameNorm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
              const idNorm = (s: string) => s.replace(/[\s-]/g, '');
              const nameMatch = nameNorm(hadName).includes(nameNorm(extractedName).split(' ').pop() ?? '')
                             || nameNorm(extractedName).includes(nameNorm(hadName).split(' ').pop() ?? '');
              const idMatch = idNorm(hadId) === idNorm(extractedId);

              // Guard: if the ID number confirms we're looking at the same person
              // AND the extracted name is only a character or two different from
              // the existing one, the VLM almost certainly misread a letter —
              // keep the user's value rather than regressing a good name.
              const nameDrift = levenshtein(nameNorm(hadName), nameNorm(extractedName));
              const isLikelyOcrDrift = idMatch && !nameMatch && nameDrift > 0 && nameDrift <= 2;

              if (isLikelyOcrDrift) {
                finalName = hadName;
                verification = 'verified';
                msg = `ID verified — kept "${hadName}" (document read as "${extractedName}", treated as OCR noise).`;
              } else if (nameMatch && idMatch) {
                verification = 'verified';
                msg = `ID verified — ${extractedName} matches the uploaded document.`;
              } else if (!nameMatch && !idMatch) {
                verification = 'updated';
                msg = `Details updated from ID. Previous: ${hadName} (${hadId}).`;
              } else if (!nameMatch) {
                verification = 'updated';
                msg = `Name updated from ID: ${extractedName}. Previous: ${hadName}.`;
              } else {
                verification = 'updated';
                msg = `ID number updated from document: ${extractedId}. Previous: ${hadId}.`;
              }
            } else if (extractedName || extractedId) {
              verification = 'updated';
              msg = `Details extracted from ID: ${extractedName}${extractedId ? ` (${extractedId})` : ''}.`;
            }

            updateDirector(i, {
              name: finalName,
              idNumber: finalId,
              idDocument: doc, extracting: false,
              idVerification: verification, idVerificationMsg: msg,
            });
            return;
          }
        }
      } catch { /* extraction failed */ }
      updateDirector(i, {
        idDocument: doc, extracting: false,
        idVerification: 'failed', idVerificationMsg: 'Could not extract details from ID. Please enter manually.',
      });
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="grid gap-4">
      <Field label="Company Name" value={d.name} onChange={v => set('name', v)} placeholder="Acme (Pty) Ltd" required />
      <Field label="Trading Name" value={d.tradingName} onChange={v => set('tradingName', v)} placeholder="Acme" />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Field label="Registration Number (CIPC)" value={d.registrationNumber} onChange={v => set('registrationNumber', v)} />
        <Field label="VAT Number" value={d.vatNumber} onChange={v => set('vatNumber', v)} />
        <Field label="Income Tax Number" value={d.taxNumber} onChange={v => set('taxNumber', v)} />
      </div>

      {/* Directors */}
      <div className="mt-2">
        <div className="flex items-center justify-between mb-2">
          <label className={labelCls}>Directors / Members</label>
          <button type="button" onClick={addDirector}
            className="text-xs text-teal-400 hover:text-teal-300 transition-colors">
            + Add Director
          </button>
        </div>
        {d.directors.length === 0 && (
          <p className="text-xs text-gray-500">No directors added yet. Click &quot;+ Add Director&quot; or upload an ID to auto-fill.</p>
        )}
        {d.directors.map((dir, i) => (
          <div key={i} className="border border-gray-300 dark:border-gray-700 rounded-lg p-3 mb-3">
            <div className="grid grid-cols-[1fr_1fr_auto] gap-2 mb-2 items-end">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Full Name</label>
                <input value={dir.name} onChange={e => updateDirector(i, { name: e.target.value })}
                  placeholder="Full name" className={inputCls} />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">ID / Passport Number</label>
                <input value={dir.idNumber} onChange={e => updateDirector(i, { idNumber: e.target.value })}
                  placeholder="ID number" className={inputCls} />
              </div>
              <button type="button" onClick={() => removeDirector(i)}
                className="text-red-400 hover:text-red-300 p-2 mb-0.5">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Role</label>
                <select value={dir.role} onChange={e => updateDirector(i, { role: e.target.value })} className={inputCls + ' w-48'}>
                  {DIRECTOR_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div className="flex items-center gap-2">
                {dir.extracting && <Loader2 className="w-3.5 h-3.5 text-teal-400 animate-spin" />}
                {dir.idDocument ? (
                  <span className="text-xs text-gray-600 dark:text-gray-400">{dir.idDocument.name}</span>
                ) : (
                  <label className="flex items-center gap-1.5 cursor-pointer text-xs text-teal-400 hover:text-teal-300">
                    <ScanLine className="w-3.5 h-3.5" /> Upload ID
                    <input type="file" className="hidden" accept="image/*,application/pdf"
                      onChange={e => { const f = e.target.files?.[0]; if (f) void handleIdUpload(i, f); e.target.value = ''; }} />
                  </label>
                )}
              </div>
            </div>
            {/* ID verification notice */}
            {dir.idVerification && dir.idVerificationMsg && (
              <div className={`mt-2 flex items-start gap-2 text-xs px-2.5 py-2 rounded-lg ${ dir.idVerification === 'verified' ? 'bg-green-500/10 border border-green-500/30 text-green-400' : dir.idVerification === 'updated' ? 'bg-teal-500/10 border border-teal-500/30 text-teal-400' : 'bg-amber-500/10 border border-amber-500/30 text-amber-400' }`}>
                <span>{dir.idVerification === 'verified' ? '✓' : dir.idVerification === 'updated' ? '↻' : '⚠'}</span>
                <span>{dir.idVerificationMsg}</span>
              </div>
            )}
          </div>
        ))}

        {/* CIPC Validation Warnings */}
        {d.cipcDirectors.length > 0 && d.directors.length > 0 && (
          <div className="mt-3">
            {validating && (
              <p className="text-xs text-gray-500 flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" /> Validating against CIPC...
              </p>
            )}
            {!validating && validationWarnings.length > 0 && (
              <div className="space-y-1.5">
                {validationWarnings.map((w, i) => (
                  <div key={i} className={`flex items-start gap-2 text-xs px-3 py-2 rounded-lg ${ w.type === 'missing_from_entry' ? 'bg-amber-500/10 border border-amber-500/30 text-amber-400' : w.type === 'not_on_cipc' ? 'bg-blue-500/10 border border-blue-500/30 text-blue-400' : 'bg-red-500/10 border border-red-500/30 text-red-400' }`}>
                    <span>{w.type === 'missing_from_entry' ? '⚠' : w.type === 'not_on_cipc' ? 'ℹ' : '✗'}</span>
                    <span>{w.message}</span>
                  </div>
                ))}
              </div>
            )}
            {!validating && validationWarnings.length === 0 && d.directors.some(dir => dir.name) && (
              <p className="text-xs text-green-400 flex items-center gap-1">✓ All directors match the CIPC certificate.</p>
            )}
          </div>
        )}
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
          <img src={d.logoData} alt="Logo" className="w-32 h-32 rounded-lg object-contain bg-slate-100 dark:bg-gray-800" />
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
          <p className="text-sm text-gray-600 dark:text-gray-400">Drag & drop your logo here, or click to browse</p>
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
      {/* Values are lowercase to match companies.vat_period as written by
          company settings — capitalised values left the settings dropdown
          blank. 'none' is how a non-VAT-vendor opts out of every VAT surface. */}
      <Select label="VAT Registration" value={d.vatPeriod} onChange={v => set('vatPeriod', v)}>
        <option value="none">Not registered for VAT</option>
        <option value="monthly">Registered — Monthly (Category C)</option>
        <option value="bi-monthly">Registered — Bi-Monthly (Category A/B)</option>
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
          <div key={slot.type} className={`border rounded-lg p-4 ${slot.required && !doc ? 'border-teal-500/50' : 'border-gray-700'}`}>
            <div className="flex items-center gap-2 mb-2">
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{slot.label}</p>
              {slot.required && <span className="text-xs bg-teal-600/20 text-teal-400 px-1.5 py-0.5 rounded">Required</span>}
            </div>
            {doc ? (
              <div className="flex items-center justify-between">
                <div className="text-xs text-gray-600 dark:text-gray-400">
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

// ── Step 6 (new): Chart of Accounts Template ────────────────────────────────

interface CoaOption {
  id: CoaTemplate;
  label: string;
  tagline: string;
  codes: string;
  detail: string;
}

const COA_OPTIONS: CoaOption[] = [
  {
    id: 'isaflow_standard',
    label: 'ISAFlow Standard',
    tagline: 'Recommended for SA businesses',
    codes: '1xxx · 2xxx · 3xxx · 4xxx · 5xxx',
    detail: 'Assets, Liabilities, Equity, Revenue, Expenses — balanced 5-category SA layout with 31 starter accounts.',
  },
  {
    id: 'xero_compatible',
    label: 'Xero-compatible',
    tagline: 'Match your Xero account structure',
    codes: '001–003 · 010–013 · 100–103 · 200–300 · 400 · 500–800',
    detail: '3-digit codes used by Xero SA. Switch accountants easily — your existing Xero mappings stay intact.',
  },
  {
    id: 'sage_compatible',
    label: 'Sage One-compatible',
    tagline: 'Match your Sage account structure',
    codes: '1000–1600 · 2000–2501 · 3000 · 4000 · 5000 · 6000',
    detail: 'Account codes aligned with Sage One SA. Ideal if you\'re migrating existing Sage data into ISAFlow.',
  },
  {
    id: 'blank',
    label: 'Blank / Custom',
    tagline: 'Start from scratch',
    codes: '—',
    detail: 'No accounts are created. You (or your accountant) set up the full chart manually.',
  },
];

export function StepCoaTemplate({ d, set }: { d: WizardData; set: SetFn }) {
  return (
    <div className="grid gap-4">
      <p className="text-sm text-gray-600 dark:text-gray-400">
        Choose the account code layout that matches how your business or accountant works.
        You can always add, rename, or remove accounts later.
      </p>
      {COA_OPTIONS.map(opt => {
        const selected = d.coaTemplate === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => set('coaTemplate', opt.id)}
            className={[
              'w-full text-left rounded-xl border-2 p-4 transition-all focus:outline-none',
              selected
                ? 'border-teal-500 bg-teal-900/20'
                : 'border-gray-700 bg-gray-800/50 hover:border-gray-500',
            ].join(' ')}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-sm font-semibold text-slate-900 dark:text-white">{opt.label}</span>
                  <span className="text-xs text-teal-400 bg-teal-900/40 px-2 py-0.5 rounded-full">
                    {opt.tagline}
                  </span>
                </div>
                <p className="text-xs text-gray-600 dark:text-gray-400 font-mono mb-1.5">{opt.codes}</p>
                <p className="text-xs text-gray-500">{opt.detail}</p>
              </div>
              <div className={[
                'w-5 h-5 rounded-full border-2 flex-shrink-0 mt-0.5 flex items-center justify-center',
                selected ? 'border-teal-500 bg-teal-500' : 'border-gray-600',
              ].join(' ')}>
                {selected && <Check className="w-3 h-3 text-slate-900 dark:text-white" />}
              </div>
            </div>
          </button>
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
              <span className="text-gray-800 dark:text-gray-200">{v}</span>
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
      {d.directors.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-teal-400 mb-2">Directors / Members</h3>
          <div className="grid gap-1">
            {d.directors.map((dir, i) => (
              <div key={i} className="flex gap-2 text-sm">
                <span className="text-gray-800 dark:text-gray-200">{dir.name}</span>
                <span className="text-gray-500">({dir.role})</span>
                {dir.idNumber && <span className="text-gray-500">— ID: {dir.idNumber}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
      {section('Address & Contact', [
        ['Address', addr || undefined], ['Country', d.country],
        ['Phone', d.phone], ['Email', d.email], ['Website', d.website],
      ])}
      <div>
        <h3 className="text-sm font-semibold text-teal-400 mb-2">Logo</h3>
        {d.logoData ? (
          <img src={d.logoData} alt="Logo" className="w-16 h-16 rounded-lg object-contain bg-slate-100 dark:bg-gray-800" />
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
        ['VAT', VAT_LABELS[d.vatPeriod] ?? d.vatPeriod], ['Currency', d.defaultCurrency],
        ['COA Template', COA_OPTIONS.find(o => o.id === d.coaTemplate)?.label],
      ])}
      <div>
        <h3 className="text-sm font-semibold text-teal-400 mb-2">Documents</h3>
        {d.documents.length > 0 ? (
          <ul className="space-y-1">
            {d.documents.map(doc => (
              <li key={doc.type} className="text-sm text-gray-700 dark:text-gray-300">
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
