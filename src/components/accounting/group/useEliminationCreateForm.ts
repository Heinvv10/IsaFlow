/**
 * The manual-elimination form of the Eliminations page: its state and its submit. RULING 2026-11-21: on or after a mirroring pair's cutover
 * (`reasonRequiredFrom`, the group's earliest) the pair's documents are eliminated by mirroring, so a hand-made elimination dated then needs a
 * typed reason; the form refuses to send without one, and the API refuses it too.
 */
import { useRef, useState } from 'react';
import type React from 'react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { localISODate } from '@/lib/dateUtils';
import { fmt, type EliminationLine, type EliminationType } from './EliminationsShared';
import { manualReasonMissing, manualReasonTooLong } from '@/modules/accounting/services/reports/manualReason';

const BLANK_LINES: EliminationLine[] = [{ groupAccountCode: '', debit: 0, credit: 0 }, { groupAccountCode: '', debit: 0, credit: 0 }];

/**
 * The group's account code → id. Elimination lines are stored by group account ID (the consolidated reports look them up by id), but the form
 * takes the code a person knows.
 */
async function groupAccountIds(groupId: string): Promise<Map<string, string>> {
  const res = await apiFetch(`/api/accounting/company-groups?action=accounts&group_id=${encodeURIComponent(groupId)}`);
  await assertOk(res, 'Could not load the group chart of accounts');
  const json = (await res.json()) as { data?: { items?: Array<{ id?: unknown; accountCode?: unknown }> } };
  const map = new Map<string, string>();
  for (const a of json.data?.items ?? []) {
    if (typeof a.id === 'string' && typeof a.accountCode === 'string') map.set(a.accountCode, a.id);
  }
  return map;
}

/** Whether a manual elimination dated `period` needs a reason: on or after the group's earliest mirroring cutover. */
export function reasonRequired(period: string, reasonRequiredFrom: string | null): boolean {
  return reasonRequiredFrom !== null && period >= reasonRequiredFrom;
}

export function useEliminationCreateForm(groupId: string, reasonRequiredFrom: string | null, onCreated: () => Promise<void>) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<EliminationType>('interco_revenue');
  const [description, setDescription] = useState('');
  const [period, setPeriod] = useState(() => localISODate());
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState<EliminationLine[]>(BLANK_LINES);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  // `saving` is state: a second submit in the same event batch (Enter, a double click) would pass it, so a ref guards the POST
  const inFlight = useRef(false);
  const needsReason = reasonRequired(period, reasonRequiredFrom);

  const start = () => {
    setType('interco_revenue'); setDescription(''); setPeriod(localISODate()); setReason('');
    setLines(BLANK_LINES.map((l) => ({ ...l }))); setError(''); setOpen(true);
  };

  async function submit(e: React.FormEvent<Element>) {
    e.preventDefault();
    if (!groupId || inFlight.current) return;
    const totalDebit = lines.reduce((s, l) => s + Number(l.debit || 0), 0);
    const totalCredit = lines.reduce((s, l) => s + Number(l.credit || 0), 0);
    if (Math.abs(totalDebit - totalCredit) > 0.01) { setError(`Debits (${fmt(totalDebit)}) must equal credits (${fmt(totalCredit)})`); return; }
    if (lines.some((l) => !l.groupAccountCode)) { setError('All lines must have a group account code'); return; }
    const problem = manualReasonTooLong(reason.trim()) ?? (needsReason ? manualReasonMissing(reason.trim(), reasonRequiredFrom ?? '') : null);
    if (problem) { setError(problem); return; }
    inFlight.current = true;
    setSaving(true); setError('');
    try {
      const ids = await groupAccountIds(groupId);
      const unknown = lines.map((l) => l.groupAccountCode.trim()).filter((c) => !ids.has(c));
      if (unknown.length > 0) { setError(`Not a group account code: ${[...new Set(unknown)].join(', ')}`); return; }
      const res = await apiFetch(`/api/accounting/consolidated-reports?group_id=${groupId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // The field names the route reads; the elimination is dated on the chosen day.
          action: 'create-elimination', adjustmentType: type, description, periodStart: period, periodEnd: period,
          ...(reason.trim() ? { manualReason: reason.trim() } : {}),
          lines: lines.map((l) => ({ groupAccountId: ids.get(l.groupAccountCode.trim()), debit: Number(l.debit || 0), credit: Number(l.credit || 0) })),
        }),
      });
      await assertOk(res, 'Could not create the elimination - try again');
      setOpen(false); await onCreated();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not create the elimination - try again'));
    } finally { inFlight.current = false; setSaving(false); }
  }

  return {
    open, setOpen, start, submit, type, setType, description, setDescription, period, setPeriod, reason, setReason, needsReason,
    lines, setLines, error, saving,
  };
}
