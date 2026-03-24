import type { AppProps } from 'next/app';
import { AuthProvider } from '@/contexts/AuthContext';
import '../styles/globals.css';

/**
 * Custom App component
 * Wraps all pages with AuthProvider for session management
 */
export default function App({ Component, pageProps }: AppProps) {
  return (
    <AuthProvider>
      <Component {...pageProps} />
    </AuthProvider>
  );
}
