/**
 * Pending bank-rule changes for the Bank rules page (forensic-controls step 2):
 * the changes held under the `bank_rule` switch, which rules have one (the
 * per-row badge), and Approve / Reject. apiFetch resolves on a 4xx, so every
 * call goes through assertOk and a refusal shows the server's own message.
 */
import { useCallback, useEffect, useState } from 'react';
import { notify } from '@/utils/toast';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';

export interface PendingRuleChange {
  id: string;
  ruleId: string | null;
  ruleName: string;
  kind: 'create' | 'update' | 'toggle';
  changes: { key: string; before: unknown; after: unknown }[];
  proposerName: string | null;
  proposedAt: string;
  digest: string;
  canDecide: boolean;
}

export interface UseBankRuleChangesResult {
  changes: PendingRuleChange[];
  pendingRuleIds: Set<string>;
  error: string;
  busyId: string;
  load: () => Promise<void>;
  decide: (change: PendingRuleChange, action: 'approve' | 'reject', note: string) => Promise<boolean>;
}

export function useBankRuleChanges(onDecided: () => Promise<void> | void): UseBankRuleChangesResult {
  const [changes, setChanges] = useState<PendingRuleChange[]>([]);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/accounting/bank-rule-changes?status=pending', { credentials: 'include' });
      await assertOk(res, 'Could not load pending rule changes - try again');
      const json = await res.json();
      setChanges((json.data?.items as PendingRuleChange[]) || []);
      setError('');
    } catch (err) {
      // Never an empty-but-valid list: a failed read says so instead of "nothing pending".
      setChanges([]);
      setError(apiErrorMessage(err, 'Could not load pending rule changes - try again'));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const decide = async (change: PendingRuleChange, action: 'approve' | 'reject', note: string): Promise<boolean> => {
    setBusyId(change.id);
    const failure = `Could not ${action} the change - try again`;
    try {
      const res = await apiFetch('/api/accounting/bank-rule-changes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ action, changeId: change.id, digest: change.digest, ...(note.trim() ? { note: note.trim() } : {}) }),
      });
      await assertOk(res, failure);
      notify.success(action === 'approve' ? `Change to "${change.ruleName}" approved and applied` : `Change to "${change.ruleName}" rejected`);
      return true;
    } catch (err) {
      notify.error(apiErrorMessage(err, failure));
      return false;
    } finally {
      setBusyId('');
      // Decided or refused (e.g. it went stale), the list and the rules moved: re-read both.
      await load();
      await onDecided();
    }
  };

  const pendingRuleIds = new Set(changes.map((c) => c.ruleId).filter((id): id is string => id !== null));
  return { changes, pendingRuleIds, error, busyId, load, decide };
}
