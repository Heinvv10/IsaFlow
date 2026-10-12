/**
 * The canonical documents whose SHA-256 is a snapshot's or a check run's
 * canonical hash. Built from the same values at take time and on
 * verification (from the stored rows), so the two can only agree when nothing
 * was changed. Arrays are ordered here, never by the caller.
 */
import { canonicalJson, sha256Hex } from './canonical';
import type { CheckResult } from './checks/checkTypes';
import type { CanonicalRow } from './snapshotRows';

/** 2: journal and line rows freeze the VAT / intercompany / evidence columns too (breaker r1 F2). */
export const DOCUMENT_VERSION = 2;
export const SNAPSHOT_CAVEAT = 'Current values of records dated on or before the cutoff, as at taken_at — not the historical database state.';

export interface CheckRunHeader {
  id: string; companyId: string; asAt: string; periodStart: string; takenAt: string; takenBy: string;
  purpose: 'standalone' | 'snapshot'; totals: Record<string, unknown>;
}

const byKey = <T>(key: (t: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

export function checkRunHash(h: CheckRunHeader, results: CheckResult[]): string {
  return sha256Hex(canonicalJson({
    kind: 'audit_check_run', version: DOCUMENT_VERSION, id: h.id, company_id: h.companyId, as_at: h.asAt,
    period_start: h.periodStart, taken_at: h.takenAt, taken_by: h.takenBy, purpose: h.purpose, totals: h.totals,
    results: [...results].sort(byKey((r) => r.checkId)).map((r) => ({
      check_id: r.checkId, check_version: r.version, family: r.family, status: r.status, population: r.population,
      finding_count: r.findingCount, findings: r.findings,
    })),
  }));
}

export interface SnapshotHeader {
  id: string; companyId: string; cutoff: string; takenAt: string; takenBy: string; trigger: string; caveat: string;
  masterDataHighWater: string | null; totals: Record<string, unknown>;
  checkRun: { id: string; canonicalHash: string } | null;
}

export function snapshotHash(h: SnapshotHeader, tb: { accountId: string; row: CanonicalRow }[],
  journals: { journalId: string; materialHash: string }[], lines: { lineId: string; materialHash: string }[]): string {
  return sha256Hex(canonicalJson({
    kind: 'audit_snapshot', version: DOCUMENT_VERSION, id: h.id, company_id: h.companyId, cutoff: h.cutoff,
    taken_at: h.takenAt, taken_by: h.takenBy, trigger: h.trigger, caveat: h.caveat,
    master_data_high_water: h.masterDataHighWater, totals: h.totals,
    check_run: h.checkRun ? { id: h.checkRun.id, canonical_hash: h.checkRun.canonicalHash } : null,
    trial_balance: [...tb].sort(byKey((t) => t.accountId)).map((t) => t.row),
    journals: [...journals].sort(byKey((j) => j.journalId)).map((j) => [j.journalId, j.materialHash]),
    lines: [...lines].sort(byKey((l) => l.lineId)).map((l) => [l.lineId, l.materialHash]),
  }));
}

/**
 * What a snapshot froze of the ledger, in one hash: every journal's and line's material hash and the trial balance.
 * Sealed in the snapshot's totals; an automatic snapshot whose ledger reads the same is recorded as 'unchanged'.
 */
export function ledgerFingerprint(tb: { accountId: string; row: CanonicalRow }[], journals: { journalId: string; materialHash: string }[],
  lines: { lineId: string; materialHash: string }[]): string {
  return sha256Hex(canonicalJson({
    tb: [...tb].sort(byKey((t) => t.accountId)).map((t) => t.row),
    journals: [...journals].sort(byKey((j) => j.journalId)).map((j) => j.materialHash),
    lines: [...lines].sort(byKey((l) => l.lineId)).map((l) => l.materialHash),
  }));
}

/** Exact decimal sum of two-place amounts (no float drift), as a two-place string. */
export function sumMoney(values: (string | null | undefined)[]): string {
  let cents = 0n;
  for (const v of values) {
    if (!v) continue;
    const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(v);
    if (!m) throw new Error(`sumMoney: not a decimal amount: ${v}`);
    const c = BigInt(m[2]!) * 100n + BigInt((m[3] ?? '').padEnd(2, '0'));
    cents += m[1] ? -c : c;
  }
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  return `${neg ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}
