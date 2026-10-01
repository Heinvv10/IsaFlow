/** What the bank page says about its supplier list while it pages in, after it failed, or when it was cut at the cap. */

import { AlertCircle } from 'lucide-react';
import { truncatedSuppliersNotice } from '@/lib/fetchAllSuppliers';

export type SuppliersStatus = 'loading' | 'ok' | 'failed' | 'truncated';

export function BankTxSuppliersNotice({ status }: { status: SuppliersStatus }) {
  if (status === 'failed') {
    return (
      <div role="alert" className="mx-6 mt-3 flex items-center gap-2 text-xs text-red-400"><AlertCircle className="h-4 w-4" />Suppliers failed to load — supplier allocation is unavailable until you reload.</div>
    );
  }
  if (status === 'truncated') {
    return (
      <div role="status" className="mx-6 mt-3 flex items-center gap-2 text-xs text-amber-500"><AlertCircle className="h-4 w-4" />{truncatedSuppliersNotice()}</div>
    );
  }
  return null;
}
