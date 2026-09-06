import { useEffect } from 'react';
import type { AppProps } from 'next/app';
import { useRouter } from 'next/router';
import { Toaster } from 'react-hot-toast';
import { AuthProvider } from '@/contexts/AuthContext';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { CompanyProvider } from '@/contexts/CompanyContext';
import { TableDensityProvider } from '@/contexts/TableDensityContext';
import { ThemeModeProvider } from '@/contexts/ThemeModeContext';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { TrackerScript } from '@/components/analytics/TrackerScript';
import { isSharePath } from '@/lib/paths/isSharePath';
import '../styles/globals.css';
import '../styles/print.css';

/**
 * Custom App component
 * Wraps all pages with ThemeProvider + AuthProvider
 * Registers service worker for PWA support (production only —
 * SW caching breaks HMR in dev by pinning old webpack bundles).
 */
export default function App({ Component, pageProps }: AppProps) {
  // The public share page is not tracked: its pathname carries the token.
  // The same predicate decides the service worker below, because the reason is
  // the same one — nothing about a share link may be written down client-side.
  // `isSharePath` is the one definition of that boundary; `isTrackedPath` in
  // the analytics module is derived from it, and public/sw.js keeps the only
  // other copy because a worker cannot import from src.
  const sharePage = isSharePath(useRouter().pathname);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    // No service worker on a share link. The recipient is a third party being
    // shown one document, and a worker installed from that page would go on
    // caching the pack — token in __NEXT_DATA__ and all — on their disk,
    // serving it offline after the sender revoked the link. public/sw.js
    // refuses to cache /share/ regardless; this is the half that stops a
    // recipient's browser acquiring a worker for this origin at all.
    //
    // The dev-only unregister sweep below is skipped on a share path too. It
    // is a no-op there in practice — this branch never registered a worker
    // from a share page for it to remove — and leaving one early return for
    // the whole effect is what keeps the two halves from drifting apart.
    if (sharePage) return;

    if (process.env.NODE_ENV === 'production') {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // Service worker registration failed — non-critical
      });
    } else {
      // Dev: tear down any SW a previous prod build left behind so
      // webpack hot-updates aren't intercepted from cache.
      navigator.serviceWorker.getRegistrations().then((regs) => {
        regs.forEach((r) => { void r.unregister(); });
      }).catch(() => { /* non-critical */ });
    }
  }, [sharePage]);

  return (
    <div>
    <ThemeProvider>
      <AuthProvider>
        <CompanyProvider>
        <ThemeModeProvider>
        <TableDensityProvider>
        <ErrorBoundary>
        <Component {...pageProps} />
        </ErrorBoundary>
        </TableDensityProvider>
        </ThemeModeProvider>
        {!sharePage && <TrackerScript />}
        <Toaster
          position="top-right"
          containerStyle={{ top: 16, right: 16 }}
          gutter={8}
          toastOptions={{
            duration: 4000,
            style: {
              background: 'transparent',
              boxShadow: 'none',
              padding: 0,
              maxWidth: '380px',
            },
          }}
        />
      </CompanyProvider>
      </AuthProvider>
    </ThemeProvider>
    </div>
  );
}
