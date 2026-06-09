/**
 * Bank Statement Import — bulk-aware uploader.
 *
 * Replaced the legacy single-file 5-phase state machine with a unified
 * bulk uploader that handles 1–N files with the same UX. Folder
 * drag-drop, per-file account-number validation, cross-file dedupe,
 * and per-file PAYG metering are all delegated to BulkImportPanel.
 */

import Link from 'next/link';
import { useRouter } from 'next/router';
import { ArrowLeft } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { BulkImportPanel } from '@/components/accounting/bank/BulkImportPanel';

export default function BankStatementImportPage() {
  const router = useRouter();
  const accountId = typeof router.query.account_id === 'string' ? router.query.account_id : null;
  return (
    <AppLayout>
      <div className="mx-auto max-w-4xl space-y-6 px-4 py-6">
        <div>
          <Link
            href="/accounting/bank-reconciliation"
            className="inline-flex items-center gap-1.5 text-xs text-[var(--ff-text-muted)] hover:text-[var(--ff-text-primary)]"
          >
            <ArrowLeft className="h-3 w-3" />
            Back to bank reconciliation
          </Link>
          <h1 className="mt-2 text-2xl font-semibold text-[var(--ff-text-primary)]">
            Import bank statements
          </h1>
          <p className="mt-1 text-sm text-[var(--ff-text-muted)]">
            Drop a folder of statements for one bank account. We&apos;ll parse each file,
            verify it matches the chosen account, and import everything in one go.
          </p>
        </div>

        <BulkImportPanel initialAccountId={accountId} />
      </div>
    </AppLayout>
  );
}
