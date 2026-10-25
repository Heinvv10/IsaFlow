/**
 * Dismissible review banner for the payroll employees list: employees marked as
 * medical-aid main members who have no medical-aid deduction (D1). A main member
 * earns a monthly PAYE medical tax credit, and the flag used to default to true,
 * so these rows may be getting a credit they are not entitled to. Read-only: it
 * lists and links, it changes nothing.
 *
 * Dismissal is kept in localStorage, per browser and company. It holds the ids
 * that were dismissed, so an employee flagged later brings the banner back.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, X } from 'lucide-react';
import { apiFetch, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { useCompany } from '@/contexts/CompanyContext';
import { canWrite } from '@/lib/auth/writeRoles';

interface ReviewEmployee {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
}

const keyFor = (companyId: string | undefined) => `isaflow:payroll:medical-aid-review-dismissed:${companyId ?? 'none'}`;

function readDismissed(key: string): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch (err) {
    log.warn('medical-aid review: could not read the dismissed list', { error: err }, 'MedicalAidReviewBanner');
    return [];
  }
}

function writeDismissed(key: string, ids: string[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(ids));
  } catch (err) {
    log.warn('medical-aid review: could not save the dismissal', { error: err }, 'MedicalAidReviewBanner');
  }
}

export function MedicalAidReviewBanner() {
  const { companyRole, activeCompany } = useCompany();
  const mayWrite = canWrite(companyRole);
  const key = keyFor(activeCompany?.id);
  // The loaded list carries the key it was read for and is used only while that is the current key,
  // so the render right after a company switch cannot show the previous company's list (an effect-time
  // reset would still let that one render through). `currentKey` lets a late response for a company
  // we have since left be dropped instead of overwriting the current company's data.
  const currentKey = useRef(key);
  const [loaded, setLoaded] = useState<{ key: string; flagged: ReviewEmployee[] } | null>(null);
  // Dismissals made this session, by key; anything else is read from storage for the CURRENT key at
  // render, so going A -> B -> A can never reuse B's (or a stale) dismissed list.
  const [dismissedByKey, setDismissedByKey] = useState<Record<string, string[]>>({});

  const load = useCallback(async (forKey: string) => {
    let list: ReviewEmployee[] = [];
    try {
      const res = await apiFetch('/api/payroll/employees/medical-aid-review');
      await assertOk(res, 'Could not load the medical-aid review');
      const json = await res.json();
      const employees = (json.data ?? json)?.employees;
      if (Array.isArray(employees)) list = employees as ReviewEmployee[];
    } catch (err) {
      // The banner is advisory: a failed load shows nothing rather than an error on the list page.
      log.warn('medical-aid review: could not load', { error: err }, 'MedicalAidReviewBanner');
    }
    if (currentKey.current !== forKey) return;
    setLoaded({ key: forKey, flagged: list });
  }, []);

  useEffect(() => {
    currentKey.current = key;
    if (!mayWrite) return;
    void load(key);
  }, [mayWrite, key, load]);

  const flagged = loaded?.key === key ? loaded.flagged : [];
  if (!mayWrite || flagged.length === 0) return null;
  // Read only once there is something to show: a viewer or an empty list never touches storage.
  const dismissed = dismissedByKey[key] ?? readDismissed(key);
  if (flagged.every(e => dismissed.includes(e.id))) return null;

  const dismiss = () => {
    const ids = flagged.map(e => e.id);
    writeDismissed(key, ids);
    setDismissedByKey(prev => ({ ...prev, [key]: ids }));
  };

  return (
    <div role="status" data-testid="medical-aid-review-banner"
      className="mb-6 px-4 py-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-sm text-[var(--ff-text-primary)]">
      <div className="flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 text-amber-400 mt-0.5 shrink-0" />
        <div className="flex-1">
          <p className="font-medium">
            {flagged.length} employee{flagged.length !== 1 ? 's are' : ' is'} marked as medical-aid main member{flagged.length !== 1 ? 's' : ''} but
            {flagged.length !== 1 ? ' have' : ' has'} no medical-aid deduction — review {flagged.length !== 1 ? 'them' : 'it'}
          </p>
          <p className="text-[var(--ff-text-secondary)] mt-1">
            A main member gets a monthly medical tax credit in PAYE. Untick the flag on the employee if they have no medical aid.
          </p>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {flagged.map(e => (
              <li key={e.id}>
                <Link href={`/payroll/employees/${e.id}`} className="text-teal-400 hover:text-teal-300">
                  {e.firstName} {e.lastName} ({e.employeeNumber})
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <button type="button" onClick={dismiss} aria-label="Dismiss medical-aid review"
          className="p-1 rounded hover:bg-[var(--ff-bg-tertiary)]">
          <X className="h-4 w-4 text-[var(--ff-text-secondary)]" />
        </button>
      </div>
    </div>
  );
}
