/**
 * Onboarding step 0: "What kind of business is this?" The eight entity types
 * of `@/lib/entityTypes`; every later step (registration field, people, the
 * required document, Smart Setup) follows the answer.
 */

import { Check } from 'lucide-react';
import { ENTITY_TYPES, type EntityTypeCode, type EntityTypeDef } from '@/lib/entityTypes';

/** One line under each option: who is captured and what must be uploaded. */
function hint(def: EntityTypeDef): string {
  const proof = def.requiredProof.kind === 'none' ? 'no document required' : `needs: ${def.requiredProof.label}`;
  return `${def.peopleLabel} · ${proof}`;
}

export function EntityTypeStep({ value, onChange }: { value: EntityTypeCode | null; onChange: (code: EntityTypeCode) => void }) {
  return (
    <div role="radiogroup" aria-label="What kind of business is this?" className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {ENTITY_TYPES.map(def => {
        const selected = value === def.code;
        return (
          <button
            key={def.code}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(def.code)}
            className={[
              'text-left rounded-xl border-2 p-3 transition-all focus:outline-none',
              selected
                ? 'border-teal-500 bg-teal-50 dark:bg-teal-900/20'
                : 'border-gray-300 bg-white hover:border-gray-400 dark:border-gray-700 dark:bg-gray-800/50 dark:hover:border-gray-500',
            ].join(' ')}
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-slate-900 dark:text-white">{def.label}</p>
                <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5">{hint(def)}</p>
              </div>
              {selected && <Check className="w-4 h-4 text-teal-400 shrink-0" />}
            </div>
          </button>
        );
      })}
    </div>
  );
}
