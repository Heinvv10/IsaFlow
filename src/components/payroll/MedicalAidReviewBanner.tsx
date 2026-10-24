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
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, X } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
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
  const [flagged, setFlagged] = useState<ReviewEmployee[]>([]);
  const [dismissed, setDismissed] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/payroll/employees/medical-aid-review');
      if (!res.ok) throw new Error(`medical-aid review answered ${res.status}`);
      const json = await res.json();
      const list = (json.data ?? json)?.employees;
      setFlagged(Array.isArray(list) ? (list as ReviewEmployee[]) : []);
    } catch (err) {
      // The banner is advisory: a failed load shows nothing rather than an error on the list page.
      log.warn('medical-aid review: could not load', { error: err }, 'MedicalAidReviewBanner');
      setFlagged([]);
    }
  }, []);

  useEffect(() => {
    if (!mayWrite) return;
    setDismissed(readDismissed(key));
    void load();
  }, [mayWrite, key, load]);

  if (!mayWrite || flagged.length === 0 || flagged.every(e => dismissed.includes(e.id))) return null;

  const dismiss = () => {
    const ids = flagged.map(e => e.id);
    writeDismissed(key, ids);
    setDismissed(ids);
  };

  return (
    <div role="alert" data-testid="medical-aid-review-banner"
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
