/**
 * Onboarding documents step. Asks for exactly the business type's one required
 * proof (entityOnboardingRules): a company document for a (Pty) Ltd, Ltd, NPC,
 * CC or trust; for a sole proprietor or partnership the proof is each person's
 * ID document, captured on the people step and shown here as a status line.
 * Tax clearance, B-BBEE and the VAT certificate are optional for everyone.
 */

import { Upload, CheckCircle2, AlertCircle } from 'lucide-react';
import { DEFAULT_ENTITY_TYPE, getEntityType } from '@/lib/entityTypes';
import { documentSlotsFor, proofIssues, type DocumentSlot } from '@/modules/onboarding/services/entityOnboardingRules';
import type { DocFile, SetFn, WizardData } from './wizardTypes';
import { MAX_UPLOAD_BYTES, UPLOAD_ACCEPT } from '@/modules/onboarding/uploadLimits';
import { factsOf } from './wizardFacts';

export function DocumentsStep({ d, set }: { d: WizardData; set: SetFn }) {
  const entityType = d.entityType ?? DEFAULT_ENTITY_TYPE;
  const def = getEntityType(entityType);
  const proof = def.requiredProof;
  const peopleIssues = proof.kind === 'person_ids' ? proofIssues(factsOf(d)) : [];

  const handleDocFile = (slot: DocumentSlot, file: File) => {
    if (file.size > MAX_UPLOAD_BYTES) return;
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
      {proof.kind === 'person_ids' && (
        <div className={`border rounded-lg p-4 ${peopleIssues.length ? 'border-teal-500/50' : 'border-gray-700'}`}>
          <div className="flex items-center gap-2 mb-1">
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{proof.label}</p>
            <span className="text-xs bg-teal-600/20 text-teal-400 px-1.5 py-0.5 rounded">Required</span>
          </div>
          {peopleIssues.length === 0 ? (
            <p className="flex items-center gap-1.5 text-xs text-green-400">
              <CheckCircle2 className="w-3.5 h-3.5" /> Captured on the {def.peopleLabel} step.
            </p>
          ) : (
            <ul className="text-xs text-amber-400 space-y-0.5">
              {peopleIssues.map(issue => (
                <li key={issue} className="flex items-center gap-1.5">
                  <AlertCircle className="w-3.5 h-3.5" /> {issue} (Back to the {def.peopleLabel} step)
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {documentSlotsFor(entityType).map(slot => {
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
                <input type="file" className="hidden" accept={UPLOAD_ACCEPT} aria-label={`Upload ${slot.label}`}
                  onChange={e => { const f = e.target.files?.[0]; if (f) handleDocFile(slot, f); }} />
              </label>
            )}
          </div>
        );
      })}
    </div>
  );
}
