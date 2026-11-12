/** What the lifecycle bar shows and offers, as pure functions of the versions, the role and Login-as (wave 5 L2). */
import { canWrite } from '@/lib/auth/writeRoles';
import type { ReturnForm, ReturnVersionView } from './returnLifecycleClient';

/**
 * File and amend: owner/admin (the routes' withWriteAccess admits owner/admin/manager, the services owner/admin/super_admin;
 * only owner and admin pass both). The server refuses everyone else whatever this offers.
 */
const ACT_ROLES: readonly string[] = ['owner', 'admin'];

export interface LifecycleStep {
  key: string;
  versionNo: number;
  label: string;
  /** User id of whoever took the step. */
  by: string;
  at: string;
  detail: string | null;
  kind: 'finalised' | 'filed' | 'amended';
}

/** Every step of the chain, oldest first: vN finalised, filed (with its reference), amended (with the reason). */
export function lifecycleSteps(versions: ReturnVersionView[]): LifecycleStep[] {
  return [...versions].sort((a, b) => a.versionNo - b.versionNo).flatMap((v) => {
    const steps: LifecycleStep[] = [
      { key: `${v.id}-f`, versionNo: v.versionNo, label: `v${v.versionNo} finalised`, by: v.finalisedBy, at: v.finalisedAt, detail: null, kind: 'finalised' },
    ];
    if (v.filedBy && v.filedAt) {
      steps.push({ key: `${v.id}-s`, versionNo: v.versionNo, label: `v${v.versionNo} filed`, by: v.filedBy, at: v.filedAt, detail: v.filedReference, kind: 'filed' });
    }
    if (v.amendedBy && v.amendedAt) {
      steps.push({ key: `${v.id}-a`, versionNo: v.versionNo, label: `v${v.versionNo} amended`, by: v.amendedBy, at: v.amendedAt, detail: v.amendReason, kind: 'amended' });
    }
    return steps;
  });
}

/** The one non-superseded version, if any. */
export function liveVersion(versions: ReturnVersionView[]): ReturnVersionView | null {
  return versions.find((v) => v.status !== 'superseded') ?? null;
}

export interface LifecycleActions {
  finalise: boolean;
  file: boolean;
  amend: boolean;
  /** Why an action the return would otherwise take is not offered. */
  note: string | null;
}

export function availableActions(
  live: ReturnVersionView | null, role: string | null, impersonating: boolean,
): LifecycleActions {
  if (impersonating) {
    return { finalise: false, file: false, amend: false,
      note: 'Finalising, filing and amending a return are refused while you are logged in as another user.' };
  }
  const acts = ACT_ROLES.includes(role ?? '');
  const finalise = live === null && canWrite(role);
  const file = live?.status === 'finalised' && acts;
  const amend = live !== null && acts;
  let note: string | null = null;
  if (live === null && !canWrite(role)) note = 'You have read-only access to this company, so you cannot finalise the return.';
  else if (live !== null && !acts) note = 'Only an owner or admin can file or amend a return.';
  return { finalise, file, amend, note };
}

export interface FigureRow { label: string; value: number; money: boolean }

const FIELDS: Record<ReturnForm, Array<[string, string, boolean]>> = {
  VAT201: [['outputTax', 'Output tax', true], ['inputTax', 'Input tax', true], ['netVat', 'Net VAT', true]],
  EMP201: [
    ['employeeCount', 'Employees', false], ['totalTaxableRemuneration', 'Taxable remuneration', true],
    ['totalPAYE', 'PAYE', true], ['totalETI', 'ETI', true], ['payePayable', 'PAYE payable', true],
    ['totalUIF', 'UIF', true], ['totalSDL', 'SDL', true],
  ],
};

/** The recorded figures a person reads, in form order (VAT201: output, input, net; EMP201: the liability lines). */
export function figureRows(form: ReturnForm, figures: Record<string, unknown>): FigureRow[] {
  return FIELDS[form].map(([key, label, money]) => ({ label, value: Number(figures[key] ?? 0) || 0, money }));
}

/** A drift field's name as a label. */
export function fieldLabel(form: ReturnForm, name: string): string {
  return FIELDS[form].find(([key]) => key === name)?.[1] ?? name;
}

/** Login-as sets this cookie (ImpersonationBanner reads the same one). */
export function isImpersonating(): boolean {
  if (typeof document === 'undefined') return false;
  return /(?:^|; )is_impersonating=1(?:;|$)/.test(document.cookie);
}
