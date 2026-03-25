import type { AppProps } from 'next/app';
import { AuthProvider } from '@/contexts/AuthContext';
import { ThemeProvider } from '@/contexts/ThemeContext';
import '../styles/globals.css';

/**
 * Custom App component
 * Wraps all pages with ThemeProvider + AuthProvider
 */
export default function App({ Component, pageProps }: AppProps) {
  return (
    <ThemeProvider>
      <AuthProvider>
        <Component {...pageProps} />
      </AuthProvider>
    </ThemeProvider>
  );
}
