/**
 * "Install IsaFlow" banner, shown when the browser offers a PWA install (beforeinstallprompt), on the dashboard only
 * and only once: it is marked seen when the banner is actually drawn, under the same key a dismiss writes. It hides
 * itself after 10s so it doesn't eat vertical space; the browser's own install control stays available.
 *
 * The listener lives in `usePwaInstallPrompt`, which AppLayout calls before it decides between the skeleton and the
 * shell: the browser fires beforeinstallprompt once, often during the session check, and a listener that only
 * attached with the banner would miss it. It listens on every page (so the browser's own mini-infobar stays
 * suppressed everywhere, as before) and only the display is limited to the dashboard.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, X as XIcon } from 'lucide-react';
import { useTimeoutOnce } from '@/hooks/useTimeoutOnce';
import { log } from '@/lib/logger';

const PWA_INSTALL_DISMISSED_KEY = 'isaflow-pwa-install-dismissed';

/** idle: no offer yet. offered: the browser offered, not drawn yet. showing: drawn (and marked seen). done: never again. */
type Phase = 'idle' | 'offered' | 'showing' | 'done';

export interface PwaInstallPrompt {
  show: boolean;
  install: () => Promise<void>;
  dismiss: () => void;
  /** Called by the banner once it is on screen: marks it seen and starts the 10s auto-hide. */
  onShown: () => void;
}

/** `enabled`: may the banner show here (AppLayout passes "on a dashboard"). The listener runs either way. */
export function usePwaInstallPrompt(enabled: boolean): PwaInstallPrompt {
  const deferredPromptRef = useRef<Event | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const later = useTimeoutOnce();

  // Listens even once the banner has been seen or dismissed: preventDefault keeps the browser's own install
  // infobar suppressed on every later page load too. Only the phase (whether our banner shows) is gated.
  useEffect(() => {
    const seen = !!localStorage.getItem(PWA_INSTALL_DISMISSED_KEY);
    const handler = (e: Event) => {
      e.preventDefault();
      deferredPromptRef.current = e;
      if (!seen) setPhase((p) => (p === 'idle' ? 'offered' : p));
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  // Leaving the dashboard while the banner is up ends it: it does not come back on the next dashboard visit.
  useEffect(() => {
    if (!enabled) setPhase((p) => (p === 'showing' ? 'done' : p));
  }, [enabled]);

  const onShown = useCallback(() => {
    setPhase((p) => (p === 'offered' ? 'showing' : p));
  }, []);

  useEffect(() => {
    if (phase !== 'showing') return;
    try {
      localStorage.setItem(PWA_INSTALL_DISMISSED_KEY, '1');
    } catch (err) {
      log.warn('PWA install banner: could not mark it seen', { error: String(err) });
    }
    later(() => setPhase('done'), 10_000);
  }, [phase, later]);

  const install = useCallback(async () => {
    const prompt = deferredPromptRef.current as (Event & { prompt: () => Promise<void> }) | null;
    if (!prompt) return;
    await prompt.prompt();
    deferredPromptRef.current = null;
    setPhase('done');
  }, []);

  const dismiss = useCallback(() => {
    setPhase('done');
    localStorage.setItem(PWA_INSTALL_DISMISSED_KEY, '1');
  }, []);

  const show = enabled && (phase === 'offered' || phase === 'showing');
  return { show, install, dismiss, onShown };
}

export function PwaInstallBanner({ show, ...rest }: PwaInstallPrompt) {
  if (!show) return null;
  return <ShownBanner {...rest} />;
}

function ShownBanner({ install, dismiss, onShown }: Omit<PwaInstallPrompt, 'show'>) {
  useEffect(() => { onShown(); }, [onShown]);
  return (
    <section aria-label="Install IsaFlow" className="bg-brand-600 text-white px-4 py-2 flex items-center justify-between gap-3 text-sm flex-shrink-0">
      <div className="flex items-center gap-2 min-w-0">
        <Download className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
        <span className="truncate">Install IsaFlow on this device</span>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <button type="button" onClick={() => void install()} className="px-3 py-1 rounded text-xs font-semibold bg-white text-brand-800 hover:bg-teal-50 transition-colors">
          Install
        </button>
        <button type="button" onClick={dismiss} className="p-1 hover:bg-white/20 rounded transition-colors" aria-label="Dismiss install prompt">
          <XIcon className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
