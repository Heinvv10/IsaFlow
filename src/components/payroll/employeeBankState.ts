import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { nextRunMonth, type BankState } from './employeeReadiness';

/**
 * Whether bank details are on file. Always the masked view: a full read writes an audit row, and readiness
 * never needs the number. A failed or refused read is 'unknown', which readiness does not call ready.
 */
export async function loadBankState(employeeId: string): Promise<BankState> {
  try {
    const res = await apiFetch(`/api/payroll/employees/${employeeId}/bank-details?view=masked`);
    if (!res.ok) return 'unknown';
    const json = (await res.json()) as { data?: unknown };
    return json.data ? 'on-file' : 'none';
  } catch (err) {
    log.warn('bank state read failed', { error: err }, 'employeeBankState');
    return 'unknown';
  }
}

/** The month of the next pay run, from the company's run list. A failed read falls back to the current month. */
export async function loadRunMonth(): Promise<string> {
  try {
    const res = await apiFetch('/api/payroll/runs');
    if (!res.ok) return nextRunMonth([]);
    const json = (await res.json()) as { data?: Array<{ periodYear: number; periodMonth: number; status: string }> };
    return nextRunMonth(Array.isArray(json.data) ? json.data : []);
  } catch (err) {
    log.warn('run month read failed', { error: err }, 'employeeBankState');
    return nextRunMonth([]);
  }
}

/**
 * Whether the employee already has a line on a final run (so the next run is not their first). A failed or
 * malformed read is null: the copy then says "next", never "first".
 */
export async function loadHasFinalRun(employeeId: string): Promise<boolean | null> {
  try {
    const res = await apiFetch(`/api/payroll/employees/${employeeId}/has-final-run`);
    if (!res.ok) {
      log.warn('final-run read refused', { status: res.status }, 'employeeBankState');
      return null;
    }
    const json = (await res.json()) as { data?: { hasFinalRun?: unknown } };
    return typeof json.data?.hasFinalRun === 'boolean' ? json.data.hasFinalRun : null;
  } catch (err) {
    log.warn('final-run read failed', { error: err }, 'employeeBankState');
    return null;
  }
}

/** `runMonth` null = the read failed: the caller keeps the month it had, or falls back to the current one. */
export interface ReadinessState { bank: BankState; runMonth: string | null; hasFinalRun: boolean | null }

async function fetchReadiness(employeeId: string): Promise<ReadinessState> {
  const failed: ReadinessState = { bank: 'unknown', runMonth: null, hasFinalRun: null };
  try {
    const res = await apiFetch(`/api/payroll/employees/${employeeId}/readiness`);
    if (!res.ok) {
      log.warn('readiness read refused', { status: res.status }, 'employeeBankState');
      return res.status === 429 ? { ...failed, bank: 'limited' } : failed;
    }
    const d = ((await res.json()) as { data?: { bank?: unknown; runs?: unknown; hasFinalRun?: unknown } }).data;
    if (d?.bank !== 'on-file' && d?.bank !== 'none') return failed;
    const runs = Array.isArray(d.runs) ? (d.runs as Array<{ periodYear: number; periodMonth: number; status: string }>) : [];
    return { bank: d.bank, runMonth: nextRunMonth(runs), hasFinalRun: typeof d.hasFinalRun === 'boolean' ? d.hasFinalRun : null };
  } catch (err) {
    log.warn('readiness read failed', { error: err }, 'employeeBankState');
    return failed;
  }
}

/** A read this recent, for the same employee and refresh key, is the answer: strict mode's second mount and the page's early start both land here. */
const SHARE_MS = 5000;
const reads = new Map<string, { at: number; read: Promise<ReadinessState> }>();

/**
 * The card's three facts in one read (wave 6 UXR). A failed or malformed read is the same fallback each separate
 * read had: bank 'unknown' (never ready), no month (the card keeps its last, else the current one), and a final-run answer of null ("next", never "first").
 * `key` changes when the bank details change, which is the one reason to read again inside the window. Wave 7 RD: reads
 * of one employee under one key are shared for a few seconds, so a remount (strict mode throws the first answer away)
 * does not queue a second request behind the page's other calls, and the page can start the read before the card exists.
 */
export function loadReadiness(employeeId: string, key = 0): Promise<ReadinessState> {
  const id = `${employeeId}:${key}`;
  const now = Date.now();
  const held = reads.get(id);
  if (held && now - held.at < SHARE_MS) return held.read;
  const read = fetchReadiness(employeeId);
  reads.set(id, { at: now, read });
  // A failed read is shared while it is in flight only: asking again after it answered must ask the server.
  void read.then(r => { if (r.bank === 'unknown' || r.bank === 'limited') reads.delete(id); });
  if (reads.size > 50) for (const [k, v] of reads) if (now - v.at >= SHARE_MS) reads.delete(k);
  return read;
}

/** Start the read as soon as the page knows the employee, before the profile it waits on has loaded. */
export function prefetchReadiness(employeeId: string, key = 0): void {
  void loadReadiness(employeeId, key);
}

/** Forget every shared read (a test starts from none). */
export function clearReadinessReads(): void {
  reads.clear();
}
