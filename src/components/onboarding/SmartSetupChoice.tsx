/**
 * Smart Setup pre-step, shown after the business type is chosen: enter details
 * manually, or upload the document Smart Setup reads for that type
 * (entityOnboardingRules.smartSetupSourceFor): the CIPC certificate or CK1/CK2
 * for a company or CC (/api/onboarding/extract), the owner's ID for a sole
 * proprietor (/api/onboarding/extract-id). If the certificate's registration
 * number says it is another type, the user is asked which is right; the
 * choice is never switched silently.
 */

import { useState } from 'react';
import { Keyboard, ScanLine, Upload, Loader2, CheckCircle2, AlertCircle, FileText } from 'lucide-react';
import { apiFetch, apiErrorMessage, assertOk } from '@/lib/apiFetch';
import { getEntityType, type EntityTypeCode } from '@/lib/entityTypes';
import {
  documentSlotsFor, entityFromRegistrationNumber, smartSetupSourceFor, type DocumentSlot,
} from '@/modules/onboarding/services/entityOnboardingRules';
import type { WizardData, DocFile, Director } from './wizardTypes';
import { MAX_UPLOAD_BYTES, OWNER_ID_ACCEPT, UPLOAD_ACCEPT } from '@/modules/onboarding/uploadLimits';

interface Props {
  entityType: EntityTypeCode;
  onManual: () => void;
  onExtracted: (data: Partial<WizardData>) => void;
  onBack: () => void;
}

type ExtractState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success' }
  | { status: 'mismatch'; inferred: EntityTypeCode; data: Partial<WizardData> }
  | { status: 'error'; message: string };

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

const OWNER_ID_TYPE = 'director_id';
const FAIL = 'AI extraction could not read the document. Please enter details manually.';

/** The same certificate, filed under the other entity's proof type (a CIPC certificate that is really a CK1). */
function retypeProof(docs: DocFile[], from: EntityTypeCode, to: EntityTypeCode): DocFile[] {
  const a = getEntityType(from).requiredProof;
  const b = getEntityType(to).requiredProof;
  if (a.kind !== 'document' || b.kind !== 'document') return docs;
  return docs.map(d => (d.type === a.documentType ? { ...d, type: b.documentType } : d));
}

export function SmartSetupChoice({ entityType, onManual, onExtracted, onBack }: Props) {
  const def = getEntityType(entityType);
  const source = smartSetupSourceFor(entityType);
  const ownerFlow = source.kind === 'owner_id';
  const slots: DocumentSlot[] = ownerFlow
    ? [{ type: OWNER_ID_TYPE, label: "Owner's ID document", required: true }]
    : documentSlotsFor(entityType);
  const readType = ownerFlow ? OWNER_ID_TYPE : source.kind === 'company_document' ? source.documentType : '';

  const [showUploadArea, setShowUploadArea] = useState(false);
  const [docs, setDocs] = useState<DocFile[]>([]);
  const [extractState, setExtractState] = useState<ExtractState>({ status: 'idle' });

  const readDoc = docs.find(d => d.type === readType);
  const readLabel = slots.find(s => s.type === readType)?.label ?? 'document';
  const isLoading = extractState.status === 'loading';
  const isSuccess = extractState.status === 'success';

  const addDoc = async (slotType: string, file: File) => {
    const accept = slotType === OWNER_ID_TYPE ? OWNER_ID_ACCEPT : UPLOAD_ACCEPT;
    if (!accept.split(',').includes(file.type)) return;
    if (file.size > MAX_UPLOAD_BYTES) return;
    const dataUrl = await fileToDataUrl(file);
    const newDoc: DocFile = { type: slotType, name: file.name, data: dataUrl, mimeType: file.type, size: file.size };
    setDocs(prev => [...prev.filter(d => d.type !== slotType), newDoc]);
  };
  const removeDoc = (type: string) => setDocs(prev => prev.filter(d => d.type !== type));

  const finish = (data: Partial<WizardData>) => {
    setExtractState({ status: 'success' });
    setTimeout(() => onExtracted(data), 800);
  };

  const owner = (doc: DocFile, name = '', idNumber = '', msg?: string): Director => ({
    name, idNumber, role: def.personRole, idDocument: doc,
    ...(msg ? { idVerification: 'updated' as const, idVerificationMsg: msg } : {}),
  });

  const handleExtract = async () => {
    if (!readDoc) return;
    setExtractState({ status: 'loading' });
    try {
      const res = await apiFetch(ownerFlow ? '/api/onboarding/extract-id' : '/api/onboarding/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: readDoc.data }),
      });
      await assertOk(res, FAIL);
      const body = await res.json() as {
        success: boolean; error?: { message?: string };
        data?: Partial<Omit<WizardData, 'directors'>> & { directors?: { name?: string; idNumber?: string }[]; name?: string; idNumber?: string };
      };
      if (!body.success || !body.data) {
        setExtractState({ status: 'error', message: body.error?.message ?? FAIL });
        return;
      }
      if (ownerFlow) {
        const { name = '', idNumber = '' } = body.data;
        finish({ directors: [owner(readDoc, name, idNumber, `Details extracted from ID: ${name}${idNumber ? ` (${idNumber})` : ''}.`)], documents: [] });
        return;
      }
      const people: Director[] = (body.data.directors ?? []).map(p => ({ name: p.name ?? '', idNumber: p.idNumber ?? '', role: def.personRole }));
      const data: Partial<WizardData> = { ...body.data, directors: people, documents: docs };
      const inferred = entityFromRegistrationNumber(body.data.registrationNumber ?? '');
      if (inferred && inferred !== entityType) {
        setExtractState({ status: 'mismatch', inferred, data });
        return;
      }
      finish(data);
    } catch (err) {
      setExtractState({ status: 'error', message: apiErrorMessage(err, 'AI extraction is currently unavailable. Please enter details manually.') });
    }
  };

  // Pass the uploaded document(s) to the wizard without AI extraction
  const handleSkipExtract = () => {
    if (ownerFlow) onExtracted({ directors: readDoc ? [owner(readDoc)] : [], documents: [] });
    else onExtracted({ documents: docs });
  };

  const cardCls = 'group flex flex-col items-center gap-3 bg-slate-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 hover:border-teal-500 rounded-2xl p-6 text-center transition-all duration-200 hover:shadow-lg hover:shadow-teal-500/10';
  const iconCls = 'w-12 h-12 rounded-xl bg-gray-200 dark:bg-gray-700 group-hover:bg-teal-600/20 flex items-center justify-center transition-colors';

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-6 text-center">
        <h2 className="text-xl font-semibold text-slate-900 dark:text-white">How would you like to set up?</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
          Get started in seconds with AI extraction, or fill in details yourself.
        </p>
      </div>

      {!showUploadArea && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <button onClick={onManual} className={cardCls}>
              <div className={iconCls}><Keyboard className="w-6 h-6 text-gray-600 dark:text-gray-400 group-hover:text-teal-400 transition-colors" /></div>
              <p className="font-semibold text-slate-900 dark:text-white text-sm">Enter Details Manually</p>
              <p className="text-xs text-gray-600 dark:text-gray-400">Enter your business information step by step</p>
            </button>
            <button onClick={() => setShowUploadArea(true)} className={cardCls}>
              <div className={iconCls}><ScanLine className="w-6 h-6 text-gray-600 dark:text-gray-400 group-hover:text-teal-400 transition-colors" /></div>
              <p className="font-semibold text-slate-900 dark:text-white text-sm">Upload Documents</p>
              <p className="text-xs text-gray-600 dark:text-gray-400">Upload the {readLabel} — we&apos;ll extract the details</p>
            </button>
          </div>
          <div className="text-center mt-4">
            <button onClick={onBack} className="text-sm text-gray-600 dark:text-gray-400 hover:text-white transition-colors">Back</button>
          </div>
        </>
      )}

      {showUploadArea && (
        <div className="bg-slate-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-2xl p-6">
          {isLoading && (
            <div className="flex flex-col items-center gap-3 py-6">
              <Loader2 className="w-10 h-10 text-teal-500 animate-spin" />
              <p className="text-sm text-gray-700 dark:text-gray-300 font-medium">Analysing the {readLabel}...</p>
              <p className="text-xs text-gray-500">Extracting the details — this may take up to 30 seconds</p>
            </div>
          )}

          {isSuccess && (
            <div className="flex flex-col items-center gap-3 py-6">
              <CheckCircle2 className="w-10 h-10 text-teal-400" />
              <p className="text-sm text-gray-700 dark:text-gray-300 font-medium">Details extracted!</p>
              <p className="text-xs text-gray-500">Opening your pre-filled form...</p>
            </div>
          )}

          {extractState.status === 'mismatch' && (
            <div className="flex flex-col gap-3 py-2">
              <p className="text-sm text-gray-700 dark:text-gray-300">
                This document looks like a <strong>{getEntityType(extractState.inferred).label}</strong>, but you chose{' '}
                <strong>{def.label}</strong>. Which is right?
              </p>
              <div className="flex flex-wrap gap-3">
                <button onClick={() => finish({ ...extractState.data, entityType: extractState.inferred,
                  documents: retypeProof(docs, entityType, extractState.inferred) })}
                  className="bg-teal-600 hover:bg-teal-500 text-white text-sm font-medium px-4 py-2 rounded-lg">
                  It is a {getEntityType(extractState.inferred).label}
                </button>
                <button onClick={() => finish(extractState.data)}
                  className="border border-gray-600 text-sm text-gray-700 dark:text-gray-300 px-4 py-2 rounded-lg hover:border-teal-500">
                  Keep {def.label}
                </button>
              </div>
            </div>
          )}

          {(extractState.status === 'idle' || extractState.status === 'error') && (
            <>
              <p className="text-sm text-gray-700 dark:text-gray-300 mb-4">Upload your documents. The {readLabel} is required for AI extraction.</p>
              <div className="grid gap-3">
                {slots.map(slot => {
                  const doc = docs.find(d => d.type === slot.type);
                  return (
                    <div key={slot.type} className={`border rounded-lg p-3 ${slot.required && !doc ? 'border-teal-500/50 bg-teal-500/5' : 'border-gray-700'}`}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <FileText className="w-4 h-4 text-gray-500" />
                          <span className="text-sm text-gray-700 dark:text-gray-300">{slot.label}</span>
                          {slot.required && <span className="text-xs bg-teal-600/20 text-teal-400 px-1.5 py-0.5 rounded">Required</span>}
                        </div>
                        {doc ? (
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-gray-600 dark:text-gray-400">{doc.name}</span>
                            <button onClick={() => removeDoc(slot.type)} className="text-xs text-red-400 hover:text-red-300">Remove</button>
                          </div>
                        ) : (
                          <label className="flex items-center gap-1.5 cursor-pointer text-xs text-teal-400 hover:text-teal-300">
                            <Upload className="w-3.5 h-3.5" /> Upload
                            <input type="file" className="sr-only" aria-label={`Upload ${slot.label}`}
                              accept={slot.type === OWNER_ID_TYPE ? OWNER_ID_ACCEPT : UPLOAD_ACCEPT}
                              onChange={e => { const f = e.target.files?.[0]; if (f) { void addDoc(slot.type, f); } e.target.value = ''; }} />
                          </label>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {extractState.status === 'error' && (
                <div className="mt-4 flex items-start gap-2 px-3 py-2.5 bg-red-500/10 border border-red-500/30 rounded-lg">
                  <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                  <p className="text-sm text-red-400">{extractState.message}</p>
                </div>
              )}

              <div className="flex items-center justify-between mt-5">
                <button onClick={() => { setShowUploadArea(false); setExtractState({ status: 'idle' }); setDocs([]); }}
                  className="text-sm text-gray-600 dark:text-gray-400 hover:text-white transition-colors">
                  Back
                </button>
                <div className="flex gap-3">
                  {docs.length > 0 && (
                    <button onClick={handleSkipExtract} className="text-sm text-gray-600 dark:text-gray-400 hover:text-white transition-colors">
                      Skip Extraction
                    </button>
                  )}
                  <button onClick={() => void handleExtract()} disabled={!readDoc}
                    className="flex items-center gap-2 bg-teal-600 hover:bg-teal-500 disabled:bg-teal-800 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors">
                    <ScanLine className="w-4 h-4" /> Extract Details
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {showUploadArea && !isLoading && !isSuccess && (
        <p className="text-center text-xs text-gray-500 mt-4">
          Prefer to type?{' '}
          <button onClick={onManual} className="text-teal-400 hover:text-teal-300 underline">
            Enter details manually
          </button>
        </p>
      )}
    </div>
  );
}
