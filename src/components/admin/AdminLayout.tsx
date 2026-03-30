/**
 * AdminLayout — wraps AppLayout with admin sidebar nav.
 * Enforces super_admin role; redirects non-admins to /login.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { AdminNav } from './AdminNav';
import { useAuth } from '@/contexts/AuthContext';
import { Loader2 } from 'lucide-react';

interface AdminLayoutProps {
  children: React.ReactNode;
  title: string;
}

export function AdminLayout({ children, title }: AdminLayoutProps) {
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
      <div className="flex min-h-[calc(100vh-4rem)] -m-4 lg:-m-6">
        <AdminNav />
        <main className="flex-1 p-6 overflow-y-auto bg-white dark:bg-gray-950 min-w-0">
          <h1 className="text-2xl font-bold mb-6 text-gray-900 dark:text-white">{title}</h1>
          {children}
        </main>
      </div>
    </AppLayout>
  );
}
