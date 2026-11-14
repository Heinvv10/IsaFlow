/**
 * AdminLayout — wraps AppLayout with admin sidebar nav.
 * Enforces super_admin role; redirects non-admins to /login.
 */

import { useEffect } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { AdminNav } from './AdminNav';
import { useAuth } from '@/contexts/AuthContext';
import { Loader2 } from 'lucide-react';

interface AdminLayoutProps {
  children: React.ReactNode;
  title: string;
  /** The page renders its own <h1> (a header with an icon or a subtitle): the layout then prints none, so
   *  there is one heading, not the same title twice (audit 4.14). */
  ownHeading?: boolean;
}

/** The browser tab title of an admin page (audit 4.14: every admin tab read just "IsaFlow"). */
export function adminDocumentTitle(title: string): string {
  return `${title} · Admin · IsaFlow`;
}

export function AdminLayout({ children, title, ownHeading = false }: AdminLayoutProps) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && (!user || user.role !== 'super_admin')) {
      void router.replace('/login');
    }
  }, [user, loading, router]);

  if (loading || !user || user.role !== 'super_admin') {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-6 h-6 animate-spin text-teal-500" />
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <Head><title>{adminDocumentTitle(title)}</title></Head>
      <div className="flex min-h-[calc(100vh-4rem)] -m-4 lg:-m-6">
        <AdminNav />
        <main className="flex-1 p-6 overflow-y-auto bg-white dark:bg-gray-950 min-w-0">
          {!ownHeading && <h1 className="text-2xl font-bold mb-6 text-gray-900 dark:text-white">{title}</h1>}
          {children}
        </main>
      </div>
    </AppLayout>
  );
}
