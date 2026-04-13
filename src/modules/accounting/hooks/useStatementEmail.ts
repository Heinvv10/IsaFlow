/**
 * useStatementEmail — hook for bulk-emailing customer statements.
 * Calls POST /api/accounting/statement-bulk-email and manages progress/toast state.
 */

import { useState, useCallback } from 'react';
import { log } from '@/lib/logger';
import { apiFetch } from '@/lib/apiFetch';

export interface EmailProgress {
  total: number;
  current: number;
  sent: number;
  failed: number;
}

export interface Toast {
  type: 'success' | 'error';
  message: string;
}

interface Options {
  /** All customers in scope — used to filter those without an email */
  customers: { client_id: string; email?: string }[];
  asAtDate: string;
}

interface Return {
  emailProgress: EmailProgress | null;
  toast: Toast | null;
  isSending: boolean;
  /** Number of currently-selected IDs that have an email address */
  emailableCount: (selected: Set<string>) => number;
  sendEmails: (selected: Set<string>) => Promise<void>;
  dismissToast: () => void;
}

export function useStatementEmail({ customers, asAtDate }: Options): Return {
  const [emailProgress, setEmailProgress] = useState<EmailProgress | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);

  const showToast = (type: Toast['type'], message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 5000);
  };

  const emailableCount = useCallback(
    (selected: Set<string>) =>
      Array.from(selected).filter(
        id => customers.find(c => c.client_id === id)?.email
      ).length,
    [customers]
  );

  const sendEmails = useCallback(
    async (selected: Set<string>) => {
      const emailableIds = Array.from(selected).filter(
        id => customers.find(c => c.client_id === id)?.email
      );

      if (emailableIds.length === 0) {
        showToast('error', 'None of the selected customers have an email address.');
        return;
      }

      setEmailProgress({ total: emailableIds.length, current: 0, sent: 0, failed: 0 });

      try {
        // Show progress immediately — the API call is the blocking work
        setEmailProgress(p => (p ? { ...p, current: emailableIds.length } : null));

        const res = await apiFetch('/api/accounting/statement-bulk-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ customerIds: emailableIds, asAtDate }),
        });

        const json = await res.json();
        const result = json.data || json;

        const sent: number = result.sent ?? 0;
        const failed: number = result.failed ?? 0;
        const errors: string[] = result.errors ?? [];

        setEmailProgress({
          total: emailableIds.length,
          current: emailableIds.length,
          sent,
          failed,
        });

        if (failed === 0) {
          showToast('success', `Sent ${sent} statement${sent !== 1 ? 's' : ''} successfully.`);
        } else if (sent > 0) {
          showToast('error', `Sent ${sent}, failed ${failed}. ${errors[0] ?? ''}`);
        } else {
          showToast('error', `All ${failed} failed. ${errors[0] ?? ''}`);
        }

        if (!res.ok) {
          log.error('Bulk email API error', { status: res.status, result }, 'useStatementEmail');
        }
      } catch (err) {
        log.error('Bulk email request failed', { data: err }, 'useStatementEmail');
        showToast('error', 'Failed to send emails. Please try again.');
      } finally {
        setTimeout(() => setEmailProgress(null), 3000);
      }
    },
    [customers, asAtDate]
  );

  return {
    emailProgress,
    toast,
    isSending: emailProgress !== null,
    emailableCount,
    sendEmails,
    dismissToast: () => setToast(null),
  };
}
