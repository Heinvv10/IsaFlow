/**
 * The onboarding wizard's step dots. A step the wizard skips (the documents
 * step once the required certificate came in through Smart Setup) shows as done.
 */

import { Check } from 'lucide-react';

interface Props {
  steps: readonly { title: string }[];
  step: number;
  skippedIndex: number | null;
  onJump: (i: number) => void;
}

export function WizardProgress({ steps, step, skippedIndex, onJump }: Props) {
  return (
    <div className="max-w-2xl mx-auto mb-8">
      <div className="flex items-center justify-between">
        {steps.map((s, i) => {
          const isSkipped = i === skippedIndex;
          const isPast = i < step || (isSkipped && step > i);
          const isCurrent = i === step;
          return (
            <div key={i} className="flex items-center flex-1 last:flex-none">
              <button
                onClick={() => { if (isPast && !isSkipped) onJump(i); }}
                disabled={i > step || isSkipped}
                title={isSkipped ? 'Already captured from Smart Setup' : s.title}
                className={`w-7 h-7 text-xs sm:w-9 sm:h-9 sm:text-sm rounded-full flex items-center justify-center font-medium shrink-0 transition-colors ${ isSkipped ? 'bg-teal-600/40 text-white/70 cursor-default' : isPast ? 'bg-teal-600 text-white cursor-pointer' : isCurrent ? 'bg-teal-500 text-white ring-2 ring-teal-400' : 'bg-gray-200 text-gray-600 dark:bg-gray-800 dark:text-gray-500' }`}
              >
                {isSkipped || isPast ? <Check className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> : i + 1}
              </button>
              {i < steps.length - 1 && (
                <div className={`h-0.5 flex-1 min-w-1 mx-0.5 sm:mx-1 ${(isPast || isSkipped) ? 'bg-teal-600' : 'bg-gray-200 dark:bg-gray-800'}`} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
