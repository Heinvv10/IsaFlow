import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { Loader2 } from 'lucide-react';

export default function ChartOfAccountsPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/accounting?tab=chart-of-accounts');
  }, [router]);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)] flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-emerald-500" />
      </div>
    </AppLayout>
  );
}
