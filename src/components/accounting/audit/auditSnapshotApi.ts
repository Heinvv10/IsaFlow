/**
 * Client side of the audit-snapshot screens (forensic-controls step 4): the
 * shapes the routes return and one fetch helper that unwraps `data` and turns
 * a 4xx into an Error carrying the server's message.
 */
import { apiFetch, assertOk } from '@/lib/apiFetch';

export type Row = Record<string, string | null>;

export interface SnapshotSummary {
  id: string; cutoff: string; takenAt: string; takenBy: string; takenByName: string | null; channel: string; trigger: string;
  status: 'sealed' | 'failed' | 'unchanged'; failureReason: string | null; canonicalHash: string | null; keyId: string | null;
  seq: number | null; sameAsSnapshotId: string | null;
  totals: Record<string, unknown>; caveat: string; checkRunId: string | null;
}

export interface Finding { key: string; refs: string[]; detail: Record<string, string | number | boolean | null> }
export interface CheckResult {
  checkId: string; version: number; family: string; status: 'pass' | 'fail' | 'unknown'; population: number | null;
  findingCount: number; findings: Finding[];
}
export interface CheckRun { id: string; asAt: string; periodStart: string; takenAt: string; canonicalHash: string; results: CheckResult[] }

export interface Verification {
  status: 'valid' | 'invalid' | 'not_sealed' | 'unchanged'; recomputedHash: string | null; canonicalHash: string | null;
  rowsChecked: { accounts: number; journals: number; lines: number }; rowMismatchCount: number;
}

export interface FieldDiff { field: string; before: string | null; after: string | null }
export interface JournalItem {
  id: string; entryNumber: string | null; entryDate: string | null; createdBy: string | null; createdAt: string | null;
  postedBy: string | null; postedAt: string | null; reversedAt: string | null; fields: FieldDiff[];
  lines: { added: number; removed: number; changed: { id: string; fields: FieldDiff[] }[] };
  recordedAfter?: boolean;
}
export interface Comparison {
  base: { id: string; cutoff: string; takenAt: string };
  against: { kind: 'live' | 'snapshot'; id: string | null; takenAt: string };
  counts: Record<string, number>;
  verification: { base: string; against: string | null };
  backdated: JournalItem[]; changed: JournalItem[]; removed: (JournalItem & { statusNow: string | null })[];
  reversedAfter: string[];
  notCompared?: { journals: string[]; lines: string[] };
  tb: { accountId: string; code: string | null; name: string | null; before: string; after: string; delta: string }[];
  names: Record<string, string>;
  masterData: { since: string; total: number; truncated: boolean; byType: Record<string, number>;
    items: { type: string; entityId: string; label: string | null; op: string; recordedAt: string; actorName: string | null; actor: string }[] } | null;
}

export async function getData<T>(url: string, fallback: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(url, init);
  await assertOk(res, fallback);
  return ((await res.json()) as { data: T }).data;
}

export const fmtAt = (s: string | null | undefined): string => {
  if (!s) return '—';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' });
};

export const fmtAmount = (s: string | null | undefined): string => {
  const n = Number(s ?? 0);
  return Number.isFinite(n) ? n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(s);
};

export const TRIGGER_LABEL: Record<string, string> = {
  manual: 'Taken by hand', period_close: 'Period closed', vat_lock: 'VAT period locked', year_close: 'Year closed',
};
