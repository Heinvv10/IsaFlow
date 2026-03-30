/**
 * Accounting Tour — lightweight custom onboarding tour.
 * No external dependencies. Uses a spotlight overlay with a cutout.
 * Auto-shows for new users; can be restarted via useRestartTour().
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { X, ChevronLeft, ChevronRight } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { TOUR_STEPS, getTooltipPosition, type TargetRect } from './tourConfig';

const PREF_KEY = 'onboarding_tour_completed';
const PADDING = 8;

export function AccountingTour() {
  const [active, setActive] = useState(false);
  const [step, setStep] = useState(0);
  const [targetRect, setTargetRect] = useState<TargetRect | null>(null);
  const [isMounted, setIsMounted] = useState(false);
  const rafRef = useRef<number | null>(null);

  useEffect(() => { setIsMounted(true); }, []);

  useEffect(() => {
    if (!isMounted) return;
    const check = async () => {
      try {
        const res = await apiFetch('/api/auth/preferences');
        const json = await res.json() as { data?: Record<string, string> };
        if (!json.data?.[PREF_KEY]) setActive(true);
      } catch (err) {
        log.warn('Failed to load tour preference', { error: err }, 'AccountingTour');
      }
    };
    void check();
  }, [isMounted]);

  const measureTarget = useCallback((stepIndex: number) => {
    const s = TOUR_STEPS[stepIndex];
    if (!s) return;
    const el = document.querySelector(s.target);
    if (!el) { setTargetRect(null); return; }
    const r = el.getBoundingClientRect();
    setTargetRect({
      top: r.top - PADDING,
      left: r.left - PADDING,
      width: r.width + PADDING * 2,
      height: r.height + PADDING * 2,
    });
  }, []);

  useEffect(() => {
    if (!active) return;
    measureTarget(step);
    const handleResize = () => measureTarget(step);
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [active, step, measureTarget]);

  const completeTour = useCallback(async () => {
    setActive(false);
    try {
      await apiFetch('/api/auth/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferences: { [PREF_KEY]: 'true' } }),
      });
      log.info('Onboarding tour completed', {}, 'AccountingTour');
    } catch (err) {
      log.warn('Failed to save tour preference', { error: err }, 'AccountingTour');
    }
  }, []);

  const goNext = useCallback(() => {
    if (step < TOUR_STEPS.length - 1) setStep(s => s + 1);
    else void completeTour();
  }, [step, completeTour]);

  const goBack = useCallback(() => {
    if (step > 0) setStep(s => s - 1);
  }, [step]);

  if (!isMounted || !active) return null;

  const currentStep = TOUR_STEPS[step]!;
  const tooltipPos = targetRect
    ? getTooltipPosition(targetRect, currentStep.position)
    : { top: window.innerHeight / 2 - 80, left: window.innerWidth / 2 - 160 };

  return (
    <div className="fixed inset-0 z-[9999] pointer-events-none">
      {/* Dark overlay with spotlight cutout */}
      {targetRect ? (
        <svg
          className="absolute inset-0 w-full h-full pointer-events-auto"
          onClick={(e) => { if (e.target === e.currentTarget) void completeTour(); }}
        >
          <defs>
            <mask id="tour-mask">
              <rect x="0" y="0" width="100%" height="100%" fill="white" />
              <rect x={targetRect.left} y={targetRect.top} width={targetRect.width} height={targetRect.height} rx="6" fill="black" />
            </mask>
          </defs>
          <rect x="0" y="0" width="100%" height="100%" fill="rgba(0,0,0,0.65)" mask="url(#tour-mask)" />
        </svg>
      ) : (
        <div className="absolute inset-0 bg-black/65 pointer-events-auto" onClick={() => void completeTour()} />
      )}

      {/* Highlight border */}
      {targetRect && (
        <div
          className="absolute rounded-md border-2 border-teal-400 pointer-events-none"
          style={{ top: targetRect.top, left: targetRect.left, width: targetRect.width, height: targetRect.height }}
        />
      )}

      {/* Tooltip */}
      <div
        className="absolute w-80 bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 p-5 pointer-events-auto"
        style={{ top: tooltipPos.top, left: tooltipPos.left }}
      >
        <div className="flex items-start justify-between mb-2">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{currentStep.title}</h3>
          <button onClick={() => void completeTour()} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors" aria-label="Skip tour">
            <X className="w-3.5 h-3.5 text-gray-400" />
          </button>
        </div>

        <p className="text-xs text-gray-600 dark:text-gray-400 leading-relaxed mb-4">
          {currentStep.content}
        </p>

        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-400">Step {step + 1} of {TOUR_STEPS.length}</span>
          <div className="flex items-center gap-2">
            <button onClick={() => void completeTour()} className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors">
              Skip Tour
            </button>
            {step > 0 && (
              <button onClick={goBack} className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-md border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                <ChevronLeft className="w-3 h-3" />Back
              </button>
            )}
            <button onClick={goNext} className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-md bg-teal-600 hover:bg-teal-700 text-white transition-colors font-medium">
              {step < TOUR_STEPS.length - 1 ? (<>Next <ChevronRight className="w-3 h-3" /></>) : 'Done'}
            </button>
          </div>
        </div>

        {/* Step dots */}
        <div className="flex items-center gap-1 mt-3 justify-center">
          {TOUR_STEPS.map((_, i) => (
            <div key={i} className={`rounded-full transition-all ${i === step ? 'w-4 h-1.5 bg-teal-500' : 'w-1.5 h-1.5 bg-gray-300 dark:bg-gray-600'}`} />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Hook to programmatically restart the tour (clears the preference and reloads).
 */
export function useRestartTour() {
  return useCallback(async () => {
    try {
      await apiFetch('/api/auth/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferences: { [PREF_KEY]: '' } }),
      });
      window.location.reload();
    } catch (err) {
      log.warn('Failed to reset tour preference', { error: err }, 'AccountingTour');
    }
  }, []);
}
