import Head from 'next/head';
import Image from 'next/image';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';

interface ErrorPageShellProps {
  title: string;
  heading: string;
  message: string;
}

const PRIMARY_LINK =
  'bg-brand-600 hover:bg-brand-700 text-white font-medium text-sm px-4 py-2.5 rounded-lg transition-colors';
const SECONDARY_LINK =
  'border border-slate-300 dark:border-gray-600 text-slate-900 dark:text-white font-medium text-sm px-4 py-2.5 rounded-lg transition-colors hover:bg-slate-100 dark:hover:bg-gray-800';

/**
 * Static, branded shell for the 404 and error pages. Reads auth state from
 * context only (no fetch). While auth is loading it renders the signed-out
 * links, which matches the prerendered HTML.
 */
export function ErrorPageShell({ title, heading, message }: ErrorPageShellProps) {
  const { isAuthenticated } = useAuth();

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-gray-950 flex items-center justify-center px-4">
      <Head>
        <title>{title}</title>
      </Head>
      <div className="w-full max-w-sm text-center">
        <div className="flex flex-col items-center mb-8">
          <Image src="/logo.png" alt="IsaFlow" width={160} height={64} className="h-16 w-auto dark:brightness-0 dark:invert mb-4" priority />
        </div>
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl p-6 shadow-xl">
          <h1 className="text-lg font-semibold text-slate-900 dark:text-white mb-2">{heading}</h1>
          <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed mb-6">{message}</p>
          <div className="flex items-center justify-center gap-3">
            {isAuthenticated ? (
              <Link href="/accounting" className={PRIMARY_LINK}>Go to dashboard</Link>
            ) : (
              <>
                <Link href="/login" className={PRIMARY_LINK}>Sign in</Link>
                <Link href="/" className={SECONDARY_LINK}>Home</Link>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
