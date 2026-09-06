import { useEffect } from 'react';
import { useRouter } from 'next/router';
import type { AppProps } from 'next/app';
import { Toaster } from 'react-hot-toast';
import { AuthProvider } from '@/contexts/AuthContext';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { CompanyProvider } from '@/contexts/CompanyContext';
import { isPrintRenderQuery } from '@/lib/pdf/printRenderQuery';
import { TableDensityProvider } from '@/contexts/TableDensityContext';
import { ThemeModeProvider } from '@/contexts/ThemeModeContext';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { TrackerScript } from '@/components/analytics/TrackerScript';
import '../styles/globals.css';
import '../styles/print.css';

/**
 * Custom App component
 * Wraps all pages with ThemeProvider + AuthProvider
 * Registers service worker for PWA support (production only —
 * SW caching breaks HMR in dev by pinning old webpack bundles).
 */
export default function App({ Component, pageProps }: AppProps) {
  const router = useRouter();
  // A print render (Gotenberg/Playwright photographing report-packs.tsx's
  // ?print=1 branch) needs no auth or company context, and Gotenberg cannot
  // stub these providers' own background fetches the way the Playwright
  // transport does: AuthProvider's /api/auth/me fails JWT verification on a
  // print token and its handler clears the sb-access-token cookie (the same
  // cookie carrying the print token), and CompanyProvider's own fetch 401s
  // under the print token, whose refresh-then-redirect (apiFetch.ts)
  // navigates the whole render to /login before it can finish. See
  // printRenderQuery.ts.
  const isPrintRender = isPrintRenderQuery(router.query);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

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
  }, []);

  return (
    <div>
    <ThemeProvider>
      <AuthProvider skipFetch={isPrintRender}>
        <CompanyProvider skipFetch={isPrintRender}>
        <ThemeModeProvider>
        <TableDensityProvider>
        <ErrorBoundary>
        <Component {...pageProps} />
        </ErrorBoundary>
        </TableDensityProvider>
        </ThemeModeProvider>
        <TrackerScript />
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
