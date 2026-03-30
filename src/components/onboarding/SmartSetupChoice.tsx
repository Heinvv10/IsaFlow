/**
 * Smart Setup pre-step: choose between manual entry and document upload.
 * Upload mode shows individual doc slots with CIPC mandatory for AI extraction.
 */

import { useRef, useState } from 'react';
import { Keyboard, ScanLine, Upload, Loader2, CheckCircle2, AlertCircle, FileText } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import type { WizardData, DocFile } from './WizardSteps';
import { DOC_SLOTS } from './WizardSteps';

interface Props {
  onManual: () => void;
  onExtracted: (data: Partial<WizardData>) => void;
}

type ExtractState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success' }
  | { status: 'error'; message: string };

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];

export function SmartSetupChoice({ onManual, onExtracted }: Props) {
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [showUploadArea, setShowUploadArea] = useState(false);
  const [docs, setDocs] = useState<DocFile[]>([]);
  const [extractState, setExtractState] = useState<ExtractState>({ status: 'idle' });

  const cipcDoc = docs.find(d => d.type === 'cipc_certificate');
  const isLoading = extractState.status === 'loading';
  const isSuccess = extractState.status === 'success';

  const addDoc = async (slotType: string, file: File) => {
    if (!ALLOWED.includes(file.type)) return;
    if (file.size > 20 * 1024 * 1024) return;
    const dataUrl = await fileToDataUrl(file);
    const newDoc: DocFile = { type: slotType, name: file.name, data: dataUrl, mimeType: file.type, size: file.size };
    setDocs(prev => [...prev.filter(d => d.type !== slotType), newDoc]);
  };

  const removeDoc = (type: string) => setDocs(prev => prev.filter(d => d.type !== type));

  const handleExtract = async () => {
    if (!cipcDoc) return;
    setExtractState({ status: 'loading' });

    try {
      const res = await apiFetch('/api/onboarding/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: cipcDoc.data }),
      });
      const body = await res.json() as { success: boolean; data?: Partial<WizardData>; error?: { message?: string } };

      if (!res.ok || !body.success) {
        setExtractState({ status: 'error', message: body.error?.message ?? 'AI extraction failed.' });
        return;
      }

      setExtractState({ status: 'success' });
      setTimeout(() => {
        onExtracted({ ...body.data, documents: docs });
      }, 800);
    } catch {
      setExtractState({ status: 'error', message: 'AI extraction is currently unavailable. Please enter details manually.' });
    }
  };

  const handleSkipExtract = () => {
    // Pass uploaded docs to the wizard without AI extraction
    onExtracted({ documents: docs });
  };

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-6 text-center">
        <h2 className="text-xl font-semibold text-white">How would you like to set up?</h2>
        <p className="text-sm text-gray-400 mt-1">
          Get started in seconds with AI extraction, or fill in details yourself.
        </p>
      </div>

      {/* Choice cards */}
      {!showUploadArea && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <button onClick={onManual}
            className="group flex flex-col items-center gap-3 bg-gray-800 border border-gray-700 hover:border-teal-500 rounded-2xl p-6 text-center transition-all duration-200 hover:shadow-lg hover:shadow-teal-500/10">
            <div className="w-12 h-12 rounded-xl bg-gray-700 group-hover:bg-teal-600/20 flex items-center justify-center transition-colors">
              <Keyboard className="w-6 h-6 text-gray-400 group-hover:text-teal-400 transition-colors" />
            </div>
            <p className="font-semibold text-white text-sm">Enter Details Manually</p>
            <p className="text-xs text-gray-400">Enter your company information step by step</p>
          </button>

          <button onClick={() => setShowUploadArea(true)}
            className="group flex flex-col items-center gap-3 bg-gray-800 border border-gray-700 hover:border-teal-500 rounded-2xl p-6 text-center transition-all duration-200 hover:shadow-lg hover:shadow-teal-500/10">
            <div className="w-12 h-12 rounded-xl bg-gray-700 group-hover:bg-teal-600/20 flex items-center justify-center transition-colors">
              <ScanLine className="w-6 h-6 text-gray-400 group-hover:text-teal-400 transition-colors" />
            </div>
            <p className="font-semibold text-white text-sm">Upload Documents</p>
            <p className="text-xs text-gray-400">Upload your CIPC certificate and other docs — we&apos;ll extract the details</p>
          </button>
        </div>
      )}

      {/* Upload area with document slots */}
      {showUploadArea && (
        <div className="bg-gray-800 border border-gray-700 rounded-2xl p-6">
          {isLoading && (
            <div className="flex flex-col items-center gap-3 py-6">
              <Loader2 className="w-10 h-10 text-teal-500 animate-spin" />
              <p className="text-sm text-gray-300 font-medium">Analysing CIPC certificate...</p>
              <p className="text-xs text-gray-500">Extracting company details — this may take up to 30 seconds</p>
            </div>
          )}

          {isSuccess && (
            <div className="flex flex-col items-center gap-3 py-6">
              <CheckCircle2 className="w-10 h-10 text-teal-400" />
              <p className="text-sm text-gray-300 font-medium">Details extracted!</p>
              <p className="text-xs text-gray-500">Opening your pre-filled form...</p>
            </div>
          )}

          {!isLoading && !isSuccess && (
            <>
              <p className="text-sm text-gray-300 mb-4">Upload your company documents. CIPC certificate is required for AI extraction.</p>

              <div className="grid gap-3">
                {DOC_SLOTS.map(slot => {
                  const doc = docs.find(d => d.type === slot.type);
                  return (
                    <div key={slot.type} className={`border rounded-lg p-3 ${slot.required && !doc ? 'border-teal-500/50 bg-teal-500/5' : 'border-gray-700'}`}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <FileText className="w-4 h-4 text-gray-500" />
                          <span className="text-sm text-gray-300">{slot.label}</span>
                          {slot.required && <span className="text-xs bg-teal-600/20 text-teal-400 px-1.5 py-0.5 rounded">Required</span>}
                        </div>
                        {doc ? (
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-gray-400">{doc.name}</span>
                            <button onClick={() => removeDoc(slot.type)} className="text-xs text-red-400 hover:text-red-300">Remove</button>
                          </div>
                        ) : (
                          <label className="flex items-center gap-1.5 cursor-pointer text-xs text-teal-400 hover:text-teal-300">
                            <Upload className="w-3.5 h-3.5" /> Upload
                            <input type="file" className="hidden" accept="image/*,application/pdf"
                              ref={el => { fileRefs.current[slot.type] = el; }}
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
                  className="text-sm text-gray-400 hover:text-white transition-colors">
                  Back
                </button>
                <div className="flex gap-3">
                  {docs.length > 0 && (
                    <button onClick={handleSkipExtract}
                      className="text-sm text-gray-400 hover:text-white transition-colors">
                      Skip Extraction
                    </button>
                  )}
                  <button onClick={() => void handleExtract()} disabled={!cipcDoc}
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
