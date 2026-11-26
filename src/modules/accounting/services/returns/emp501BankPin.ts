/**
 * Which bank rows an EMP501 filing file carried (wave 7 EA2, Hein's ruling 25: the accounts are read live at download
 * and never stored; coordinator decision on the PII breaker's round 3: ids, never values).
 *
 *  - Every download of a version finalised since EA2 records, on its audit row, the bank row each certificate employee's
 *    fields came from (`bankRows`: employee id -> row id, null = no account, 3240 = 0) beside the served sha256.
 *  - Marking the version filed pins the rows of the LATEST download: it refuses (409 BANK_DETAILS_CHANGED) unless they
 *    are still each employee's active row, which the bank table says (a bound from outside audit_log), so what is filed
 *    is what was downloaded; the filed audit row carries the pin and that download's served sha256.
 *  - A filed version is re-served from exactly the pinned rows (insert-only, never rewritten), so its re-download is the
 *    file submitted, byte for byte. The pin is read from the filed audit row bound to the version by its own filed_at
 *    (the version row's column; both are now() of the filing transaction), and each pinned row must be that employee's
 *    in this company (getEmployeeBankDetailsByRowId) or nothing is served.
 *
 * A bank change committed after the download, or an open transaction adding one, cannot change a filed file: filing
 * compares ids the table holds when it commits, and a re-download reads the pinned rows by id.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { activeBankRowIds } from '@/modules/accounting/services/payroll/payrollBankDetailsService';
import { ReturnRefusal, type ReturnVersion } from './returnVersionTypes';

export type BankPin = Map<string, string | null>;

export const BANK_DETAILS_CHANGED = 'BANK_DETAILS_CHANGED';

/** A pin as an audit metadata value (audit metadata holds strings). */
export const pinText = (pin: BankPin): string => JSON.stringify(Object.fromEntries([...pin.entries()].sort()));

function pinOf(text: unknown): BankPin | null {
  if (typeof text !== 'string') return null;
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const pin: BankPin = new Map();
  for (const [employee, row] of Object.entries(parsed)) {
    if (row !== null && typeof row !== 'string') return null;
    pin.set(employee, row);
  }
  return pin;
}

const carriesBank = (v: Pick<ReturnVersion, 'formType' | 'figures'>) =>
  v.formType === 'EMP501' && (v.figures as { bankOverlay?: unknown }).bankOverlay === 1;

/**
 * For markReturnFiled, judged before its first write: the metadata the filed audit row carries (the pin and the served
 * sha256 of the download it pins), or {} for a version that carries no bank fields (not EMP501, or finalised before EA2).
 * Refuses 409 when there is no download with its rows recorded, or a row changed since the latest one.
 */
export async function emp501FilingPin(companyId: string, v: ReturnVersion): Promise<Record<string, string>> {
  if (!carriesBank(v)) return {};
  const latest = (await sql`
    SELECT changes FROM audit_log
    WHERE company_id = ${companyId}::uuid AND entity_type = 'tax_return_version' AND entity_id = ${v.id}::uuid
      AND action = 'export' AND changes -> 'metadata' ->> 'file' = 'emp501_easyfile'
    ORDER BY created_at DESC, id DESC LIMIT 1
  `) as DbRow[];
  const meta = (latest[0]?.changes as { metadata?: Record<string, unknown> } | undefined)?.metadata;
  const pin = pinOf(meta?.bankRows);
  if (!pin || typeof meta?.servedSha256 !== 'string') {
    throw new ReturnRefusal(409, 'Download the filing file (as an owner or admin) and capture it on e@syFile before marking it filed.',
      BANK_DETAILS_CHANGED);
  }
  const now = await activeBankRowIds(companyId, [...pin.keys()]);
  if ([...pin.entries()].some(([employee, row]) => now.get(employee) !== row)) {
    throw new ReturnRefusal(409, 'Bank details changed since you downloaded the filing file: download it again, capture that '
      + 'file on e@syFile, then mark it filed.', BANK_DETAILS_CHANGED);
  }
  return { bankRows: pinText(pin), servedSha256: meta.servedSha256 };
}

/** A filed version's pinned rows, from the filed audit row bound by the version's filed_at; null when it has none. */
export async function filedBankPin(companyId: string, v: Pick<ReturnVersion, 'id'>): Promise<BankPin | null> {
  // filed_at read in SQL, to the microsecond (a JS Date keeps milliseconds only).
  const rows = (await sql`
    SELECT a.changes FROM audit_log a
    JOIN tax_return_versions t ON t.id = a.entity_id AND t.company_id = a.company_id
    WHERE a.company_id = ${companyId}::uuid AND a.entity_type = 'tax_return_version' AND a.entity_id = ${v.id}::uuid
      AND t.status = 'filed' AND a.action = 'update' AND a.created_at = t.filed_at
      AND (a.changes -> 'metadata' ->> 'bankRows') IS NOT NULL
  `) as DbRow[];
  if (rows.length !== 1) return null;
  return pinOf((rows[0]!.changes as { metadata?: Record<string, unknown> }).metadata?.bankRows);
}
