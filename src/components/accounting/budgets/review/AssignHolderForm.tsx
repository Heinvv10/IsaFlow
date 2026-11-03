/**
 * Assign a budget holder (budgets P5-6, owner/admin): a draft version (year, then version), a
 * member who is a manager, admin or owner, the slice (company level, or one CC1, CC2 or BU member)
 * and an optional due date. The server re-checks every rule (decision 9a; migration 955).
 */
import { useEffect, useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { apiErrorMessage } from '@/lib/apiFetch';
import { DateField } from '@/components/ui/DateField';
import { yearOptionLabel, type BudgetYear } from '@/components/accounting/budgets/budgetClient';
import {
  assignHolder, fetchDraftVersions, fetchHolderCandidates, fetchSliceMembers, fetchYears, type MemberOption, type Option, type SliceReview,
} from './reviewClient';

type Kind = 'company' | 'cc1' | 'cc2' | 'bu';
const KIND_LABEL: Record<Kind, string> = { company: 'Company level', cc1: 'CC1', cc2: 'CC2', bu: 'Business unit' };
const FIELD = 'min-w-0 w-full rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)] px-3 py-1.5 text-sm text-[var(--ff-text-primary)]';

export function AssignHolderForm({ onAssigned }: { onAssigned: (s: SliceReview) => void }) {
  const id = useId();
  const [years, setYears] = useState<BudgetYear[]>([]);
  const [year, setYear] = useState<number | null>(null);
  const [versions, setVersions] = useState<Option[]>([]);
  const [versionId, setVersionId] = useState('');
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [userId, setUserId] = useState('');
  const [kind, setKind] = useState<Kind>('cc1');
  const [sliceOptions, setSliceOptions] = useState<Option[]>([]);
  const [sliceMember, setSliceMember] = useState('');
  const [due, setDue] = useState('');
  const [dueValid, setDueValid] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'ok'; text: string } | null>(null);
  const fail = (err: unknown, fallback: string) => setMessage({ tone: 'error', text: apiErrorMessage(err, fallback) });

  useEffect(() => {
    void fetchYears().then((ys) => { setYears(ys); setYear(ys[ys.length - 1]?.fiscalYear ?? null); }).catch((e: unknown) => fail(e, 'Could not load the financial years.'));
    void fetchHolderCandidates().then(setMembers).catch((e: unknown) => fail(e, 'Could not load the members.'));
  }, []);
  useEffect(() => {
    if (year === null) return undefined;
    let live = true;
    void fetchDraftVersions(year).then((vs) => { if (live) { setVersions(vs); setVersionId(vs[0]?.id ?? ''); } })
      .catch((e: unknown) => fail(e, 'Could not load the budget versions.'));
    return () => { live = false; };
  }, [year]);
  useEffect(() => {
    setSliceMember('');
    if (kind === 'company') { setSliceOptions([]); return undefined; }
    let live = true;
    void fetchSliceMembers(kind).then((o) => { if (live) setSliceOptions(o); }).catch((e: unknown) => fail(e, 'Could not load the slice members.'));
    return () => { live = false; };
  }, [kind]);

  const ready = versionId !== '' && userId !== '' && dueValid && (kind === 'company' || sliceMember !== '');
  const submit = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const slice = await assignHolder({
        versionId, userId, dueDate: due === '' ? null : due,
        cc1Id: kind === 'cc1' ? sliceMember : null, cc2Id: kind === 'cc2' ? sliceMember : null, buId: kind === 'bu' ? sliceMember : null,
      });
      setMessage({ tone: 'ok', text: `Assigned: ${slice.label}.` });
      onAssigned(slice);
    } catch (err) {
      fail(err, 'Could not assign the budget holder.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" onSubmit={(e) => { e.preventDefault(); if (ready) void submit(); }} data-testid="assign-holder-form">
      <label className="space-y-1 text-sm text-[var(--ff-text-secondary)]" htmlFor={`${id}-year`}>Financial year
        <select id={`${id}-year`} className={FIELD} value={year ?? ''} onChange={(e) => setYear(Number(e.target.value))}>
          {years.map((y) => <option key={y.fiscalYear} value={y.fiscalYear}>{yearOptionLabel(y)}</option>)}
        </select>
      </label>
      <label className="space-y-1 text-sm text-[var(--ff-text-secondary)]" htmlFor={`${id}-version`}>Draft version
        <select id={`${id}-version`} className={FIELD} value={versionId} onChange={(e) => setVersionId(e.target.value)}>
          {versions.length === 0 && <option value="">No draft version this year</option>}
          {versions.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
        </select>
      </label>
      <label className="space-y-1 text-sm text-[var(--ff-text-secondary)]" htmlFor={`${id}-member`}>Holder (manager or above)
        <select id={`${id}-member`} className={FIELD} value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">Pick a member…</option>
          {members.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      </label>
      <label className="space-y-1 text-sm text-[var(--ff-text-secondary)]" htmlFor={`${id}-kind`}>Slice
        <select id={`${id}-kind`} className={FIELD} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          {(Object.keys(KIND_LABEL) as Kind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
      </label>
      {kind !== 'company' && (
        <label className="space-y-1 text-sm text-[var(--ff-text-secondary)]" htmlFor={`${id}-slice`}>{KIND_LABEL[kind]}
          <select id={`${id}-slice`} className={FIELD} value={sliceMember} onChange={(e) => setSliceMember(e.target.value)}>
            <option value="">Pick one…</option>
            {sliceOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </label>
      )}
      <DateField label="Due date (optional)" value={due === '' ? null : due}
        onChange={(iso, v) => { setDueValid(v.valid); setDue(v.valid ? iso ?? '' : ''); }} />
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2 lg:col-span-3">
        <button type="submit" disabled={!ready || busy} data-testid="assign-holder-submit"
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}Assign holder
        </button>
        {message && (
          <p role={message.tone === 'error' ? 'alert' : 'status'}
            className={`text-sm ${message.tone === 'error' ? 'text-error-700 dark:text-error-400' : 'text-[var(--ff-text-secondary)]'}`}>{message.text}</p>
        )}
      </div>
    </form>
  );
}
