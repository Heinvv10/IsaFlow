/**
 * "Install IsaFlow" banner, shown when the browser offers a PWA install (beforeinstallprompt), on the dashboard only
 * and only once: it is marked seen as soon as it shows, under the same key a dismiss writes. It hides itself after
 * 10s so it doesn't eat vertical space; the browser's own install control stays available.
 *
 * The listener lives in `usePwaInstallPrompt`, which AppLayout calls before it decides between the skeleton and the
 * shell: the browser fires beforeinstallprompt once, often during the session check, and a listener that only
 * attached with the banner would miss it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, X as XIcon } from 'lucide-react';
import { useTimeoutOnce } from '@/hooks/useTimeoutOnce';
import { log } from '@/lib/logger';

const PWA_INSTALL_DISMISSED_KEY = 'isaflow-pwa-install-dismissed';

export interface PwaInstallPrompt {
  show: boolean;
  install: () => Promise<void>;
  dismiss: () => void;
}

/** `enabled`: listen at all (AppLayout passes "on a dashboard"). */
export function usePwaInstallPrompt(enabled: boolean): PwaInstallPrompt {
  const deferredPromptRef = useRef<Event | null>(null);
  const [show, setShow] = useState(false);
  const later = useTimeoutOnce();

  useEffect(() => {
    if (!enabled || localStorage.getItem(PWA_INSTALL_DISMISSED_KEY)) return;
    const handler = (e: Event) => {
      e.preventDefault();
      deferredPromptRef.current = e;
      setShow(true);
      try {
        localStorage.setItem(PWA_INSTALL_DISMISSED_KEY, '1');
      } catch (err) {
        log.warn('PWA install banner: could not mark it seen', { error: String(err) });
      }
      later(() => setShow(false), 10_000);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, [enabled, later]);

  const install = useCallback(async () => {
    const prompt = deferredPromptRef.current as (Event & { prompt: () => Promise<void> }) | null;
    if (!prompt) return;
    await prompt.prompt();
    deferredPromptRef.current = null;
    setShow(false);
  }, []);

  const dismiss = useCallback(() => {
    setShow(false);
    localStorage.setItem(PWA_INSTALL_DISMISSED_KEY, '1');
  }, []);

  return { show, install, dismiss };
}

export function PwaInstallBanner({ show, install, dismiss }: PwaInstallPrompt) {
  if (!show) return null;
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
