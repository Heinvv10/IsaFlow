/**
 * "Install IsaFlow" banner, shown when the browser offers a PWA install (beforeinstallprompt). It hides itself after
 * 10s so it doesn't permanently eat vertical space (the browser's own Install button stays in the address bar), and
 * never comes back once dismissed.
 */
import { useEffect, useRef, useState } from 'react';
import { Download, X as XIcon } from 'lucide-react';
import { useTimeoutOnce } from '@/hooks/useTimeoutOnce';

const PWA_INSTALL_DISMISSED_KEY = 'isaflow-pwa-install-dismissed';

export function PwaInstallBanner() {
  const deferredPromptRef = useRef<Event | null>(null);
  const [show, setShow] = useState(false);
  const later = useTimeoutOnce();

  useEffect(() => {
    if (localStorage.getItem(PWA_INSTALL_DISMISSED_KEY)) return;
    const handler = (e: Event) => {
      e.preventDefault();
      deferredPromptRef.current = e;
      setShow(true);
      later(() => setShow(false), 10_000);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, [later]);

  const handleInstall = async () => {
    const prompt = deferredPromptRef.current as (Event & { prompt: () => Promise<void> }) | null;
    if (!prompt) return;
    await prompt.prompt();
    deferredPromptRef.current = null;
    setShow(false);
  };

  const dismiss = () => {
    setShow(false);
    localStorage.setItem(PWA_INSTALL_DISMISSED_KEY, '1');
  };

  if (!show) return null;
  return (
    <div className="bg-brand-600 text-white px-4 py-2 flex items-center justify-between text-sm flex-shrink-0">
      <div className="flex items-center gap-2">
        <Download className="w-4 h-4" />
        <span>Install IsaFlow for a faster, app-like experience</span>
      </div>
      <div className="flex items-center gap-2">
        <button onClick={handleInstall} className="px-3 py-1 bg-white/20 hover:bg-white/30 rounded text-xs font-medium transition-colors">
          Install
        </button>
        <button onClick={dismiss} className="p-1 hover:bg-white/20 rounded transition-colors" aria-label="Dismiss">
          <XIcon className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
